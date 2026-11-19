#!/usr/bin/env node
// `npm test`: runs `node --test <files>` so that every test file's temp files go when it ends (temp-preload.mjs gives
// each test file's process a temp directory of its own and removes it on exit, passed or failed), and removes whatever a
// killed process left when the run ends. Tests and the processes they start use os.tmpdir() as usual.
//   node scripts/pipeline/test/run.mjs scripts/*/test/*.test.mjs
// FACTORY_TEST_KEEP_TMP=1 keeps everything and prints the registry (which test file made which directory).
// FACTORY_TEST_TMP_PARENT puts the run's temp files in another folder (the guard test).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const preload = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'temp-preload.mjs')).href;
const base = process.env.FACTORY_TEST_TMP_PARENT || os.tmpdir();
const registry = fs.mkdtempSync(path.join(base, 'ftrun-'));
const keep = process.env.FACTORY_TEST_KEEP_TMP === '1';
// FACTORY_PRUNE=0: no test's `implement run` prunes this machine's real images or engine installs.
const env = { ...process.env, FACTORY_PRUNE: '0', TMPDIR: base, TMP: base, TEMP: base, FACTORY_TEST_TMP_REGISTRY: registry, NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preload}`].filter(Boolean).join(' ') };
// A run started from inside a test (the guard test) is a run of its own.
delete env.FACTORY_TEST_TMP_FILE;
delete env.NODE_TEST_CONTEXT;
const cleanup = () => {
  if (keep) return console.error(`test temp files kept; registry: ${registry}`);
  for (const entry of fs.readdirSync(registry)) {
    const dir = fs.readFileSync(path.join(registry, entry), 'utf8').split('\n')[0];
    try {
      if (dir && path.dirname(dir) === base) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      console.error(`could not remove ${dir}: ${error.message}`);
    }
  }
  fs.rmSync(registry, { recursive: true, force: true });
};
const child = spawn(process.execPath, ['--test', ...process.argv.slice(2)], { stdio: 'inherit', env });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('close', (code, signal) => {
  cleanup();
  process.exit(code ?? (signal ? 1 : 0));
});
