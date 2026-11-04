import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('Git archive keeps Linux release scripts in LF format', async () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'order-record-archive-eol-'));
  const archive = path.join(dir, 'source.tar');
  const scripts = ['deploy/prepare-release.sh', 'deploy/release-server.sh'];
  try {
    execFileSync('git', [
      '-C', repo, '-c', 'core.autocrlf=true', 'archive', '--format=tar',
      `--output=${archive}`, 'HEAD', '--', ...scripts,
    ]);
    for (const script of scripts) {
      const data = execFileSync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-xOf', archive, script]);
      assert.ok(data.length > 0, script);
      assert.equal(data.includes(13), false, `${script} contains CR characters`);
      assert.match(data.toString('utf8'), /^#!.*\n/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
