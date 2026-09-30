import {
  PIPELINE_STAGES,
  buildPipelineJobId,
  getNextPipelineStage,
  isPipelineStage,
  isStageTerminal,
} from '../../packages/domain/src/schemas/pipeline';

describe('pipeline contracts', () => {
  test('defines the canonical stage order', () => {
    expect(PIPELINE_STAGES).toEqual([
      'research', 'generation', 'media', 'rendering', 'validation', 'publishing',
    ]);
    expect(getNextPipelineStage('research')).toBe('generation');
    expect(getNextPipelineStage('validation')).toBe('publishing');
    expect(getNextPipelineStage('publishing')).toBeNull();
  });

  test('builds deterministic BullMQ-safe IDs', () => {
    const first = buildPipelineJobId('run:with:colons', 'media', 2);
    const second = buildPipelineJobId('run:with:colons', 'media', 2);
    expect(first).toBe(second);
    expect(first).toBe('pipeline-run-with-colons-media-2');
    expect(first).not.toContain(':');
  });

  test('validates stages and terminal states', () => {
    expect(isPipelineStage('rendering')).toBe(true);
    expect(isPipelineStage('unknown')).toBe(false);
    expect(isStageTerminal('completed')).toBe(true);
    expect(isStageTerminal('processing')).toBe(false);
  });
});
