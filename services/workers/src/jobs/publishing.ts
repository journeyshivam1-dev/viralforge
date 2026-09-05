/**
 * Publishing Worker
 * Publishes validated content to Meta platforms (Instagram/Facebook)
 */

import { Job } from 'bullmq';
import { supabase, storage } from '@viralforge/supabase';
import { createInstagramPublisher, createFacebookPublisher } from '@viralforge/domain';

export async function publishingWorker(job: Job) {
  const { contentItemId } = job.data;

  console.log(`[Publishing] Starting publishing for content ${contentItemId}`);

  try {
    // Check global kill switch
    if (process.env.PUBLISHING_DISABLED === 'true') {
      console.warn('[Publishing] PUBLISHING_DISABLED is true, skipping');
      return { success: false, reason: 'kill_switch_engaged' };
    }

    await job.updateProgress(10);

    // Get content item
    const { data: contentItem, error: fetchError } = await supabase
      .from('content_items')
      .select('*, niche_accounts(*), niche_profiles(*)')
      .eq('id', contentItemId)
      .single();

    if (fetchError || !contentItem) {
      throw new Error(`Content item not found: ${contentItemId}`);
    }

    if (contentItem.status !== 'scheduled' && contentItem.status !== 'validated') {
      throw new Error(`Cannot publish content in status: ${contentItem.status}`);
    }

    await job.updateProgress(20);

    // Update status to publishing
    await supabase
      .from('content_items')
      .update({ status: 'publishing' })
      .eq('id', contentItemId);

    // Get the account
    const account = contentItem.niche_accounts;
    if (!account || account.status !== 'active') {
      throw new Error('Account is not active for publishing');
    }

    await job.updateProgress(30);

    // Decrypt access token (in production, use KMS)
    const accessToken = account.encrypted_access_token; // TODO: decrypt

    // Publish to platform
    let publishResult;
    if (account.platform === 'instagram') {
      publishResult = await publishToInstagram(contentItem, account, accessToken);
    } else if (account.platform === 'facebook') {
      publishResult = await publishToFacebook(contentItem, account, accessToken);
    } else {
      throw new Error(`Unsupported platform: ${account.platform}`);
    }

    await job.updateProgress(80);

    // Update content item with publication details
    await supabase
      .from('content_items')
      .update({
        status: 'published',
        published_at: new Date().toISOString(),
        meta_post_id: publishResult.postId,
        insights_snapshot: publishResult.metadata,
      })
      .eq('id', contentItemId);

    await job.updateProgress(100);

    // Log audit event
    await logAuditEvent(contentItemId, 'content.published', {
      platform: account.platform,
      postId: publishResult.postId,
    });

    console.log(`[Publishing] Published to ${account.platform}: ${publishResult.postId}`);

    return {
      success: true,
      contentItemId,
      platform: account.platform,
      postId: publishResult.postId,
    };
  } catch (error) {
    console.error(`[Publishing] Error for content ${contentItemId}:`, error);

    await supabase
      .from('content_items')
      .update({
        status: 'failed',
        validation_errors: [error instanceof Error ? error.message : String(error)],
      })
      .eq('id', contentItemId);

    throw error;
  }
}

/**
 * Publish to Instagram via Graph API
 */
async function publishToInstagram(
  contentItem: any,
  account: any,
  accessToken: string
): Promise<{ postId: string; metadata: any }> {
  const publisher = createInstagramPublisher(
    process.env.META_APP_ID || '',
    process.env.META_APP_SECRET || '',
    accessToken
  );

  // Get the media URL
  const mediaUrl = contentItem.rendering_manifest?.finalMediaUrl;
  if (!mediaUrl) {
    throw new Error('No media URL found');
  }

  // Get public URL (signed URL for local Minio)
  const { data: signedUrlData } = await storage
    .from('viralforge-content')
    .createSignedUrl(mediaUrl, 3600);

  if (!signedUrlData?.signedUrl) {
    throw new Error('Failed to create signed URL for media');
  }

  // Prepare caption
  const caption = `${contentItem.hook_variation_a}\n\n${contentItem.script_body || ''}\n\n#${contentItem.niche_id} #reels #trending`;

  // Publish Reel
  const result = await publisher.publishReel({
    accountId: account.account_id,
    videoUrl: signedUrlData.signedUrl,
    caption,
    aiDisclosureRequired: contentItem.ai_disclosure_required,
  });

  return {
    postId: result.mediaId,
    metadata: {
      ...result.metadata,
      publishedAt: new Date().toISOString(),
    },
  };
}

/**
 * Publish to Facebook via Graph API
 */
async function publishToFacebook(
  contentItem: any,
  account: any,
  accessToken: string
): Promise<{ postId: string; metadata: any }> {
  const publisher = createFacebookPublisher(
    process.env.META_APP_ID || '',
    process.env.META_APP_SECRET || '',
    accessToken
  );

  // Get the media URL
  const mediaUrl = contentItem.rendering_manifest?.finalMediaUrl;
  if (!mediaUrl) {
    throw new Error('No media URL found');
  }

  const { data: signedUrlData } = await storage
    .from('viralforge-content')
    .createSignedUrl(mediaUrl, 3600);

  if (!signedUrlData?.signedUrl) {
    throw new Error('Failed to create signed URL for media');
  }

  // Publish to Facebook Page as Reel
  const result = await publisher.publishReel({
    pageId: account.account_id,
    videoUrl: signedUrlData.signedUrl,
    title: contentItem.hook_variation_a,
    description: contentItem.script_body || '',
  });

  return {
    postId: result.postId,
    metadata: {
      ...result.metadata,
      publishedAt: new Date().toISOString(),
    },
  };
}

async function logAuditEvent(
  contentItemId: string,
  action: string,
  metadata: Record<string, any>
) {
  await supabase.from('audit_logs').insert({
    content_item_id: contentItemId,
    action,
    actor: 'system',
    actor_type: 'system',
    metadata,
  });
}

export { publishingWorker };