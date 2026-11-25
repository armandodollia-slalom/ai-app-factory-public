// Loaded into every Node process of a test run (scripts/pipeline/test/run.mjs puts it in NODE_OPTIONS): each test file's
// process gets a temp directory of its own (TMPDIR, TMP and TEMP point into it, so os.tmpdir() and every child process it
// starts use it) and removes it when it exits, passed or failed. The run's registry lists every such directory, so the
// runner removes what a killed process left. The test files' children inherit the variables and do nothing here.
// FACTORY_TEST_KEEP_TMP=1 keeps the directories, to find which tests leave files behind.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The agent CLIs run.mjs replaces with a stand-in that records the call and fails: no test starts a paid agent. Every
// CLI the factory runs (models.pool) or probes (the interview) is here (test-temp.test.mjs checks it).
export const AGENT_CLIS = ['claude', 'codex', 'copilot', 'gemini', 'cursor', 'cursor-agent'];
// The recorded calls of the run (test file, working directory, cli and arguments), or of one test file.
export function realAgentCalls(file, testFile = null) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  return testFile ? lines.filter((l) => l.split('\t')[0] === testFile) : lines;
}

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
  // The test file a stand-in agent CLI names when a test (or a process it started) runs it: the file fails.
  const testFile = process.argv[1] ?? '';
  process.env.FACTORY_TEST_FILE = testFile;
  const calls = process.env.FACTORY_TEST_AGENT_CALLS;
  if (calls) {
    process.on('exit', () => {
      const own = realAgentCalls(calls, testFile);
      if (!own.length) return;
      for (const c of own) process.stderr.write(`a test started a real agent CLI (a paid run): ${c}\n`);
      process.exitCode = 1;
    });
  }
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
