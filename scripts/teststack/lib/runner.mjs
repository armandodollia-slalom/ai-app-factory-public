// Runs `docker compose` for one stack (project, compose file, env file). Everything the loader does to the
// stack goes through here, so tests replace it with a fake that records the commands.
import { spawn } from 'node:child_process';
import { externalKind, externalTimeoutSec } from '../../pipeline/lib/external.mjs';

/** Spawns a command and resolves to { status, stdout, stderr, timedOut }. `inherit` sends its output to our stderr.
 *  Docker is an external call: it always has a timeout (pipeline/lib/external.mjs; `timeoutSec` overrides it). */
export function capture(cmd, args, { cwd, env, input, inherit = false, shell = false, timeoutSec } = {}) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd, env, shell, windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', inherit ? 2 : 'pipe', inherit ? 2 : 'pipe'] });
    const out = [];
    const err = [];
    const limit = timeoutSec ?? externalTimeoutSec(externalKind(cmd, args), env ?? process.env);
    let timedOut = false;
    const timer = limit ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, limit * 1000) : null;
    child.stdout?.on('data', chunk => out.push(chunk));
    child.stderr?.on('data', chunk => err.push(chunk));
    child.on('error', error => { clearTimeout(timer); resolve({ status: 127, stdout: '', stderr: error.message }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({
      status: code ?? 1,
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8') + (timedOut ? `\n${cmd} ${args.slice(0, 3).join(' ')} timed out after ${limit} s` : signal ? `\nkilled by ${signal}` : ''),
      timedOut,
    }); });
    if (input !== undefined) {
      child.stdin.on('error', () => { /* the command exited before reading everything */ });
      child.stdin.end(input);
    }
  });
}

export function composeRunner({ docker = 'docker', project, composeFile, envFile, cwd, env = process.env }) {
  const prefix = ['compose', '-p', project, '-f', composeFile, ...(envFile ? ['--env-file', envFile] : [])];
  const compose = (args, options = {}) => capture(docker, [...prefix, ...args], { cwd, env, ...options });
  return {
    docker,
    prefix,
    compose,
    /** Runs a command inside a service's container, without a TTY. */
    exec: (service, argv, { input, env: vars = {}, user } = {}) =>
      compose(['exec', '-T', ...(user ? ['-u', user] : []), ...Object.entries(vars).flatMap(([key, value]) => ['-e', `${key}=${value}`]), service, ...argv], { input }),
    /** A docker command outside compose (image inspect, tag, info). */
    run: (args, options = {}) => capture(docker, args, { cwd, env, ...options }),
  };
}
