#!/usr/bin/env node
// The test stack: a reproducible Docker Compose deployment of the whole application that a scenario file puts
// into a known state. Invoked as `factory teststack <command>`. See docs/test-stack.md.
// Logs go to stderr; stdout gets exactly one JSON line. Exit codes: 0 ok, 1 error, 2 not ready, 3 invalid
// scenario, 64 usage.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveModule, resolveRoot } from '../stack/lib/ports.mjs';
import { servicesFor } from '../stack/lib/services.mjs';
import { EXIT, TestStackError, intOption, log, parseArgs, usage } from './lib/common.mjs';
import { createContext } from './lib/context.mjs';
import { build, publish, rebuildChanged, requireDocker } from './lib/images.mjs';
import { load, validate } from './lib/load.mjs';
import { capture } from './lib/runner.mjs';
import { check, composeOrThrow, publicCheck, wait } from './lib/readiness.mjs';

const USAGE = `Usage: factory teststack [--slot <n>] [--root <app repo>] <command> [options]

  --slot <n>   0 (default, or $TESTSTACK_SLOT) is the standard stack. 1..maxSlot are isolated copies: their own
               compose project, every host port + slotStride*n, their own state folder and image tags.
               Lease one with 'factory stack lease'.

Lifecycle
  up [--scenario <name|path>] [--timeout <s>]   Build if needed, start the stack, wait, load the scenario
  down                                          Stop and remove all containers and data
  build [--force]                               Build the service images, only when their sources changed

State (all wait for readiness first)
  load <name|path> [--hard] [--timeout <s>]     Clear all state and load a scenario (base layer first)
  reset [--hard] [--timeout <s>]                Clear all state and load only the base layer
  wait [--timeout <s>]                          Block until every service is ready
  status                                        One readiness pass, without waiting

Authoring
  validate [<name|path>...]                     Parse and resolve scenarios without a running stack

Incremental
  rebuild-changed --base <git-ref>              Rebuild only the images affected by 'git diff <base>...HEAD' plus
                  [--services a,b]              uncommitted files, and recreate only those containers
  services-for <files...>                       Print the compose services those files affect (no Docker needed)

Generated compose file
  publish [--check]                             Regenerate the compose file (stack.publish); --check fails on drift

Other
  logs [service...]                             docker compose logs (passes extra arguments through)
  compose <args...>                             Run docker compose against the stack

Settings: the "stack" and "teststack" sections of .factory/config.json.
Exit codes: 0 ok, 1 error, 2 not ready (timeout), 3 invalid scenario, 64 usage.`;

const print = value => process.stdout.write(`${JSON.stringify(value)}\n`);

function passthrough(ctx, args) {
  return new Promise(resolve => {
    // external-call: interactive (a person's own `logs -f` or `ps`; they stop it)
    const child = spawn(ctx.runner.docker, [...ctx.runner.prefix, ...args], { cwd: ctx.root, stdio: 'inherit', windowsHide: true });
    child.on('error', error => { log(`error: ${error.message}`); resolve(EXIT.error); });
    child.on('close', code => resolve(code ?? EXIT.error));
  });
}

// D-C8-4: under `implement run` (or with FV_USE_SLOTS=1) an agent's stack is a leased slot: slot 0 holds whatever
// checkout built it last, so concurrent runs that start or test it collide. An agent (PIPELINE_AGENT_NAME set) may not
// change or use slot 0 there; the harness gives each role that needs a stack TESTSTACK_SLOT. Reading commands
// (validate, services-for, ps, info) stay open.
const SLOT_FREE = new Set(['validate', 'services-for', 'publish', 'info', 'ps', 'help']);
export function slotZeroRefusal(command, slot, env) {
  if (slot !== 0 || !env.PIPELINE_AGENT_NAME || SLOT_FREE.has(command)) return null;
  const slotsOn = Number(env.IMPLEMENT_PARALLEL ?? 0) >= 1 || env.FV_USE_SLOTS === '1';
  if (!slotsOn || env.FV_USE_SLOTS === '0') return null;
  return `\`teststack ${command}\` on slot 0 is refused for pipeline agents (${env.PIPELINE_AGENT_NAME}): slot 0 is shared by every checkout and concurrent runs would test each other's code. This agent was given no leased slot (TESTSTACK_SLOT); the harness runs the stack checks on a leased slot. Report what you need checked on the stack instead of starting one.`;
}

// Global options come before the command; everything after it belongs to the command.
function splitArgs(argv, env) {
  const global = { slot: env.TESTSTACK_SLOT || '0', root: null };
  let i = 0;
  for (; i < argv.length; i++) {
    const match = /^--(slot|root)(?:=(.*))?$/.exec(argv[i]);
    if (!match) break;
    const value = match[2] ?? argv[++i];
    if (value === undefined || value === '') throw usage(`--${match[1]} requires a value.`);
    global[match[1]] = value;
  }
  return { global, command: argv[i], rest: argv.slice(i + 1) };
}

export async function main(argv, { env = process.env, cwd = process.cwd(), overrides = {} } = {}) {
  const state = { command: null, slot: null };
  try {
    const { global, command, rest } = splitArgs(argv, env);
    state.command = command ?? null;
    if (!command || ['-h', '--help', 'help'].includes(command)) {
      process.stderr.write(`${USAGE}\n`);
      return command ? EXIT.ok : EXIT.usage;
    }
    if (!/^\d+$/.test(global.slot)) throw usage(`--slot must be an integer, got '${global.slot}'`);
    state.slot = Number(global.slot);
    const refused = slotZeroRefusal(command, state.slot, env);
    if (refused) throw usage(refused);
    const offline = ['validate', 'services-for', 'publish'].includes(command);
    const ctx = await createContext({ root: resolveRoot(global.root, env), slot: state.slot, env, writeEnv: !offline, ...overrides });
    ctx.cwd = cwd;
    const { positionals, options } = parseArgs(rest);
    const timeoutSec = intOption(options, 'timeout', ctx.config.timeoutSeconds);
    const annotate = result => ({ ...result, ...ctx.annotation });
    const finish = (result, code = result.ok ? EXIT.ok : EXIT.notReady) => { print(result); return code; };

    switch (command) {
      case 'build':
        await build(ctx, { force: Boolean(options.force) });
        return finish(annotate({ ok: true, command }));
      case 'up': {
        await requireDocker(ctx);
        await build(ctx);
        log(`starting stack ${ctx.info.project} (slot ${ctx.info.slot})`);
        await composeOrThrow(ctx, ['up', '-d', '--remove-orphans'], { inherit: true });
        const scenario = options.scenario ?? ctx.config.defaultScenario ?? null;
        return finish(annotate(await load(ctx, scenario, { hard: Boolean(options.hard), noWait: Boolean(options['no-wait']), timeoutSec })));
      }
      case 'down':
        await requireDocker(ctx);
        try {
          await composeOrThrow(ctx, ['down', '-v', '--remove-orphans'], { inherit: true });
        } catch (error) {
          // A stack whose compose file no longer validates (its images or env changed since it started) is still taken
          // down, by its project name alone (council C8 proof: a killed run's slot could not be taken down).
          log(`compose file rejected (${String(error.message).split('\n')[0]}); taking ${ctx.info.project} down by project name`);
          const code = (await capture('docker', ['compose', '-p', ctx.info.project, 'down', '-v', '--remove-orphans'], { inherit: true })).status;
          if (code !== 0) throw error;
        }
        return finish(annotate({ ok: true, command }));
      case 'load':
        if (positionals.length !== 1) throw usage('Usage: load <scenario> [--hard] [--timeout <seconds>]');
        return finish(annotate(await load(ctx, positionals[0], { hard: Boolean(options.hard), noWait: Boolean(options['no-wait']), timeoutSec })));
      case 'reset':
        return finish(annotate(await load(ctx, null, { hard: Boolean(options.hard), noWait: Boolean(options['no-wait']), timeoutSec })));
      case 'wait': {
        const started = Date.now();
        const { ready, checks, healed } = await wait(ctx, timeoutSec);
        return finish(annotate({ ok: ready, command, elapsedMs: Date.now() - started, restarted: healed, failing: checks.filter(c => !c.ok).map(publicCheck) }));
      }
      case 'status': {
        const checks = await check(ctx);
        return finish(annotate({ ok: checks.every(c => c.ok), command, checks: checks.map(publicCheck) }));
      }
      case 'validate':
        return finish(await validate(ctx, positionals));
      case 'rebuild-changed': {
        const only = typeof options.services === 'string' ? options.services.split(/[,\s]+/).filter(Boolean) : [];
        return finish(annotate(await rebuildChanged(ctx, { base: typeof options.base === 'string' ? options.base : null, only, timeoutSec })));
      }
      case 'services-for':
        if (positionals.length === 0) throw usage('Usage: services-for <files...>');
        return finish({ ok: true, command, ...await servicesFor(positionals, { config: ctx.stack }) });
      case 'publish':
        return finish(await publish(ctx, { check: Boolean(options.check) }));
      case 'logs':
        await requireDocker(ctx);
        return passthrough(ctx, ['logs', ...rest]);
      case 'compose':
        await requireDocker(ctx);
        return passthrough(ctx, rest);
      default: {
        // Extra commands a repository or a language pack registers under teststack.commands.
        const spec = ctx.config.commands?.[command];
        if (!spec) {
          process.stderr.write(`${USAGE}\n`);
          throw usage(`unknown command '${command}'`);
        }
        const module = await import(pathToFileURL(resolveModule(spec, ctx.root)).href);
        return finish({ ok: true, command, ...await module.default({ positionals, options }, ctx) });
      }
    }
  } catch (error) {
    const exitCode = Number.isInteger(error.exitCode) ? error.exitCode : EXIT.error;
    log(`error: ${error instanceof TestStackError || error.exitCode ? error.message : error.stack ?? error}`);
    print({ ok: false, command: state.command, exitCode, error: error.message, ...(error.extra ?? {}), slot: state.slot });
    return exitCode;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
