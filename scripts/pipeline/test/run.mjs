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
import { AGENT_CLIS, realAgentCalls } from './temp-preload.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const preload = pathToFileURL(path.join(here, 'temp-preload.mjs')).href;
const offline = pathToFileURL(path.join(here, 'offline-preload.mjs')).href;
const base = process.env.FACTORY_TEST_TMP_PARENT || os.tmpdir();
const registry = fs.mkdtempSync(path.join(base, 'ftrun-'));
const keep = process.env.FACTORY_TEST_KEEP_TMP === '1';
// No test contacts a code host: a `gh` that fails comes first on PATH, the hosts' tokens are not passed on, and every
// test process blocks a fetch that leaves this machine (offline-preload.mjs).
const noHost = fs.mkdtempSync(path.join(base, 'ftrun-nohost-'));
fs.writeFileSync(path.join(noHost, 'gh'), '#!/bin/sh\necho "gh: tests run offline" >&2\nexit 1\n', { mode: 0o755 });
fs.writeFileSync(path.join(noHost, 'gh.cmd'), '@echo gh: tests run offline 1>&2\r\n@exit /b 1\r\n');
// No test starts a paid agent: each agent CLI on PATH is a stand-in that records the call and fails. A test's own fake
// CLIs come before it on PATH (tests prepend their fake bin), and PIPELINE_AGENT_CMD fakes never reach it. A call fails
// its test file (temp-preload.mjs) and the run.
const agentCalls = path.join(noHost, 'agent-calls.log');
fs.writeFileSync(agentCalls, '');
for (const cli of AGENT_CLIS) {
  // A version probe (the interview's and the doctor's "is it installed") sees a machine without the CLI, the same on
  // every machine; anything else is an agent run: recorded, and it fails.
  fs.writeFileSync(path.join(noHost, cli), `#!/bin/sh\ncase "$1" in --version|-v|version) echo "${cli}: not installed (tests)" >&2; exit 127;; esac\nprintf '%s\\t%s\\t%s\\n' "\${FACTORY_TEST_FILE:-?}" "$PWD" "${cli} $*" | cut -c1-600 >> "${agentCalls}"\necho "${cli}: a test started the real agent CLI; tests run every agent through a fake (PIPELINE_AGENT_CMD or a fake bin first on PATH)" >&2\nexit 1\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(noHost, `${cli}.cmd`), `@echo %FACTORY_TEST_FILE%\t%CD%\t${cli} %*>> "${agentCalls}"\r\n@echo ${cli}: a test started the real agent CLI 1>&2\r\n@exit /b 1\r\n`);
}
// FACTORY_PRUNE=0: no test's `implement run` prunes this machine's real images or engine installs.
// Git reaches only local repositories (a fetch from an https or ssh remote a fixture names fails at once).
const env = { ...process.env, FACTORY_TEST_AGENT_CALLS: agentCalls, GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0', FACTORY_PRUNE: '0', TMPDIR: base, TMP: base, TEMP: base, FACTORY_TEST_TMP_REGISTRY: registry, PATH: `${noHost}${path.delimiter}${process.env.PATH ?? ''}`, NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preload}`, `--import=${offline}`].filter(Boolean).join(' ') };
for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITLAB_TOKEN', 'AZURE_DEVOPS_TOKEN', 'AZURE_DEVOPS_EXT_PAT', 'SYSTEM_ACCESSTOKEN', 'BITBUCKET_TOKEN']) delete env[k];
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
  fs.rmSync(noHost, { recursive: true, force: true });
};
const child = spawn(process.execPath, ['--test', ...process.argv.slice(2)], { stdio: 'inherit', env });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('close', (code, signal) => {
  const calls = realAgentCalls(agentCalls);
  for (const c of calls) console.error(`a test started a real agent CLI: ${c}`);
  cleanup();
  process.exit(calls.length ? 1 : code ?? (signal ? 1 : 0));
});
