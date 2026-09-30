BEGIN;

SELECT plan(11);

SELECT has_table('public', 'pipeline_runs', 'pipeline_runs exists');
SELECT has_table('public', 'stage_attempts', 'stage_attempts exists');
SELECT has_table('public', 'pipeline_artifacts', 'pipeline_artifacts exists');
SELECT has_table('public', 'queue_outbox', 'queue_outbox exists');
SELECT has_table('public', 'publication_attempts', 'publication_attempts exists');

SELECT is(
  (SELECT public FROM storage.buckets WHERE id = 'viralforge-content'),
  FALSE,
  'viralforge-content is private'
);
SELECT is(
  (SELECT file_size_limit FROM storage.buckets WHERE id = 'viralforge-content'),
  524288000::bigint,
  'viralforge-content has the expected file-size limit'
);

SELECT is(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.organizations'::regclass),
  TRUE,
  'organizations has RLS enabled'
);
SELECT is(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.niche_prompt_templates'::regclass),
  TRUE,
  'niche_prompt_templates has RLS enabled'
);
SELECT is(
  (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public'),
  0,
  'public application tables expose no policies yet'
);
SELECT function_privs_are(
  'public',
  'start_content_pipeline',
  ARRAY['uuid', 'uuid', 'text', 'text', 'jsonb', 'timestamp with time zone'],
  'service_role',
  ARRAY['EXECUTE'],
  'service_role can start pipelines'
);

SELECT * FROM finish();
ROLLBACK;
