/**
 * Scheduler Worker
 * Cron-like job that queues scheduled content items
 */

import { Job } from 'bullmq';
import { supabase } from '@viralforge/supabase';
import { queueContentGeneration, queuePublishing } from '../../api/src/queues/content-queue';

const SCHEDULE_WINDOW_MINUTES = 5; // Check 5 minutes ahead

export async function schedulerWorker(job: Job) {
  console.log(`[Scheduler] Running scheduled job`);

  try {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + SCHEDULE_WINDOW_MINUTES * 60 * 1000);

    // Find content items scheduled to be published within the window
    const { data: itemsToPublish, error: publishError } = await supabase
      .from('content_items')
      .select('*')
      .eq('status', 'scheduled')
      .lte('scheduled_at', windowEnd.toISOString())
      .gte('scheduled_at', now.toISOString());

    if (publishError) {
      throw new Error(`Failed to fetch scheduled items: ${publishError.message}`);
    }

    // Queue them for publishing
    if (itemsToPublish) {
      for (const item of itemsToPublish) {
        await queuePublishing(item.id, new Date(item.scheduled_at));
        console.log(`[Scheduler] Queued for publishing: ${item.id}`);
      }
    }

    // Find items that need to enter the generation pipeline
    const { data: itemsToGenerate, error: genError } = await supabase
      .from('content_items')
      .select('*')
      .eq('status', 'queued')
      .lte('scheduled_at', windowEnd.toISOString())
      .gte('scheduled_at', now.toISOString());

    if (genError) {
      throw new Error(`Failed to fetch queued items: ${genError.message}`);
    }

    if (itemsToGenerate) {
      for (const item of itemsToGenerate) {
        await queueContentGeneration({
          nicheId: item.niche_id,
          subTopic: item.sub_topic,
          dataInputPayload: item.data_input_payload,
          triggerSource: 'calendar',
          triggerMetadata: { scheduledAt: item.scheduled_at },
        });
        console.log(`[Scheduler] Queued for generation: ${item.id}`);
      }
    }

    // Find past-due items that haven't been processed
    const { data: overdueItems } = await supabase
      .from('content_items')
      .select('*')
      .in('status', ['draft', 'queued'])
      .lt('scheduled_at', now.toISOString());

    if (overdueItems && overdueItems.length > 0) {
      console.warn(`[Scheduler] Found ${overdueItems.length} overdue items`);

      for (const item of overdueItems) {
        await supabase
          .from('content_items')
          .update({
            validation_warnings: [
              ...(item.validation_warnings || []),
              'Item was past-due and processed immediately',
            ],
          })
          .eq('id', item.id);

        await queueContentGeneration({
          nicheId: item.niche_id,
          subTopic: item.sub_topic,
          dataInputPayload: item.data_input_payload,
          triggerSource: 'calendar',
          triggerMetadata: { wasOverdue: true },
        });
      }
    }

    return {
      success: true,
      queuedForPublishing: itemsToPublish?.length || 0,
      queuedForGeneration: itemsToGenerate?.length || 0,
      overdueItems: overdueItems?.length || 0,
    };
  } catch (error) {
    console.error('[Scheduler] Error:', error);
    throw error;
  }
}

export { schedulerWorker };