import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('--version prints package.json version and exits 0', () => {
  const repoRoot = process.cwd();
  // Resolve the expected version independently of the CLI's own path logic
  // (from the repo root) so a shared resolution bug can't make this tautological.
  const expected = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;

  const result = spawnSync('node', ['src/cli.mjs', '--version'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, 'should exit with code 0');
  assert.equal(result.stdout.trim(), expected);
});
