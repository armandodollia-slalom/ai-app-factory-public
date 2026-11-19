// Loaded into every Node process of a test run (scripts/pipeline/test/run.mjs puts it in NODE_OPTIONS): each test file's
// process gets a temp directory of its own (TMPDIR, TMP and TEMP point into it, so os.tmpdir() and every child process it
// starts use it) and removes it when it exits, passed or failed. The run's registry lists every such directory, so the
// runner removes what a killed process left. The test files' children inherit the variables and do nothing here.
// FACTORY_TEST_KEEP_TMP=1 keeps the directories, to find which tests leave files behind.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const context = process.env.NODE_TEST_CONTEXT ?? '';
const registry = process.env.FACTORY_TEST_TMP_REGISTRY;
if (registry && context.startsWith('child') && !process.env.FACTORY_TEST_TMP_FILE) {
  // Directly in the temp folder, with a short name: macOS caps unix socket paths (the language-server daemons' sockets
  // live under the temp dir) at 104 bytes.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft'));
  const entry = path.join(registry, path.basename(dir));
  fs.writeFileSync(entry, `${dir}\n${process.argv[1] ?? ''}\n`);
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) process.env[key] = dir;
  process.env.FACTORY_TEST_TMP_FILE = dir;
  if (process.env.FACTORY_TEST_KEEP_TMP !== '1') {
    process.on('exit', () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
        fs.rmSync(entry, { force: true });
      } catch {
        // a file a background process still holds open (Windows): the runner removes it at the end
      }
    });
  }
}
