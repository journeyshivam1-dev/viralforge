import {
  ReplicateAdapter,
  ReplicateAdapterConfig,
} from '../../packages/domain';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const config: ReplicateAdapterConfig = {
  apiToken: 'test-token',
  image: { version: 'image-version', defaultInput: { quality: 80 } },
  video: { version: 'video-version' },
  timeoutMs: 10_000,
  initialPollDelayMs: 10,
  maxPollDelayMs: 40,
};

describe('ReplicateAdapter', () => {
  test('creates, polls with bounded backoff, and normalizes array output', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(jsonResponse({
        id: 'prediction-1',
        status: 'starting',
        urls: { get: 'https://api.replicate.com/v1/predictions/prediction-1' },
      }))
      .mockResolvedValueOnce(jsonResponse({ id: 'prediction-1', status: 'processing' }))
      .mockResolvedValueOnce(jsonResponse({
        id: 'prediction-1',
        status: 'succeeded',
        output: [
          'https://replicate.delivery/one.webp',
          'https://replicate.delivery/two.webp',
        ],
      }));
    const sleep = jest.fn().mockResolvedValue(undefined);
    let now = 0;

    const adapter = new ReplicateAdapter(config, {
      fetch: fetchMock,
      sleep: async (delayMs) => {
        sleep(delayMs);
        now += delayMs;
      },
      now: () => now,
    });

    const artifacts = await adapter.generate({
      sceneIndex: 2,
      kind: 'image',
      prompt: 'A bowl of mango dessert',
      width: 1080,
      height: 1920,
      input: { num_outputs: 2 },
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([10, 20]);
    const createInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect(createInit.headers).toMatchObject({ Authorization: 'Bearer test-token' });
    expect(JSON.parse(createInit.body as string)).toEqual({
      version: 'image-version',
      input: {
        quality: 80,
        prompt: 'A bowl of mango dessert',
        width: 1080,
        height: 1920,
        num_outputs: 2,
      },
    });
    expect(artifacts).toEqual([
      expect.objectContaining({
        sceneIndex: 2,
        kind: 'image',
        url: 'https://replicate.delivery/one.webp',
        provider: 'replicate',
        providerPredictionId: 'prediction-1',
      }),
      expect.objectContaining({ url: 'https://replicate.delivery/two.webp' }),
    ]);
  });

  test('normalizes object output and uses configured video model', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({
      id: 'prediction-video',
      status: 'succeeded',
      output: { video: 'https://replicate.delivery/video.mp4' },
    }));
    const adapter = new ReplicateAdapter(config, { fetch: fetchMock });

    const [artifact] = await adapter.generate({
      sceneIndex: 1,
      kind: 'video',
      prompt: 'A slow pan over a finished dessert',
      durationSeconds: 5,
    });

    const createInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(createInit.body as string).version).toBe('video-version');
    expect(artifact).toMatchObject({
      kind: 'video',
      url: 'https://replicate.delivery/video.mp4',
      durationSeconds: 5,
    });
  });

  test('classifies auth and transient HTTP failures', async () => {
    const blocked = new ReplicateAdapter(config, {
      fetch: jest.fn().mockResolvedValue(jsonResponse({ detail: 'Invalid token' }, 401)),
    });
    const retryable = new ReplicateAdapter(config, {
      fetch: jest.fn().mockResolvedValue(jsonResponse({ detail: 'Capacity unavailable' }, 503)),
    });

    await expect(blocked.generate({ sceneIndex: 1, kind: 'image', prompt: 'prompt' }))
      .rejects.toMatchObject({ classification: 'blocked', status: 401 });
    await expect(retryable.generate({ sceneIndex: 1, kind: 'image', prompt: 'prompt' }))
      .rejects.toMatchObject({ classification: 'retryable', status: 503 });
  });

  test('classifies safety failures as blocked and invalid input as permanent', async () => {
    const safety = new ReplicateAdapter(config, {
      fetch: jest.fn().mockResolvedValue(jsonResponse({
        id: 'prediction-safety',
        status: 'failed',
        error: 'NSFW content blocked by safety checker',
      })),
    });
    const invalid = new ReplicateAdapter(config, {
      fetch: jest.fn().mockResolvedValue(jsonResponse({ detail: 'Invalid input' }, 422)),
    });

    await expect(safety.generate({ sceneIndex: 1, kind: 'image', prompt: 'prompt' }))
      .rejects.toMatchObject({ classification: 'blocked', providerCode: 'failed' });
    await expect(invalid.generate({ sceneIndex: 1, kind: 'image', prompt: 'prompt' }))
      .rejects.toMatchObject({ classification: 'permanent', status: 422 });
  });

  test('enforces an overall timeout across polling', async () => {
    const fetchMock = jest.fn().mockImplementation(() => Promise.resolve(jsonResponse({
      id: 'prediction-timeout',
      status: 'processing',
    })));
    let now = 0;
    const adapter = new ReplicateAdapter({
      ...config,
      timeoutMs: 25,
      initialPollDelayMs: 20,
      maxPollDelayMs: 20,
    }, {
      fetch: fetchMock,
      sleep: async (delayMs) => { now += delayMs; },
      now: () => now,
    });

    let error: unknown;
    try {
      await adapter.generate({ sceneIndex: 1, kind: 'image', prompt: 'prompt' });
    } catch (caught) {
      error = caught;
    }
    expect(typeof error).toBe('object');
    expect((error as { message: string }).message).toBe('Replicate prediction timed out after 25ms');
    expect((error as { classification: string }).classification).toBe('retryable');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('requires explicit video configuration', async () => {
    const adapter = new ReplicateAdapter({ ...config, video: undefined }, {
      fetch: jest.fn(),
    });

    await expect(adapter.generate({ sceneIndex: 1, kind: 'video', prompt: 'prompt' }))
      .rejects.toMatchObject({ classification: 'permanent' });
  });
});
