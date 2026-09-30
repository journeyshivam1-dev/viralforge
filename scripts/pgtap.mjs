#!/usr/bin/env node
/**
 * Runs supabase/tests/*.sql with psql inside the local DB container.
 * Alternative to `supabase test db`, whose pg_prove image pull can hang Docker
 * Desktop on low-memory machines. pgTAP is installed inside the same
 * transaction each test rolls back, so nothing persists.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const container = process.env.SUPABASE_DB_CONTAINER || 'supabase_db_viralforge-local';
const dir = path.resolve('supabase/tests');
let failures = 0;

for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) {
  const sql = [
    'BEGIN;',
    'CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;',
    'SET LOCAL search_path TO public, extensions;',
    // The test's own BEGIN only warns inside this transaction; its ROLLBACK undoes everything.
    readFileSync(path.join(dir, file), 'utf8'),
  ].join('\n');
  let output = '';
  try {
    output = execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-t', '-A'], {
      input: sql,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    output = `${error.stdout || ''}\nERROR ${error.stderr || error.message}`;
  }
  const lines = output.split(/\r?\n/).filter((line) => /^(ok|not ok|1\.\.|#)/.test(line) || line.startsWith('ERROR'));
  const failed = lines.filter((line) => line.startsWith('not ok') || line.startsWith('ERROR'));
  const planned = Number(/^1\.\.(\d+)/m.exec(output)?.[1] || 0);
  const passed = lines.filter((line) => line.startsWith('ok')).length;
  if (failed.length || passed !== planned) failures += 1;
  console.log(`${failed.length || passed !== planned ? 'FAIL' : 'PASS'} ${file} (${passed}/${planned})`);
  for (const line of failed) console.log(`  ${line}`);
}

process.exit(failures ? 1 : 0);
