import {
  GeneratedContentPackageSchema,
  MediaManifestSchema,
  RenderManifestSchema,
  SceneArtifactSchema,
  ScenePlanSchema,
} from '../../packages/domain';

const scene = {
  index: 1,
  durationSeconds: 5,
  voiceover: 'Fresh mangoes make this quick dessert.',
  onScreenText: 'Mango dessert',
  visualPrompt: 'A close-up of sliced mango on a bright kitchen counter',
  mediaType: 'image' as const,
};

const artifact = {
  sceneIndex: 1,
  kind: 'image' as const,
  url: 'https://cdn.example.com/scene-1.webp',
  provider: 'replicate',
  providerPredictionId: 'prediction-1',
  width: 1080,
  height: 1920,
  metadata: {},
};

const mediaManifest = {
  schemaVersion: 1 as const,
  contentItemId: 'content-1',
  artifacts: [artifact],
  createdAt: '2026-09-24T10:00:00.000Z',
};

describe('media domain contracts', () => {
  test('runtime-validates generated content and scene plans', () => {
    expect(ScenePlanSchema.parse(scene)).toEqual(scene);
    expect(GeneratedContentPackageSchema.parse({
      schemaVersion: 1,
      primaryHook: 'Make this before mango season ends.',
      alternateHooks: [],
      script: 'A complete short-form script.',
      caption: 'Save this mango dessert recipe.',
      hashtags: ['#mango'],
      cta: 'Follow for more recipes.',
      scenes: [scene],
      disclosures: [],
    }).scenes).toHaveLength(1);
  });

  test('rejects malformed and duplicate scene data', () => {
    expect(ScenePlanSchema.safeParse({ ...scene, durationSeconds: 0 }).success).toBe(false);
    expect(GeneratedContentPackageSchema.safeParse({
      schemaVersion: 1,
      primaryHook: 'Hook',
      script: 'Script',
      caption: 'Caption',
      cta: 'CTA',
      scenes: [scene, { ...scene }],
    }).success).toBe(false);
  });

  test('runtime-validates scene, media, and render manifests', () => {
    expect(SceneArtifactSchema.parse(artifact)).toEqual(artifact);
    expect(MediaManifestSchema.parse(mediaManifest)).toEqual(mediaManifest);
    expect(RenderManifestSchema.parse({
      schemaVersion: 1,
      contentItemId: 'content-1',
      mediaManifest,
      output: {
        url: 'storage://viralforge-content/media/content-1/final.mp4',
        mimeType: 'video/mp4',
        width: 1080,
        height: 1920,
        durationSeconds: 5,
      },
      renderedAt: '2026-09-24T10:01:00.000Z',
      renderer: 'ffmpeg',
    }).output.mimeType).toBe('video/mp4');
  });

  test('rejects non-HTTP artifacts and duplicate manifest entries', () => {
    expect(SceneArtifactSchema.safeParse({ ...artifact, url: 'file:///tmp/scene.webp' }).success).toBe(false);
    expect(MediaManifestSchema.safeParse({
      ...mediaManifest,
      artifacts: [artifact, { ...artifact, url: 'https://cdn.example.com/duplicate.webp' }],
    }).success).toBe(false);
  });
});
