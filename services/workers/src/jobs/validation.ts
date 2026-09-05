/**
 * Validation Worker
 * Validates content before publishing
 */

import { Job } from 'bullmq';
import { supabase } from '@viralforge/supabase';
import { promises as fs } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function validationWorker(job: Job) {
  const { contentItemId } = job.data;

  console.log(`[Validation] Starting validation for content ${contentItemId}`);

  try {
    await job.updateProgress(10);

    // Get content item
    const { data: contentItem, error: fetchError } = await supabase
      .from('content_items')
      .select('*, niche_profiles(*), niche_accounts(*)')
      .eq('id', contentItemId)
      .single();

    if (fetchError || !contentItem) {
      throw new Error(`Content item not found: ${contentItemId}`);
    }

    const errors: string[] = [];
    const warnings: string[] = [];

    await job.updateProgress(20);

    // 1. Validate required fields
    if (!contentItem.script_body || contentItem.script_body.length < 50) {
      errors.push('Script body is missing or too short');
    }

    if (!contentItem.hook_variation_a) {
      errors.push('Hook variation A is missing');
    }

    if (!contentItem.niche_account_id) {
      errors.push('No connected account for this content');
    }

    await job.updateProgress(40);

    // 2. Validate account status
    if (contentItem.niche_accounts?.status !== 'active') {
      errors.push(`Account is ${contentItem.niche_accounts?.status}, not active`);
    }

    // Check token expiration
    if (contentItem.niche_accounts?.token_expires_at) {
      const expiresAt = new Date(contentItem.niche_accounts.token_expires_at);
      if (expiresAt < new Date()) {
        errors.push('Account access token has expired');
      }
    }

    await job.updateProgress(60);

    // 3. Validate content (no copyrighted text, no medical claims for health, etc.)
    const contentValidation = validateContentByNiche(contentItem);
    errors.push(...contentValidation.errors);
    warnings.push(...contentValidation.warnings);

    await job.updateProgress(70);

    // 4. Check for duplicate content
    const isDuplicate = await checkDuplicateContent(contentItem);
    if (isDuplicate) {
      warnings.push('Similar content was published in the last 7 days');
    }

    await job.updateProgress(80);

    // 5. Check publishing limits
    const dailyCount = await getDailyPublishingCount(contentItem.niche_account_id);
    const maxPerDay = contentItem.niche_profiles?.max_posts_per_day || 5;

    if (dailyCount >= maxPerDay) {
      errors.push(`Daily publishing limit reached (${maxPerDay} posts per day)`);
    }

    await job.updateProgress(90);

    // 6. Check media file integrity
    if (contentItem.rendering_manifest?.finalMediaUrl) {
      const mediaValid = await validateMediaFile(contentItem.rendering_manifest.finalMediaUrl);
      if (!mediaValid) {
        errors.push('Rendered media file failed validation');
      }
    } else {
      errors.push('No rendered media file found');
    }

    await job.updateProgress(100);

    // Update content item based on validation result
    const status = errors.length > 0 ? 'blocked' : 'scheduled';

    await supabase
      .from('content_items')
      .update({
        status,
        validation_errors: errors,
        validation_warnings: warnings,
      })
      .eq('id', contentItemId);

    // Log audit event
    await logAuditEvent(contentItemId, 'validation.completed', {
      status,
      errorCount: errors.length,
      warningCount: warnings.length,
    });

    console.log(`[Validation] Validation ${errors.length > 0 ? 'failed' : 'passed'} for content ${contentItemId}`);

    return {
      success: errors.length === 0,
      contentItemId,
      errors,
      warnings,
      status,
    };
  } catch (error) {
    console.error(`[Validation] Error for content ${contentItemId}:`, error);

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
 * Validate content by niche
 */
function validateContentByNiche(contentItem: any): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const script = (contentItem.script_body || '').toLowerCase();
  const caption = ''; // TODO: extract from generated content

  switch (contentItem.niche_id) {
    case 'health':
      // No medical claims allowed
      const medicalClaims = ['cure', 'guaranteed', 'doctor recommended', 'medicine', 'disease', 'diagnosis'];
      for (const claim of medicalClaims) {
        if (script.includes(claim)) {
          errors.push(`Medical claim detected: "${claim}". Health content must avoid medical claims.`);
        }
      }
      break;

    case 'tech':
      // Warn on vague time savings claims
      if (script.includes('100%') || script.includes('guaranteed')) {
        warnings.push('Vague claims detected - consider specific metrics');
      }
      break;

    case 'edtech':
      // Educational content should have specific topics
      if (!contentItem.data_input_payload?.topic) {
        warnings.push('No specific topic identified for educational content');
      }
      break;

    case 'travel':
      // No unverified locations
      if (script.includes('secret') || script.includes('unknown place')) {
        warnings.push('Verify location claims before publishing');
      }
      break;

    case 'cartoon':
      // Family-friendly check
      const adultContent = ['alcohol', 'drugs', 'violence', 'weapon'];
      for (const item of adultContent) {
        if (script.includes(item)) {
          errors.push(`Adult content detected: "${item}"`);
        }
      }
      break;
  }

  // Check for AI disclosure if required
  if (contentItem.ai_disclosure_required) {
    if (!script.includes('ai') && !script.includes('generated')) {
      warnings.push('AI disclosure may be required but not detected in content');
    }
  }

  return { errors, warnings };
}

/**
 * Check for duplicate content
 */
async function checkDuplicateContent(contentItem: any): Promise<boolean> {
  const { data: similarItems } = await supabase
    .from('content_items')
    .select('id, script_body, hook_variation_a')
    .eq('niche_account_id', contentItem.niche_account_id)
    .eq('status', 'published')
    .gte('published_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .neq('id', contentItem.id);

  if (!similarItems || similarItems.length === 0) return false;

  // Simple similarity check (word overlap)
  const currentWords = new Set(
    (contentItem.script_body || '').toLowerCase().split(/\s+/)
  );

  for (const item of similarItems) {
    const itemWords = (item.script_body || '').toLowerCase().split(/\s+/);
    const overlap = itemWords.filter((w: string) => currentWords.has(w)).length;
    const similarity = overlap / Math.max(itemWords.length, 1);

    if (similarity > 0.7) {
      return true;
    }
  }

  return false;
}

/**
 * Get daily publishing count for an account
 */
async function getDailyPublishingCount(accountId: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const { count } = await supabase
    .from('content_items')
    .select('*', { count: 'exact', head: true })
    .eq('niche_account_id', accountId)
    .gte('published_at', startOfDay.toISOString());

  return count || 0;
}

/**
 * Validate media file integrity
 */
async function validateMediaFile(filePath: string): Promise<boolean> {
  try {
    // Download file and validate
    const { storage } = await import('@viralforge/supabase');
    const { data, error } = await storage
      .from('viralforge-content')
      .download(filePath);

    if (error || !data) return false;

    // Save to temp file
    const tempPath = `/tmp/validate-${Date.now()}.mp4`;
    await fs.writeFile(tempPath, Buffer.from(await data.arrayBuffer()));

    // Use FFprobe to check file
    const { stdout } = await execAsync(`ffprobe -v quiet -print_format json -show_format -show_streams "${tempPath}"`);

    const metadata = JSON.parse(stdout);
    const hasVideo = metadata.streams?.some((s: any) => s.codec_type === 'video');
    const hasAudio = metadata.streams?.some((s: any) => s.codec_type === 'audio');

    // Clean up
    await fs.unlink(tempPath).catch(() => {});

    return hasVideo && hasAudio;
  } catch (error) {
    console.error('Media validation failed:', error);
    return false;
  }
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

export { validationWorker };