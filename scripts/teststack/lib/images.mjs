// Images and the generated compose file. How a codebase builds its images and (optionally) generates its
// compose file is configuration: stack.build.all, stack.build.service, stack.publish, stack.publishCheck.
// Without build commands the images are built by `docker compose build` from the compose file itself.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { globToRegExp, matchesInput, servicesFor, serviceEntry } from '../../stack/lib/services.mjs';
import { INSTALL_ROOT, stateHome } from '../../stack/lib/ports.mjs';
import { recordBuiltImages } from '../../factory/lib/prune.mjs';
import { EXIT, TestStackError, log, sleep, usage } from './common.mjs';
import { formatEnv, parseEnv } from './context.mjs';
import { capture } from './runner.mjs';
import { setting } from '../../pipeline/lib/settings.mjs';
import { composeOrThrow, wait, publicCheck } from './readiness.mjs';

const read = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null);

// Every git call is bounded and retried once: an intermittent hang of `git hash-object --stdin` (dogfood C2,
// one run: 21 minutes blocked on its stdin with ~160 kB of input that hashes in 0.3 s on a retry) otherwise
// blocked the UI verifier's stack step until its 40-minute timeout.
export const GIT_TIMEOUT_MS = 120_000;
export function gitBounded(ctx, args, input, { timeout = GIT_TIMEOUT_MS, spawn = spawnSync } = {}) {
  const once = () => spawn('git', args, { cwd: ctx.root, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout, killSignal: 'SIGKILL' });
  const first = once();
  if (!first.error && first.signal == null) return first;
  log(`git ${args.slice(0, 2).join(' ')} did not finish (${first.error?.code ?? first.signal}); retrying once`);
  const second = once();
  if (second.error || second.signal != null) throw new TestStackError(`git ${args.slice(0, 2).join(' ')} did not finish twice (${second.error?.code ?? second.signal})`);
  return second;
}
const git = (ctx, args, input) => gitBounded(ctx, args, input);

/** Hash of every file under stack.build.inputs (tracked and untracked, honoring .gitignore) minus the excludes. */
export function contentHash(ctx) {
  const { inputs = ['.'], exclude = [] } = ctx.stack.build;
  const listed = git(ctx, ['ls-files', '-co', '--exclude-standard', '--', ...inputs]);
  if (listed.status !== 0) throw new TestStackError(`git ls-files failed: ${listed.stderr.trim()}`);
  const files = [...new Set(listed.stdout.split('\n').filter(Boolean))]
    .filter(file => !exclude.some(pattern => matchesInput(file, pattern)) && fs.existsSync(path.join(ctx.root, file))).sort();
  const blobs = git(ctx, ['hash-object', '--stdin-paths'], files.join('\n'));
  if (blobs.status !== 0) throw new TestStackError(`git hash-object failed: ${blobs.stderr.trim()}`);
  return git(ctx, ['hash-object', '--stdin'], files.map((file, i) => `${file}\n${blobs.stdout.split('\n')[i]}\n`).join('')).stdout.trim();
}

/** Replaces {name} placeholders of a configured command or path. */
export function expand(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole));
}

function commandVars(ctx, extra = {}) {
  const { info } = ctx;
  // {packs}: the installed language packs, so a command can run a pack's helper (node {packs}/dotnet/stack/...).
  return { slot: info.slot, project: info.project, imageTag: info.imageTag, stateDir: info.stateDir, envFile: info.envFile, composeFile: info.composeFile, packs: path.join(INSTALL_ROOT, 'packs'), ...extra };
}

/** Runs a configured shell command from the repository root; its output goes to stderr. */
export async function runCommand(ctx, template, vars = {}, what = 'command') {
  const command = expand(template, commandVars(ctx, vars));
  log(`running: ${command}`);
  const env = {
    ...ctx.env, ...Object.fromEntries(Object.entries(ctx.envValues()).filter(([key]) => !(key in ctx.env))), ...(ctx.stack.build.env ?? {}),
    TESTSTACK_SLOT: String(ctx.info.slot), TESTSTACK_PROJECT: ctx.info.project, TESTSTACK_IMAGE_TAG: ctx.info.imageTag,
    TESTSTACK_STATE_DIR: ctx.stateDir, TESTSTACK_ENV_FILE: ctx.envFile, TESTSTACK_COMPOSE_FILE: ctx.composeFile,
    // The image build's own build output (a pack's builder passes it to its compiler), so it never shares
    // intermediate files with the builds and test runs of the same checkout that may run at the same time
    // (dogfood C5: an image publish and a test build raced over one obj folder and the stack did not build).
    TESTSTACK_BUILD_ARTIFACTS: ctx.buildArtifacts ?? path.join(ctx.stateDir, 'artifacts'),
    ...(vars.baseline ? { TESTSTACK_BASELINE: '1' } : {}),
  };
  const result = await (ctx.shell ?? capture)(command, [], { cwd: ctx.root, env, shell: true, inherit: true });
  if (result.status !== 0) throw new TestStackError(`${what} failed (${result.status}): ${command}`);
}

export async function requireDocker(ctx) {
  const info = await ctx.runner.run(['info']);
  if (info.status === 127) throw new TestStackError(`'${ctx.runner.docker}' not found. Install Docker (or set TESTSTACK_DOCKER).`);
  if (info.status !== 0) throw new TestStackError(`'${ctx.runner.docker}' is installed but the daemon is not reachable.`);
}

const stripTag = ref => ref.replace(/:[^:/]*$/, '');

/**
 * The image of every built service: the value of its env variable (`image.env`, set by the build), a fixed
 * `image.name`, or compose's default name for a service it builds itself (<project>-<service>).
 */
export function imageRefs(ctx, values = ctx.envValues()) {
  return Object.entries(ctx.stack.services ?? {}).map(([service, value]) => {
    const image = serviceEntry(value).image ?? {};
    if (image.env) return { service, env: image.env, ref: values[image.env] || null };
    return { service, ref: image.name ? expand(image.name, commandVars(ctx, { service })) : `${ctx.info.project}-${service}` };
  });
}

async function imageId(ctx, ref) {
  if (!ref) return 'missing';
  const result = await ctx.runner.run(['image', 'inspect', '-f', '{{.Id}}', ref]);
  return result.status === 0 ? result.stdout.trim() : 'missing';
}

async function currentImageIds(ctx) {
  const refs = imageRefs(ctx).sort((a, b) => a.service.localeCompare(b.service));
  return (await Promise.all(refs.map(async image => `${image.ref ?? image.service} ${await imageId(ctx, image.ref)}`))).join('\n');
}

export const imagesPresent = async ctx => !(await currentImageIds(ctx)).split('\n').some(line => line.endsWith(' missing'));

/**
 * True when the slot's images are the ones this checkout built last. Slots are shared between worktrees, so
 * another worktree may have rebuilt the same tags since. Without a record this passes unless `strict`.
 */
async function imagesOurs(ctx, strict = false) {
  const recorded = read(path.join(ctx.stateDir, 'images.ids'));
  if (recorded === null) return !strict;
  return recorded === await currentImageIds(ctx);
}

async function recordImages(ctx, hash) {
  fs.mkdirSync(ctx.stateDir, { recursive: true });
  const ids = await currentImageIds(ctx);
  fs.writeFileSync(path.join(ctx.stateDir, 'images.ids'), `${ids}\n`);
  // The machine-wide record of what the pipeline built: `factory prune` removes these once superseded and unused.
  try {
    recordBuiltImages(stateHome(ctx.stack, ctx.env), ids.split('\n').map((l) => l.split(' ').pop()));
  } catch {
    /* the record is best effort; a build never fails for it */
  }
  fs.writeFileSync(path.join(ctx.stateDir, 'images.stamp'), `${hash}\n`);
}

function isAlive(pid) {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// Age of the lock folder, or null when its holder removed it meanwhile.
function lockAge(dir) {
  try {
    return Date.now() - fs.statSync(dir).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Builds may tag shared names (`<name>:latest`) before they are retagged per slot, so builds from different
 * worktrees or slots are serialized through a machine-wide lock.
 */
export async function withBuildLock(ctx, fn, { timeoutMs = 3_600_000, pollMs = 2000 } = {}) {
  const home = stateHome(ctx.stack, ctx.env);
  const dir = path.join(home, 'build.lock');
  fs.mkdirSync(home, { recursive: true });
  const started = Date.now();
  let announced = -Infinity;
  for (;;) {
    try {
      fs.mkdirSync(dir);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const holder = Number(read(path.join(dir, 'pid')));
    const alive = isAlive(holder);
    const ageMs = lockAge(dir);
    if (ageMs === null) continue;
    if (holder ? !alive : ageMs > 120_000) {
      log(`removing stale image build lock (pid ${holder || '?'} is gone)`);
      fs.rmSync(dir, { recursive: true, force: true });
      continue;
    }
    if (Date.now() - announced >= 30_000) {
      log(`waiting for another test stack image build to finish (pid ${holder || '?'}, lock ${dir})`);
      announced = Date.now();
    }
    if (Date.now() - started >= timeoutMs) throw new TestStackError(`timed out waiting for the image build lock ${dir}`);
    await sleep(pollMs);
  }
  fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
  const release = () => fs.rmSync(dir, { recursive: true, force: true });
  process.once('exit', release);
  try {
    return await fn();
  } finally {
    release();
    process.removeListener('exit', release);
  }
}

// First existing file among the candidates; the last path segment may contain * (".env.*").
function findFile(ctx, candidates, vars) {
  for (const candidate of [candidates].flat().filter(Boolean)) {
    const file = path.resolve(ctx.root, expand(candidate, commandVars(ctx, vars)));
    if (!file.includes('*')) {
      if (fs.existsSync(file)) return file;
      continue;
    }
    const dir = path.dirname(file);
    const pattern = globToRegExp(path.basename(file));
    const match = fs.existsSync(dir) ? fs.readdirSync(dir).sort().find(name => pattern.test(name) && fs.statSync(path.join(dir, name)).isFile()) : null;
    if (match) return path.join(dir, match);
  }
  return null;
}

/**
 * After a build: take over the env file the build wrote (stack.build.envFile), then give each image that is
 * named through an env variable a stable tag of this slot, so compose never resolves an unrelated ':latest'
 * and slots never share an image.
 */
async function adoptBuild(ctx, services, vars) {
  const generated = ctx.stack.build.envFile ? findFile(ctx, ctx.stack.build.envFile, vars) : null;
  if (ctx.stack.build.envFile && !generated && services === null) throw new TestStackError(`the build did not produce an env file (${[ctx.stack.build.envFile].flat().join(', ')})`);
  let values = generated && services === null ? parseEnv(fs.readFileSync(generated, 'utf8')) : ctx.envValues();
  const retagged = {};
  for (const [service, value] of Object.entries(ctx.stack.services ?? {})) {
    const image = serviceEntry(value).image ?? {};
    if (!image.env || (services && !services.includes(service))) continue;
    const name = image.name ?? (values[image.env] ? stripTag(values[image.env]) : service);
    const target = `${name}:${ctx.info.imageTag}`;
    const built = `${name}:${setting(ctx, 'stack.build.builtTag')}`;
    if (built !== target) {
      const tagged = await ctx.runner.run(['tag', built, target]);
      if (tagged.status !== 0) throw new TestStackError(`built image ${built} not found`);
    }
    retagged[image.env] = target;
  }
  values = { ...values, ...retagged };
  fs.mkdirSync(path.dirname(ctx.envFile), { recursive: true });
  fs.writeFileSync(ctx.envFile, formatEnv(values));
  ctx.syncEnv();
  const final = ctx.envValues();
  const template = ctx.stack.envTemplate ? parseEnv(fs.readFileSync(ctx.abs(ctx.stack.envTemplate), 'utf8')) : {};
  for (const key of Object.keys(template)) {
    if (!final[key]) throw new TestStackError(`${ctx.info.envFile} has no value for ${key} after the build`);
  }
}

/** Builds every image, only when the build inputs changed, an image is missing or another checkout rebuilt them. */
export async function build(ctx, { force = false } = {}) {
  const hash = contentHash(ctx);
  if (!force && read(path.join(ctx.stateDir, 'images.stamp')) === hash && await imagesPresent(ctx) && await imagesOurs(ctx)) {
    ctx.syncEnv();
    log('images up to date');
    return { built: false };
  }
  await requireDocker(ctx);
  const out = path.join(ctx.stateDir, 'build');
  await withBuildLock(ctx, async () => {
    const once = async () => {
      fs.rmSync(out, { recursive: true, force: true });
      fs.mkdirSync(out, { recursive: true });
      if (ctx.stack.build.all) await runCommand(ctx, ctx.stack.build.all, { out }, 'stack.build.all');
      else {
        log("building images with 'docker compose build'");
        await composeOrThrow(ctx, ['build'], { inherit: true });
      }
    };
    try {
      await once();
    } catch (error) {
      // Once more from a clean build output: a failure left by an earlier or concurrent build is not this change's.
      log(`the image build failed (${error.message}); building once more from a clean build folder`);
      fs.rmSync(path.join(ctx.stateDir, 'artifacts'), { recursive: true, force: true });
      try {
        await once();
      } catch (again) {
        throw new TestStackError(`${again.message}\n${await baselineVerdict(ctx)}`);
      }
    }
    await adoptBuild(ctx, null, { out });
  });
  if (!await imagesPresent(ctx)) throw new TestStackError(`images are missing after the build: ${imageRefs(ctx).map(i => i.ref ?? `${i.service} (no ${i.env})`).join(', ')}`);
  await recordImages(ctx, hash);
  return { built: true };
}

// Whether the base commit builds with the same command: tells "this change breaks the build" from "the build
// environment is broken" (dogfood C5: an agent blamed the toolchain for a failure main did not have).
// `base`: baseRef (PIPELINE_BASE_REF overrides it), from the settings' one default.
export async function baselineVerdict(ctx, { base = process.env.PIPELINE_BASE_REF || setting({}, 'baseRef'), run = runCommand } = {}) {
  if (!ctx.stack.build.all) return 'No baseline build: the stack has no stack.build.all command.';
  const g = (args) => spawnSync('git', args, { cwd: ctx.root, encoding: 'utf8', timeout: 300_000 });
  const sha = g(['merge-base', 'HEAD', base]).stdout.trim();
  if (!sha) return `No baseline build: no merge base with ${base}.`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teststack-baseline-'));
  try {
    if (g(['worktree', 'add', '--detach', dir, sha]).status !== 0) return `No baseline build: could not check out ${sha.slice(0, 7)}.`;
    const baseCtx = { ...ctx, root: dir, buildArtifacts: path.join(dir, '.teststack-artifacts') };
    try {
      await run(baseCtx, ctx.stack.build.all, { out: path.join(dir, '.teststack-out'), baseline: true }, 'baseline stack.build.all');
      return `Baseline: the same build succeeds on the base commit ${sha.slice(0, 7)}, so this change breaks the build (see the errors above).`;
    } catch (error) {
      return `Baseline: the same build also fails on the base commit ${sha.slice(0, 7)} (${error.message.split('\n')[0]}): the build environment or the base is broken, not this change.`;
    }
  } finally {
    // Cleanup never replaces the verdict (dogfood C6: an EACCES on a read-only folder of the base checkout threw
    // here, and the run reported "No baseline verdict").
    g(['worktree', 'remove', '--force', dir]);
    removeTree(dir);
  }
}

/** Removes a folder even when it holds read-only folders; never throws (a leftover is logged, not fatal). */
export function removeTree(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    try {
      spawnSync('chmod', ['-R', 'u+w', dir]);
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch (error) {
      log(`could not remove ${dir}: ${error.message}`);
      return false;
    }
  }
}

async function buildServices(ctx, services) {
  const out = path.join(ctx.stateDir, 'build-partial');
  await withBuildLock(ctx, async () => {
    const { service: first, serviceNext } = ctx.stack.build;
    if (!first) {
      log(`building ${services.join(', ')} with 'docker compose build'`);
      await composeOrThrow(ctx, ['build', ...services], { inherit: true });
    } else {
      for (const [i, service] of services.entries()) {
        await runCommand(ctx, i > 0 && serviceNext ? serviceNext : first, { service, out }, `stack.build.service (${service})`);
      }
    }
    await adoptBuild(ctx, services, { out });
  });
  await recordImages(ctx, contentHash(ctx));
}

const stackRunning = async ctx => fs.existsSync(ctx.envFile) && (await ctx.runner.compose(['ps', '-q'])).stdout.trim() !== '';

/**
 * Rebuilds only the images affected by `git diff <base>...HEAD` plus uncommitted and untracked files (and/or
 * the services named), recreates only those containers when the stack runs, then waits for readiness.
 */
export async function rebuildChanged(ctx, { base = null, only = [], timeoutSec }) {
  const started = Date.now();
  if (!base && only.length === 0) throw usage('Usage: rebuild-changed --base <git-ref> | --services <a,b>');
  const known = Object.keys(ctx.stack.services ?? {});
  let services = [];
  let changedFiles = 0;
  if (base) {
    if (git(ctx, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).status !== 0) throw usage(`unknown git ref '${base}'`);
    const lists = [['diff', '--name-only', `${base}...HEAD`], ['diff', '--name-only', 'HEAD'], ['ls-files', '-o', '--exclude-standard']];
    const files = [...new Set(lists.flatMap(args => git(ctx, args).stdout.split('\n').filter(Boolean)))].sort();
    changedFiles = files.length;
    services = (await servicesFor(files, { config: ctx.stack })).services;
  }
  for (const service of only) {
    if (!known.includes(service)) throw usage(`unknown service '${service}' (built services: ${known.join(' ')})`);
    if (!services.includes(service)) services.push(service);
  }

  let full = false;
  if (services.length) {
    await requireDocker(ctx);
    const ours = await imagesPresent(ctx) && await imagesOurs(ctx, true);
    if (!ours || services.length >= known.length) {
      // Never built here, rebuilt by another checkout since (a diff cannot describe those images), or every
      // service is affected anyway: one full build is the fastest correct option.
      log(ours ? 'every service is affected; building all images' : `slot ${ctx.info.slot} images were not built from this checkout; building all images`);
      full = true;
      await build(ctx, { force: true });
      services = known;
    } else {
      await buildServices(ctx, services);
    }
  }

  let recreated = [];
  let waited = null;
  if (services.length && await stackRunning(ctx)) {
    log(`recreating ${services.join(' ')}`);
    await composeOrThrow(ctx, ['up', '-d', '--no-deps', ...services], { inherit: true });
    recreated = services;
    const { ready, checks, healed } = await wait(ctx, timeoutSec);
    waited = { ok: ready, command: 'wait', restarted: healed, failing: checks.filter(c => !c.ok).map(publicCheck) };
  }
  return {
    ok: waited?.ok ?? true, command: 'rebuild-changed', base, changedFiles, services, full, recreated,
    ...(waited ? { wait: waited } : {}), elapsedMs: Date.now() - started,
  };
}

// The lines only in the committed file (-) and only in the fresh one (+), at most 40 of them.
function lineDiff(committed, fresh) {
  const a = committed.split('\n');
  const b = fresh.split('\n');
  const inB = new Set(b);
  const inA = new Set(a);
  const lines = [...a.filter(l => !inB.has(l)).map(l => `  - ${l}`), ...b.filter(l => !inA.has(l)).map(l => `  + ${l}`)];
  if (!lines.length) return '  (same lines, different order)';
  return lines.slice(0, 40).join('\n') + (lines.length > 40 ? `\n  ... ${lines.length - 40} more` : '');
}

function filesUnder(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    (entry.isDirectory() ? filesUnder(path.join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]));
}

/**
 * Regenerates the compose file with stack.publish ({out} is the output folder, by default the compose file's).
 * --check runs stack.publishCheck when set; otherwise it publishes to a temporary folder and fails when a
 * generated file differs from the committed one.
 */
export async function publish(ctx, { check = false }) {
  const target = path.dirname(ctx.composeFile);
  if (check && ctx.stack.publishCheck) {
    await runCommand(ctx, ctx.stack.publishCheck, { out: target }, 'stack.publishCheck');
    return { ok: true, command: 'publish', check: 'clean' };
  }
  if (!ctx.stack.publish) throw new TestStackError('stack.publish is not configured: this repository keeps its compose file by hand.', EXIT.usage);
  if (!check) {
    await runCommand(ctx, ctx.stack.publish, { out: target }, 'stack.publish');
    return { ok: true, command: 'publish', output: path.relative(ctx.root, target) || '.' };
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'teststack-publish-'));
  try {
    await runCommand(ctx, ctx.stack.publish, { out: temp }, 'stack.publish');
    const drift = filesUnder(temp).filter(file => read(path.join(temp, file)) !== read(path.join(target, file)));
    if (drift.length) {
      const details = drift.map(file => `${file}:\n${lineDiff(read(path.join(target, file)) ?? '', read(path.join(temp, file)))}`).join('\n');
      throw new TestStackError(`${path.relative(ctx.root, target)} is out of date (${drift.join(', ')}): what the application publishes now differs from the committed file.\n${details}\nRun 'factory teststack publish' and commit the result (after checking the change is intended).`);
    }
    return { ok: true, command: 'publish', check: 'clean' };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
