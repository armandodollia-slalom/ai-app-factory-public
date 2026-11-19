// Story guard (PreToolUse): agents stay out of the ticket cache (.factory/state/board/, and the legacy
// story folder while it exists; config.storyGuard.folders) except for what was handed to the pipeline:
// the active story's cache folder (`pipeline start`: its story.md and its own mockups) and the tickets
// given to `pipeline implement run` (PIPELINE_STORY_SOURCES: cache folders or ticket keys, inherited by
// every agent it starts).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INSTALL_ROOT } from './config.mjs';
import { activeStoryFile } from './stories.mjs';

const TICKET_KEY = /^([A-Z][A-Z0-9]*-\d+|(?:epic|spike)-[\w-]+)$/;

const PATH_KEYS = ['file_path', 'path', 'notebook_path', 'absolute_path', 'dir_path', 'directory', 'glob'];
const isSearch = (tool) => /grep|search/i.test(tool ?? '');
const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
// The fixed part of a glob, e.g. .factory/state/board/*/story.md -> .factory/state/board.
const staticPrefix = (p) => p.split(/[*?[{]/)[0].replace(/\/+$/, '') || '.';

const cacheOf = (config) => (config.tickets?.dir ?? '.factory/state/board').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

// The ticket a path points into, in any checkout's ticket cache (this one, the main checkout, a story or
// subtask worktree): the key, '' for the cache folder itself, or null when the path is not in a cache.
export function ticketOf(p, cache) {
  const parts = p.split(/[\\/]+/);
  const c = cache.split('/');
  for (let i = 0; i + c.length <= parts.length; i++) if (c.every((seg, j) => parts[i + j] === seg)) return parts[i + c.length] ?? '';
  return null;
}

// What was handed to the pipeline: ticket keys (a key, or a ticket folder in any checkout's cache; both
// mean that ticket wherever it is cached, so a worktree's copy of a handed ticket opens too) and other
// folders or files (legacy story files).
export function handedSources(config, env = process.env) {
  const cache = cacheOf(config);
  const keys = new Set();
  const dirs = [];
  const add = (p) => {
    if (TICKET_KEY.test(p)) return keys.add(p);
    const abs = path.resolve(config.root, p);
    const key = ticketOf(abs, cache);
    if (key && TICKET_KEY.test(key)) keys.add(key);
    else dirs.push(abs);
  };
  for (const p of (env.PIPELINE_STORY_SOURCES ?? '').split(path.delimiter).filter(Boolean)) add(p);
  const active = activeStoryFile(config);
  if (active) add(path.dirname(config.abs(active)));
  return { keys, dirs };
}

// Folders the agents may use: every handed ticket's folder in this checkout's cache, plus other handed paths.
export function allowedSources(config, env = process.env) {
  const { keys, dirs } = handedSources(config, env);
  return [...[...keys].map((k) => path.join(config.root, cacheOf(config), k)), ...dirs];
}

// Paths a tool call touches, resolved against cwd. Shell commands contribute every token that names a
// guarded folder; anything else in a command is not a story path.
export function touchedPaths(payload, folders) {
  const input = payload.tool_input ?? {};
  const cwd = payload.cwd || process.cwd();
  const raw = [];
  for (const key of PATH_KEYS) if (typeof input[key] === 'string') raw.push(input[key]);
  for (const key of ['paths', 'file_paths']) if (Array.isArray(input[key])) raw.push(...input[key].filter((p) => typeof p === 'string'));
  if (typeof input.pattern === 'string' && !isSearch(payload.tool_name)) raw.push(input.pattern);
  if (Array.isArray(input.edits)) for (const e of input.edits) if (typeof e?.file_path === 'string') raw.push(e.file_path);
  const command = typeof input.command === 'string' ? input.command : Array.isArray(input.command) ? input.command.join(' ') : null;
  if (command) {
    const names = folders.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    for (const m of command.matchAll(new RegExp(`[^\\s'"\`;|&<>()]*(?:${names})[^\\s'"\`;|&<>()]*`, 'g'))) raw.push(m[0]);
  }
  return raw.map((p) => path.resolve(cwd, staticPrefix(p.replace(/^~(?=\/)/, process.env.HOME ?? '~'))));
}

// Returns a denial reason, or null when the call may proceed. A path in a ticket cache (of any checkout)
// is allowed only inside a handed ticket's folder: its story and its own mockups (and for an epic run the
// epic's). The path and, when it exists, its real path must both pass, so a symlink cannot reach another
// ticket.
export function storyGuard(config, payload, env = process.env) {
  const folders = config.storyGuard?.folders ?? [];
  if (config.storyGuard?.enabled === false || !folders.length) return null;
  const cache = cacheOf(config);
  const cacheGuarded = folders.some((f) => f.replace(/\/+$/, '').replace(/^\.\//, '') === cache);
  const guarded = folders.map((f) => config.abs(f));
  const { keys, dirs } = handedSources(config, env);
  const offLimits = (q) => {
    const key = cacheGuarded ? ticketOf(q, cache) : null;
    if (key !== null) return !keys.has(key);
    return guarded.some((g) => inside(q, g)) && !dirs.some((a) => inside(q, a));
  };
  const blocked = touchedPaths(payload, folders).filter((p) => offLimits(p) || (fs.existsSync(p) && offLimits(fs.realpathSync(p))));
  if (!blocked.length) return null;
  const allowed = allowedSources(config, env);
  const rel = [...new Set(blocked.map((p) => path.relative(config.root, p) || '.'))].join(', ');
  const scope = allowed.length ? ` Only ${allowed.map((a) => path.relative(config.root, a) || '.').join(', ')} may be used.` : ' No story was handed to the pipeline.';
  return `Story guard: ${rel} is off limits. Agents do not read, search or edit the ticket cache or story folders (${folders.join(', ')}) except for the tickets handed to the pipeline (\`pipeline start <KEY>\` or \`pipeline implement run <KEY...>\`).${scope}`;
}

export const denyOutput = (reason) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
});

// Install guard (dogfood C4): the factory install held the reference's notes on bugs a pipeline agent might be
// asked to fix. Those are gone from the package, and a pipeline agent (PIPELINE_CHILD=1) does not read, search
// or edit the factory install at all: it runs the factory's commands. A shell command may name an install path
// only to run it: `factory ...`, `node <install>/bin/factory.mjs`, `node <install>/packs/.../*.mjs` (the
// configured linters and fixers) or `<install>/node_modules/.bin/<tool>`.
export function installGuard(config, payload, env = process.env, installRoot = INSTALL_ROOT) {
  if (env.PIPELINE_CHILD !== '1' || config.storyGuard?.installReadable === true) return null;
  const home = os.homedir();
  // Folders a pipeline agent never reads (dogfood C5 audit): the factory install; agent CLI session stores (other
  // agents' transcripts, which analyse other tickets); paths the operator lists (FACTORY_GUARD_DENY, ':'-separated)
  // or the repository configures (storyGuard.denyPaths).
  const roots = [...new Set([
    installRoot, path.join(home, '.ai-app-factory'),
    ...listDir(home).filter((n) => /^\.claude/.test(n)).map((n) => path.join(home, n, 'projects')),
    path.join(home, '.codex', 'sessions'), path.join(home, '.gemini'),
    ...String(env.FACTORY_GUARD_DENY ?? '').split(':').filter(Boolean),
    ...(config.storyGuard?.denyPaths ?? []),
  ].map((r) => path.resolve(r)))];
  const ownRoot = path.resolve(config.mainRoot ?? config.root);
  // The factory working on itself: its own checkout is the install.
  if (inside(path.resolve(config.root), path.resolve(installRoot)) || inside(path.resolve(installRoot), path.resolve(config.root))) return null;
  const ownCommon = commonDir(config.root);
  const input = payload.tool_input ?? {};
  const cwd = payload.cwd || process.cwd();
  const abs = (p) => path.resolve(cwd, String(p).replace(/^~(?=\/)/, home));
  // Another git repository (another checkout on the machine, such as a reference implementation) is off limits
  // too: an agent reads this repository, its worktrees and what it needs to run, nothing else.
  const otherRepo = (p) => {
    const c = commonDir(p);
    return Boolean(c) && Boolean(ownCommon) && c !== ownCommon;
  };
  // The agent's own CLI session folder (D-C7-2): the CLI saves long tool output there (`~/.claude*/projects/<cwd>/...`,
  // or a temp folder `claude-<uid>/<cwd>/...`) and the agent reads it back. The folder is named after the agent's
  // working directory, so another checkout's sessions stay closed.
  const escaped = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
  const ownSession = (a) => {
    const at = a.indexOf(`${path.sep}${escaped}${path.sep}`);
    if (at < 0 && !a.endsWith(`${path.sep}${escaped}`)) return false;
    const parent = a.slice(0, at < 0 ? a.length - escaped.length - 1 : at);
    return roots.some((r) => parent === r) || /(^|\/)claude-\d+$/.test(parent);
  };
  const off = (p) => {
    const a = abs(p);
    const real = fs.existsSync(a) ? fs.realpathSync(a) : a;
    if (inside(a, ownRoot)) return false;
    if (ownSession(a) || ownSession(real)) return false;
    return roots.some((r) => inside(a, r) || inside(real, r)) || otherRepo(a);
  };
  const blocked = [];
  for (const key of PATH_KEYS) if (typeof input[key] === 'string' && off(staticPrefix(input[key]))) blocked.push(input[key]);
  for (const key of ['paths', 'file_paths']) if (Array.isArray(input[key])) blocked.push(...input[key].filter((p) => typeof p === 'string' && off(p)));
  if (Array.isArray(input.edits)) for (const e of input.edits) if (typeof e?.file_path === 'string' && off(e.file_path)) blocked.push(e.file_path);
  const command = typeof input.command === 'string' ? input.command : Array.isArray(input.command) ? input.command.join(' ') : null;
  if (command) {
    const runnable = /(?:^|\/)(?:bin\/factory(?:\.mjs)?|packs\/[^\s'"]+\.mjs|node_modules\/\.bin\/[^\s'"/]+)$/;
    const tokens = command.split(/[\s;|&<>()=]+/).map((t) => t.replace(/^['"`]+|['"`]+$/g, '')).filter(Boolean);
    tokens.forEach((t, i) => {
      if (!/^(~\/|\/|\.\.\/|\.\.$)/.test(t) || !off(t)) return;
      const executed = i === 0 || tokens[i - 1] === 'node' || /\/node$/.test(tokens[i - 1]);
      if (executed && inside(abs(t), path.resolve(installRoot)) && runnable.test(t)) return;
      blocked.push(t);
    });
  }
  if (!blocked.length) return null;
  return `Read guard: ${[...new Set(blocked)].join(', ')} is outside what pipeline agents may read (the factory install, other agents' session stores, other repositories on the machine, or a denied path). Work from this repository's own files, and run the factory's commands with \`factory <command>\`.`;
}

const listDir = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

// The git common dir of the repository a path is in (walking up to the nearest .git), or null.
const commonCache = new Map();
function commonDir(p) {
  let dir = path.resolve(p);
  while (!fs.existsSync(dir) && dir !== path.dirname(dir)) dir = path.dirname(dir);
  if (commonCache.has(dir)) return commonCache.get(dir);
  let found = null;
  for (let d = dir; ; d = path.dirname(d)) {
    const g = path.join(d, '.git');
    if (fs.existsSync(g)) {
      if (fs.statSync(g).isDirectory()) found = fs.realpathSync(g);
      else {
        const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(g, 'utf8'));
        if (m) {
          const gitdir = path.resolve(d, m[1].trim());
          found = fs.existsSync(gitdir) ? fs.realpathSync(/\/worktrees\/[^/]+$/.test(gitdir) ? path.dirname(path.dirname(gitdir)) : gitdir) : null;
        }
      }
      break;
    }
    if (d === path.dirname(d)) break;
  }
  commonCache.set(dir, found);
  return found;
}

// Network guard (council C3): the read guard covered files only, while the reference implementation is a public
// GitHub repository an agent could read with `gh`, `git`, curl or a web fetch. A pipeline agent (PIPELINE_CHILD=1)
// reaches GitHub only for this repository (`board.repo`, else the origin remote). Everything else on GitHub is
// denied: `gh` aimed at another repository, `gh search` (all of GitHub), `git clone|fetch|pull|ls-remote` of
// another repository, a web request or fetch to another repository's GitHub URLs, and web searches that name a
// denied repository. Hosts listed in `storyGuard.denyHosts` (or FACTORY_GUARD_DENY_HOSTS, ':'-separated) are denied
// outright; `storyGuard.denyRepos` (or FACTORY_GUARD_DENY_REPOS) names repositories a web search may not mention.
const GITHUB_HOSTS = /^(?:www\.)?(?:github\.com|api\.github\.com|raw\.githubusercontent\.com|codeload\.github\.com|objects\.githubusercontent\.com)$/i;

export function projectRepo(config) {
  const fromConfig = config.board?.repo ?? config.tickets?.repo ?? null;
  if (fromConfig) return String(fromConfig).toLowerCase();
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: config.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 }).trim();
    return /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/i.exec(url)?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

// The owner/repo a GitHub URL points at, or null (github.com/o/r/..., api.github.com/repos/o/r/...,
// raw.githubusercontent.com/o/r/..., git@github.com:o/r.git).
export function repoOfUrl(text) {
  const s = String(text).trim();
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(s);
  if (ssh) return `${ssh[1]}/${ssh[2]}`.toLowerCase();
  let u;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (!GITHUB_HOSTS.test(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  const [a, b] = /^api\./i.test(u.hostname) && parts[0] === 'repos' ? parts.slice(1) : parts;
  return a && b ? `${a}/${b.replace(/\.git$/, '')}`.toLowerCase() : null;
}

export function networkGuard(config, payload, env = process.env) {
  if (env.PIPELINE_CHILD !== '1' || config.storyGuard?.networkOpen === true) return null;
  const own = projectRepo(config);
  const denyHosts = [...String(env.FACTORY_GUARD_DENY_HOSTS ?? '').split(':'), ...(config.storyGuard?.denyHosts ?? [])].filter(Boolean).map((h) => h.toLowerCase());
  const denyRepos = [...String(env.FACTORY_GUARD_DENY_REPOS ?? '').split(/[:,\s]+/), ...(config.storyGuard?.denyRepos ?? [])].filter(Boolean).map((r) => r.toLowerCase());
  const tool = String(payload.tool_name ?? '');
  const input = payload.tool_input ?? {};
  const other = (repo) => Boolean(repo) && repo !== own;
  const hostDenied = (url) => {
    try {
      const h = new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase();
      return denyHosts.some((d) => h === d || h.endsWith(`.${d}`));
    } catch {
      return false;
    }
  };
  const reasons = [];
  const checkUrl = (u) => {
    if (hostDenied(u)) reasons.push(`${u} (a denied host)`);
    else if (other(repoOfUrl(u))) reasons.push(`${u} (another repository on GitHub)`);
  };
  if (/^(WebFetch|Fetch|fetch)$/.test(tool) && typeof input.url === 'string') checkUrl(input.url);
  if (/^(WebSearch|web_search)$/.test(tool)) {
    const q = String(input.query ?? '').toLowerCase();
    for (const r of denyRepos) if (q.includes(r) || q.includes(r.split('/').pop())) reasons.push(`a web search for ${r} (a denied repository)`);
    for (const m of q.matchAll(/github\.com\/[\w.-]+\/[\w.-]+/g)) if (other(repoOfUrl(m[0]))) reasons.push(`a web search for ${m[0]} (another repository on GitHub)`);
  }
  const command = typeof input.command === 'string' ? input.command : Array.isArray(input.command) ? input.command.join(' ') : null;
  if (command) {
    for (const m of command.matchAll(/(?:https?:\/\/|git@)[^\s'"`<>|;&)]+|\b(?:github\.com|raw\.githubusercontent\.com|api\.github\.com)\/[^\s'"`<>|;&)]+/gi)) checkUrl(m[0]);
    // `gh` subcommands, per segment of a pipeline or a command list.
    for (const seg of command.split(/&&|\|\||[;|\n]/)) {
      const t = seg.trim().split(/\s+/).map((x) => x.replace(/^['"]|['"]$/g, ''));
      const gi = t.findIndex((x) => x === 'gh' || /\/gh$/.test(x));
      if (gi < 0) continue;
      const args = t.slice(gi + 1);
      if (args[0] === 'search') reasons.push('`gh search` (it searches all of GitHub)');
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        const val = a === '-R' || a === '--repo' ? args[i + 1] : a.startsWith('--repo=') ? a.slice(7) : null;
        if (val && other(val.toLowerCase().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, ''))) reasons.push(`gh ${args[0]} on ${val} (another repository)`);
      }
      if (args[0] === 'repo' && ['view', 'clone', 'fork'].includes(args[1]) && args[2] && !args[2].startsWith('-') && other(args[2].toLowerCase())) reasons.push(`gh repo ${args[1]} ${args[2]} (another repository)`);
      if (args[0] === 'api') {
        const rest = args.slice(1).join(' ');
        for (const m of rest.matchAll(/(?:^|[\s/])repos\/([\w.-]+)\/([\w.-]+)/g)) if (other(`${m[1]}/${m[2]}`.toLowerCase())) reasons.push(`gh api repos/${m[1]}/${m[2]} (another repository)`);
        for (const m of rest.matchAll(/repository\s*\(\s*owner\s*:\s*\\?"([^"\\]+)\\?"\s*,\s*name\s*:\s*\\?"([^"\\]+)\\?"/g)) if (other(`${m[1]}/${m[2]}`.toLowerCase())) reasons.push(`a GraphQL query for ${m[1]}/${m[2]} (another repository)`);
        for (const m of rest.matchAll(/\b(?:search\/(?:code|repositories|issues|commits))\b/g)) reasons.push(`gh api ${m[0]} (it searches all of GitHub)`);
      }
    }
    // git commands that reach another remote by its URL are caught above; `git clone <owner>/<repo>` shorthand is not a git form.
  }
  if (!reasons.length) return null;
  return `Network guard: ${[...new Set(reasons)].join('; ')} is outside what pipeline agents may reach. Work from this repository (${own ?? 'its own GitHub repository'}) and its files only.`;
}

// Ticket guard (council C3, D-C7-1): the ticket text in the cache is the contract the test plan is stamped against and
// that CI's `fv check` reads back from the issue. A PR check agent (the fixer answering a finding) wrote an
// Implementation Notes line into one worktree's copy; the plan was re-stamped from it, the other copy was published,
// and CI found the plan stale. Only the implementer writes the ticket (its Implementation Notes); a PR check agent
// says what it could not fix in its result instead.
const WRITE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|str_replace_editor|apply_patch|write_file|edit_file)$/;
export function ticketWriteGuard(config, payload, env = process.env) {
  if (env.PIPELINE_CHILD !== '1') return null;
  const agent = String(env.PIPELINE_AGENT_NAME ?? '');
  if (!/^pr-check/.test(agent)) return null;
  const dir = String(config.tickets?.dir ?? path.join(config.stateDir ?? '.factory/state', 'board')).replace(/\/$/, '');
  const cwd = payload.cwd || process.cwd();
  const inCache = (p) => {
    const rel = path.relative(path.resolve(config.root), path.resolve(cwd, String(p)));
    return rel === dir || rel.startsWith(`${dir}/`);
  };
  const input = payload.tool_input ?? {};
  const tool = String(payload.tool_name ?? '');
  const targets = [];
  if (WRITE_TOOLS.test(tool)) for (const key of ['file_path', 'path', 'notebook_path']) if (typeof input[key] === 'string' && inCache(input[key])) targets.push(input[key]);
  if (Array.isArray(input.edits)) for (const e of input.edits) if (typeof e?.file_path === 'string' && inCache(e.file_path)) targets.push(e.file_path);
  const command = typeof input.command === 'string' ? input.command : null;
  if (command && command.includes(dir) && /(>>?|\btee\b|\bsed\s+-i|\bmv\b|\bcp\b|\brm\b|\bperl\s+-[a-z]*i)/.test(command)) targets.push(dir);
  if (!targets.length) return null;
  return `Ticket guard: ${[...new Set(targets)].join(', ')} is the story as written; the test plan is checked against it in CI. A PR check agent does not change it. Put what you could not fix, or a note for the reviewer, in your result (notFixed / summary).`;
}

// Council C4: a PR check fixer rewrote two other stories' verified e2e specs to make its own fix pass; the CI parity
// run caught it and a later round reverted it, at the cost of extra rounds. The fixer may change the tests of the
// stories it checks (PIPELINE_STORY_KEYS), never another story's: a test file named after another ticket, or a test
// whose case id (`TC-<KEY>-`) belongs to another ticket. It reports the need in notFixed instead, for a person.
const TEST_FILE = /(^|\/)(e2e|tests?|[^/]*\.Tests?)\/|\.(spec|test)\.[cm]?[jt]sx?$|Tests?\.cs$/i;
const keyRe = /\b([A-Za-z][A-Za-z0-9]*)-(\d+)\b/g;
const caseIds = (text) => [...String(text ?? '').matchAll(/\bTC-([A-Za-z][A-Za-z0-9]*-\d+)-/gi)].map((m) => m[1].toUpperCase());

export function foreignTestGuard(config, payload, env = process.env) {
  if (env.PIPELINE_CHILD !== '1' || !/^pr-check-fixer/.test(String(env.PIPELINE_AGENT_NAME ?? ''))) return null;
  const mine = new Set(String(env.PIPELINE_STORY_KEYS ?? '').split(',').map((k) => k.trim().toUpperCase()).filter(Boolean));
  if (!mine.size) return null;
  const cwd = payload.cwd || process.cwd();
  const input = payload.tool_input ?? {};
  const tool = String(payload.tool_name ?? '');
  const foreign = new Set();
  const fileKeys = (p) => [...path.basename(String(p)).matchAll(keyRe)].map((m) => `${m[1]}-${m[2]}`.toUpperCase());
  const consider = (p, removed) => {
    if (typeof p !== 'string') return;
    const rel = path.relative(path.resolve(config.root), path.resolve(cwd, p)).replace(/\\/g, '/');
    if (!TEST_FILE.test(rel)) return;
    for (const k of fileKeys(rel)) if (!mine.has(k)) foreign.add(`${rel} (${k})`);
    for (const k of caseIds(removed)) if (!mine.has(k)) foreign.add(`${rel} (TC-${k}-)`);
  };
  if (WRITE_TOOLS.test(tool)) {
    const file = input.file_path ?? input.path ?? input.notebook_path;
    let removed = input.old_string ?? '';
    // A whole-file write removes every line of the old file it does not keep.
    if (tool === 'Write' && typeof file === 'string') {
      const abs = path.resolve(cwd, file);
      if (fs.existsSync(abs)) {
        const kept = new Set(String(input.content ?? '').split('\n'));
        removed = fs.readFileSync(abs, 'utf8').split('\n').filter((l) => !kept.has(l)).join('\n');
      }
    }
    consider(file, removed);
    for (const e of Array.isArray(input.edits) ? input.edits : []) consider(e?.file_path ?? file, e?.old_string ?? '');
  }
  if (!foreign.size) return null;
  return `Test guard: ${[...foreign].join(', ')} is another story's verified test. The PR check fixer changes only the tests of ${[...mine].join(', ')}. If your fix cannot pass without changing it, leave it as it is and put the finding in notFixed with the reason; a person decides.`;
}

// D-C8-4: under `implement run` every agent that needs a stack is given a leased slot (TESTSTACK_SLOT); slot 0 is
// shared by every checkout, so concurrent runs that build or test it collide (two PR check fixers built slot 0 from
// their own worktrees within 30 minutes). An agent without a slot may not run the e2e specs or change a stack, and no
// agent may point them at slot 0. The teststack CLI refuses slot 0 to agents too (teststack.mjs slotZeroRefusal).
const STACK_COMMAND = /\bplaywright\s+test\b|\bteststack(?:\.mjs)?\s+(?:--\S+\s+\S+\s+)*(?:up|load|down|build|rebuild-changed|reset)\b/;
export function stackGuard(config, payload, env = process.env) {
  if (env.PIPELINE_CHILD !== '1' || !env.PIPELINE_AGENT_NAME) return null;
  const slotsOn = (Number(env.IMPLEMENT_PARALLEL ?? 0) >= 1 || env.FV_USE_SLOTS === '1') && env.FV_USE_SLOTS !== '0';
  if (!slotsOn || String(payload.tool_name ?? '') !== 'Bash') return null;
  const command = String(payload.tool_input?.command ?? '');
  if (!STACK_COMMAND.test(command)) return null;
  const slot0 = /\bTESTSTACK_SLOT=0\b|--slot[=\s]+0\b/.test(command);
  if (!slot0 && env.TESTSTACK_SLOT && env.TESTSTACK_SLOT !== '0') return null;
  return `Stack guard: ${slot0 ? 'slot 0' : 'this agent has no leased test-stack slot, and slot 0'} is shared by every checkout under \`implement run\`; e2e specs and stack commands run only on a leased slot. ${env.TESTSTACK_SLOT ? `Use your slot (TESTSTACK_SLOT=${env.TESTSTACK_SLOT}).` : 'Feature verification runs them on a leased slot after your change; report what needs checking there.'}`;
}
