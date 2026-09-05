/**
 * Media Worker
 * Handles image/video generation via Omniroute
 */

import { Job } from 'bullmq';
import { supabase, storage } from '@viralforge/supabase';
import { createOmnirouteAdapter, NicheId } from '@viralforge/domain';

const omnirouteAdapter = createOmnirouteAdapter(
  process.env.OMNIROUTE_BASE_URL || 'http://localhost:3001',
  process.env.OMNIROUTE_API_KEY || '',
  process.env.OMNIROUTE_WEBHOOK_SECRET || '',
  parseInt(process.env.OMNIROUTE_TIMEOUT_MS || '300000')
);

export async function mediaWorker(job: Job) {
  const { contentItemId, nicheId } = job.data;

  console.log(`[Media] Starting media generation for content ${contentItemId}`);

  try {
    await job.updateProgress(10);

    // Get content item
    const { data: contentItem, error: fetchError } = await supabase
      .from('content_items')
      .select('*')
      .eq('id', contentItemId)
      .single();

    if (fetchError || !contentItem) {
      throw new Error(`Content item not found: ${contentItemId}`);
    }

    await job.updateProgress(20);

    // Determine media type and generate
    let mediaUrl: string;
    let mediaType: string;

    if (contentItem.media_type === 'video_reel') {
      // Generate video
      const result = await generateVideo(contentItem, nicheId as NicheId);
      mediaUrl = result.url;
      mediaType = 'video/mp4';
    } else if (contentItem.media_type === 'image_carousel') {
      // Generate carousel of images
      const result = await generateCarousel(contentItem, nicheId as NicheId);
      mediaUrl = result.url;
      mediaType = 'image/jpeg';
    } else {
      // Single image
      const result = await generateSingleImage(contentItem, nicheId as NicheId);
      mediaUrl = result.url;
      mediaType = 'image/jpeg';
    }

    await job.updateProgress(70);

    // Upload to S3/Minio
    const fileBuffer = await downloadMedia(mediaUrl);
    const fileName = `${nicheId}/${contentItemId}/media-${Date.now()}.${mediaType === 'video/mp4' ? 'mp4' : 'jpg'}`;

    const { data: uploadData, error: uploadError } = await storage
      .from('viralforge-content')
      .upload(fileName, fileBuffer, {
        contentType: mediaType,
        cacheControl: '31536000',
      });

    if (uploadError) {
      throw new Error(`Failed to upload media: ${uploadError.message}`);
    }

    await job.updateProgress(90);

    // Update content item with media URL
    const { error: updateError } = await supabase
      .from('content_items')
      .update({
        status: 'rendering',
        ai_generation_metadata: {
          ...contentItem.ai_generation_metadata,
          mediaUrl: uploadData.path,
          mediaType,
          generatedAt: new Date().toISOString(),
        },
      })
      .eq('id', contentItemId);

    if (updateError) {
      throw new Error(`Failed to update content item: ${updateError.message}`);
    }

    await job.updateProgress(100);

    // Log audit event
    await logAuditEvent(contentItemId, 'media.generated', {
      nicheId,
      mediaType,
      filePath: uploadData.path,
    });

    console.log(`[Media] Media generation completed for content ${contentItemId}`);

    return {
      success: true,
      contentItemId,
      mediaUrl: uploadData.path,
      mediaType,
    };
  } catch (error) {
    console.error(`[Media] Error for content ${contentItemId}:`, error);

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
 * Generate video using Omniroute
 */
async function generateVideo(contentItem: any, nicheId: NicheId): Promise<{ url: string }> {
  const prompt = buildVideoPrompt(contentItem, nicheId);

  const response = await omnirouteAdapter.generateContent({
    type: 'video',
    prompt,
    niche: nicheId,
    parameters: {
      duration: 30, // seconds
      aspectRatio: '9:16', // vertical
      quality: 'high',
    },
    callbackUrl: process.env.API_URL ? `${process.env.API_URL}/webhooks/omniroute` : undefined,
  });

  if (response.status === 'failed') {
    throw new Error(`Video generation failed: ${response.error}`);
  }

  return { url: response.result?.videoUrl || '' };
}

/**
 * Generate carousel of images
 */
async function generateCarousel(contentItem: any, nicheId: NicheId): Promise<{ url: string }> {
  // Generate 5-7 images for the carousel
  const imagePrompts = buildImagePrompts(contentItem, nicheId, 5);
  const imageUrls: string[] = [];

  for (const prompt of imagePrompts) {
    const response = await omnirouteAdapter.generateContent({
      type: 'image',
      prompt,
      niche: nicheId,
      parameters: {
        aspectRatio: '1:1',
        quality: 'high',
      },
    });

    if (response.status === 'completed' && response.result?.imageUrl) {
      imageUrls.push(response.result.imageUrl);
    }
  }

  // For carousel, return the first image URL (others are stored separately)
  return { url: imageUrls[0] || '' };
}

/**
 * Generate single image
 */
async function generateSingleImage(contentItem: any, nicheId: NicheId): Promise<{ url: string }> {
  const prompt = buildImagePrompts(contentItem, nicheId, 1)[0];

  const response = await omnirouteAdapter.generateContent({
    type: 'image',
    prompt,
    niche: nicheId,
    parameters: {
      aspectRatio: '1:1',
      quality: 'high',
    },
  });

  return { url: response.result?.imageUrl || '' };
}

/**
 * Build video prompt from content item
 */
function buildVideoPrompt(contentItem: any, nicheId: NicheId): string {
  const basePrompts: Record<NicheId, string> = {
    food: `A vertical 9:16 video of ${contentItem.data_input_payload?.dish || 'Indian food'}.
${contentItem.data_input_payload?.region || 'Indian'} style home cooking.
Steps: ${contentItem.script_body || 'Step-by-step cooking'}.
Style: Warm, appetizing, family-friendly.
High quality food photography and cinematic movement.`,

    health: `A vertical 9:16 video showing transformation of ${contentItem.data_input_payload?.originalDish} to ${contentItem.data_input_payload?.transformedDish}.
Visual contrast: unhealthy vs healthy.
${contentItem.script_body || 'Comparison of two versions'}.
Style: Educational, motivational, vibrant.`,

    tech: `A vertical 9:16 video demonstrating ${contentItem.data_input_payload?.toolName || 'AI tool'}.
Feature: ${contentItem.data_input_payload?.feature || 'productivity'}.
${contentItem.script_body || 'Screen recording and demonstration'}.
Style: Modern, tech-savvy, fast-paced.`,

    edtech: `A vertical 9:16 educational video about ${contentItem.data_input_payload?.exam} ${contentItem.data_input_payload?.subject}.
Topic: ${contentItem.data_input_payload?.topic}.
${contentItem.script_body || 'Formula explanation'}.
Style: Clear, professional, whiteboards/notes.`,

    travel: `A vertical 9:16 video of ${contentItem.data_input_payload?.location || 'Indian destination'}.
Near ${contentItem.data_input_payload?.baseCity || 'city'}.
${contentItem.script_body || 'Travel guide'}.
Style: Cinematic, drone shots, exploration.`,

    cartoon: `A vertical 9:16 animated cartoon in ${contentItem.data_input_payload?.dialect || 'Indian'} style.
Theme: ${contentItem.data_input_payload?.theme || 'family'}.
Characters: ${contentItem.data_input_payload?.characters?.join(', ') || 'family'}.
Style: 2D animation, colorful, family-friendly.`,
  };

  return basePrompts[nicheId] || basePrompts.food;
}

/**
 * Build image prompts for carousel/single image
 */
function buildImagePrompts(contentItem: any, nicheId: NicheId, count: number): string[] {
  const prompt = `Indian-style ${nicheId} content. ${contentItem.data_input_payload?.dish || contentItem.data_input_payload?.location || contentItem.data_input_payload?.toolName || 'content'}. ${contentItem.script_body || ''}`;

  return Array(count).fill(prompt);
}

/**
 * Download media from URL
 */
async function downloadMedia(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download media: ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
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

export { mediaWorker };