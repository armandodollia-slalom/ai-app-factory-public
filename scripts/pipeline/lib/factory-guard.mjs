// Factory guard (PreToolUse): the agents the pipeline starts change the application, not the factory.
// Files the factory owns in the app repository (.factory/ settings, agent addenda, lessons, policy, and
// every file `factory render` generated, listed in .factory/manifest.json) may be edited only by the
// agents named in `factoryGuard.writers` (the retro). People and interactive sessions are not bound:
// the guard applies to pipeline children (PIPELINE_CHILD=1) only, and PIPELINE_DISABLE=1 lifts it.
//
// It covers the file-editing tools and shell commands that write a protected path (redirections, tee,
// sed -i, cp/mv/rm/touch/..., git checkout/restore/apply/rm/mv, interpreters handed a protected path). A
// shell can always hide a write (a script file, a variable); for that the engine snapshots the protected
// files around every pipeline agent run (protectedSnapshot / enforceProtected): a run that changed them
// is reverted and fails. `factory check` (CI) is the last line for generated files.
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { APP_FILE, appSettingsProblems, OVERLAY_FILE } from './config.mjs';
import { manifestDirs, readProfile } from './policy-topology.mjs';
import { touchedPaths } from './story-guard.mjs';
import { resolveAnalysis } from './analysis/config.mjs';
import { defaultSettings } from './settings.mjs';

export const PROTECTED_DEFAULT = defaultSettings().factoryGuard.protected;
export const WRITERS_DEFAULT = defaultSettings().factoryGuard.writers;
const WRITE_TOOL = /^(edit|write|multiedit|notebookedit|apply_patch|write_file|replace|create_file|str_replace_editor)$/i;
const SHELL_TOOL = /^(bash|shell|run_shell_command|execute_command|run_in_terminal|terminal|exec|local_shell|powershell)$/i;

// Shell words, quotes removed (good enough to find path arguments; not a full shell parser).
const words = (segment) => [...segment.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
const WRITE_VERBS = new Set(['cp', 'mv', 'rm', 'rmdir', 'touch', 'truncate', 'ln', 'install', 'chmod', 'chown', 'mkdir', 'rsync', 'unlink', 'shred']);
const INTERPRETERS = /^(python3?|node|ruby|perl|pwsh|powershell|sh|bash|zsh|php)$/;

// Paths a shell command may write: redirection targets, tee arguments, the path arguments of write
// commands and in-place editors, git commands that rewrite files, and any path handed to an interpreter
// together with inline code (python -c, node -e, perl -pi -e ...).
// Returned as absolute paths: relative ones resolve against `cwd`, following `cd` / `pushd` in the command.
// Inline code that writes or deletes files, in the interpreters agents use.
const WRITE_API = /writeFile|appendFile|unlink|rmSync|rmdir|\brm\(|rename|copyFile|createWriteStream|truncate|open\([^)]*['"][wax]\+?b?['"]|os\.remove|shutil\.|\.write_(text|bytes)|File\.(Write|Delete|Move|Copy|Append)|Remove-Item|Set-Content|Out-File/;
// git commands that rewrite the working tree; without a path they reach every file, the factory's too.
const GIT_WRITES = /^(checkout|restore|apply|rm|mv|reset|clean|stash|am|cherry-pick|revert|merge|pull|rebase|switch)$/;

// Command segments split at ; && || | and newlines outside quotes, each with the separator before it
// (`|` marks a command that reads the previous one's output).
function shellSegments(command) {
  const out = [];
  let cur = '';
  let sep = null;
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === '\\' && quote === '"') {
        cur += c + (command[++i] ?? '');
        continue;
      }
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    if (c === '\n' || c === ';' || c === '|' || (c === '&' && command[i + 1] === '&')) {
      out.push({ text: cur, sep });
      cur = '';
      sep = c === '|' && command[i + 1] !== '|' ? '|' : c;
      if ((c === '|' && command[i + 1] === '|') || c === '&') i++;
      continue;
    }
    cur += c;
  }
  out.push({ text: cur, sep });
  return out;
}

// The quoted contents of inline code with shell escapes undone (\" becomes ").
const unescape = (text) => text.replace(/\\(.)/g, '$1');

// What inline code writes: the literal path arguments of its write calls, or '.' (the whole checkout) when
// a target is computed (concatenation, a variable, an f-string), so the guard cannot tell what it touches.
const LITERAL = "(?:'([^'\\\\]*)'|\"([^\"\\\\]*)\"|`([^`$\\\\]*)`)";
const WRITE_CALL = new RegExp(String.raw`(?:writeFileSync|writeFile|appendFileSync|appendFile|unlinkSync|unlink|rmSync|rmdirSync|rmdir|renameSync|rename|copyFileSync|copyFile|cpSync|createWriteStream|truncateSync|truncate|os\.remove|os\.unlink|os\.rename|os\.replace|shutil\.\w+|File\.(?:Write\w*|Delete|Move|Copy|Append\w*)|Remove-Item|Set-Content|Out-File)\s*\(?\s*`, 'g');
export function inlineWriteTargets(code) {
  const text = unescape(code);
  if (!WRITE_API.test(text)) return [];
  const targets = [];
  let computed = false;
  const literalAt = (i) => new RegExp(String.raw`^${LITERAL}\s*(?=[,)]|$)`).exec(text.slice(i));
  for (const m of text.matchAll(WRITE_CALL)) {
    const lit = literalAt(m.index + m[0].length);
    if (lit) targets.push(lit[1] ?? lit[2] ?? lit[3]);
    else computed = true;
  }
  for (const m of text.matchAll(/\bopen\(\s*/g)) {
    const after = text.slice(m.index + m[0].length);
    if (!/^[^)]*,\s*['"][wax]\+?b?['"]/.test(after)) continue;
    const lit = literalAt(m.index + m[0].length);
    if (lit) targets.push(lit[1] ?? lit[2] ?? lit[3]);
    else computed = true;
  }
  for (const m of text.matchAll(/\bPath\(\s*/g)) {
    const lit = literalAt(m.index + m[0].length);
    if (!/^[^\n]*?\)\s*\.(write_text|write_bytes|unlink|rename|replace|rmdir|touch)\(/.test(text.slice(m.index))) continue;
    if (lit) targets.push(lit[1] ?? lit[2] ?? lit[3]);
    else computed = true;
  }
  // A write API the patterns above did not place (another call shape): unknown target.
  if (!targets.length && !computed) computed = true;
  return computed ? ['.', ...targets] : targets;
}

// The files a patch changes (`+++ b/path`, `--- a/path`, renames), or null when it cannot be read.
function patchTargets(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const out = new Set();
  for (const m of text.matchAll(/^(?:\+\+\+|---) (?:[ab]\/)?(\S+)|^rename (?:from|to) (\S+)|^diff --git a\/(\S+) b\/(\S+)/gm)) for (const p of [m[1], m[2], m[3], m[4]]) if (p && p !== '/dev/null') out.add(p);
  return [...out];
}

// The entries of an archive (tar or zip), or null when it cannot be listed.
function archiveEntries(verb, archive, cwd) {
  const r = verb === 'unzip' ? spawnSync('unzip', ['-Z1', archive], { cwd, encoding: 'utf8', timeout: 10000 }) : spawnSync('tar', ['-tf', archive], { cwd, encoding: 'utf8', timeout: 10000 });
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : null;
}

// A command's operands without its redirections (`< file`, `<<'EOF'`, `> out`) and their targets: a script
// argument means stdin is data; none (or `-`) means stdin is code.
function operands(w) {
  const out = [];
  for (let i = 1; i < w.length; i++) {
    const a = w[i];
    if (/^\d*(<<<|<<-?|<|>>|>|&>)$/.test(a)) {
      i += 1;
      continue;
    }
    if (/^\d*(<|>)/.test(a)) continue;
    out.push(a);
  }
  return out;
}

// The files `sed -i` / `perl -pi` edit: not the script, not the backup suffix (BSD `sed -i ''`, GNU `-i.bak`),
// not what -e / -f / --expression take.
function inPlaceTargets(w) {
  const files = [];
  let script = w.some((a) => /^(-e|-f|--expression|--file)$|^-[a-zA-Z]*e$/.test(a)) || w[0].endsWith('perl') ? null : undefined;
  for (let i = 1; i < w.length; i++) {
    const a = w[i];
    if (a === '-i' && w[0].endsWith('sed') && w[i + 1] === '') {
      i += 1; // BSD: -i '' (no backup)
      continue;
    }
    if (/^(-e|-f|--expression|--file)$/.test(a) || /^-[a-zA-Z]*e$/.test(a)) {
      i += 1;
      continue;
    }
    if (a.startsWith('-') || a === '') continue;
    if (script === undefined) {
      script = a; // sed's first operand is its script
      continue;
    }
    files.push(a);
  }
  return files;
}

// The characters between quotes replaced by '_' (the quotes kept), so operators inside a quoted argument are not
// read as shell syntax; positions are unchanged.
export function maskQuoted(text) {
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < text.length) {
        out += '__';
        i++;
        continue;
      }
      if (c === quote) quote = null;
      out += c === quote || quote === null ? c : '_';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    out += c;
  }
  return out;
}

// A heredoc's body is data for the command, not commands: drop it (keeping the line with `<<WORD`), so a line of
// Markdown with `->` or `<x>` in an appended note is not read as a redirection (dogfood C2: the implementer's
// Implementation Notes, appended with cat >> story.md <<'EOF', were refused as a write to the whole checkout).
export function dropHeredocBodies(command) {
  const lines = command.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const m = /<<(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/.exec(lines[i]);
    // Only a `<<` outside quotes starts a heredoc (masking keeps positions).
    if (!m || /^\s*#/.test(lines[i]) || maskQuoted(lines[i])[m.index] !== '<') continue;
    const end = m[3];
    let j = i + 1;
    while (j < lines.length && (m[1] ? lines[j].replace(/^\t+/, '') : lines[j]) !== end) j++;
    i = j < lines.length ? j : lines.length;
  }
  return out.join('\n');
}

export function shellWriteTargets(command, cwd = process.cwd()) {
  const all = [];
  let dir = cwd;
  const vars = {};
  for (const { text: raw, sep } of shellSegments(dropHeredocBodies(String(command)))) {
    // Shell variables set earlier in the command are expanded (F=.factory/x; echo > $F).
    const assigns = /^\s*(?:export\s+)?((?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s*)+)$/.exec(raw);
    if (assigns) {
      for (const m of assigns[1].matchAll(/([A-Za-z_]\w*)=("[^"]*"|'[^']*'|\S*)/g)) vars[m[1]] = m[2].replace(/^["']|["']$/g, '');
      continue;
    }
    // `env F=x cmd` and `F=x cmd`: the assignments apply to the command, and its variables expand.
    let rawCmd = raw.replace(/^\s*env(?:\s+-\S+)*\s+(?=[A-Za-z_]\w*=)/, '');
    const prefix = /^\s*((?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)+)/.exec(rawCmd);
    if (prefix) {
      for (const m of prefix[1].matchAll(/([A-Za-z_]\w*)=("[^"]*"|'[^']*'|\S*)/g)) vars[m[1]] = m[2].replace(/^["']|["']$/g, '');
      rawCmd = rawCmd.slice(prefix[0].length);
    }
    rawCmd = rawCmd.replace(/^\s*env(?:\s+-\S+)*\s+/, '');
    const segment = rawCmd.replace(/\$\{(\w+)\}|\$(\w+)/g, (all2, a, b) => vars[a ?? b] ?? all2);
    const targets = [];
    // Redirections are found outside quotes only (a `<a@b.c>` inside a commit message is text, dogfood C2),
    // and their target is read from the original text, so `> "a file"` still names that file.
    const masked = maskQuoted(segment);
    for (const m of masked.matchAll(/(?:^|[^<0-9&])(?:[0-9]?>>?|&>>?)\s*("[^"]+"|'[^']+'|[^\s;&|<>()]+)/g)) {
      const start = m.index + m[0].length - m[1].length;
      targets.push(segment.slice(start, start + m[1].length).replace(/^["']|["']$/g, ''));
    }
    const w = words(segment).filter((x) => x !== 'sudo' && x !== 'command' && !/^[A-Z_]+=/.test(x));
    if (!w.length) continue;
    const verb = path.basename(w[0]);
    // A shell's -c script is shell code: its redirections and writes count (they are hidden from the quote-aware
    // redirection scan above).
    if (/^(ba|z|da|k)?sh$/.test(verb)) {
      const k = w.findIndex((a) => /^-[a-z]*c$/.test(a));
      if (k > 0 && typeof w[k + 1] === 'string') targets.push(...shellWriteTargets(w[k + 1], dir).map((t) => path.relative(dir, t) || '.'));
    }
    const args = w.slice(1).filter((a) => !a.startsWith('-') || a.includes('/'));
    if (verb === 'git' && (w[1] === 'apply' || w[1] === 'am')) {
      // The files the patch changes; an unreadable patch (or one from stdin) may change anything.
      const patches = w.slice(2).filter((a) => !a.startsWith('-'));
      const files = patches.length ? patches.map((f) => patchTargets(path.resolve(dir, f))) : [null];
      targets.push(...(files.some((f) => f === null) ? ['.'] : files.flat()));
    } else if (verb === 'patch') {
      const input = w.find((a, k) => w[k - 1] === '-i' || w[k - 1] === '--input') ?? /<\s*("[^"]+"|'[^']+'|\S+)/.exec(segment)?.[1]?.replace(/^["']|["']$/g, '');
      const files = input ? patchTargets(path.resolve(dir, input)) : null;
      targets.push(...(files ?? ['.']), ...args.filter((a) => a !== input));
    } else if ((verb === 'tar' && w.slice(1).some((a) => /^(-[a-zA-Z]*x|x[a-zA-Z]*$|--extract|--get)/.test(a))) || verb === 'unzip') {
      // Extraction writes the archive's entries under the destination (-C / -d, else the current folder).
      const destFlag = verb === 'unzip' ? '-d' : '-C';
      const k = w.findIndex((a) => a === destFlag || a === '--directory');
      const dest = k >= 0 ? w[k + 1] : w.find((a) => a.startsWith('--directory='))?.slice(12) ?? '.';
      const archive = verb === 'unzip' ? w.slice(1).find((a, j) => !a.startsWith('-') && w[j] !== '-d') : w.find((a, j) => w[j - 1] === '-f' || /^-[a-zA-Z]*f$/.test(w[j - 1] ?? '') || /^[a-zA-Z]*f$/.test(w[j - 1] ?? '') && j === 2) ?? w.slice(1).find((a) => /\.(tar|tgz|tar\.\w+|zip)$/.test(a));
      const entries = archive ? archiveEntries(verb, path.resolve(dir, archive), dir) : null;
      targets.push(...(entries ? entries.map((e) => path.join(dest, e)) : [dest]));
    } else if (INTERPRETERS.test(verb) && !w.some((a) => /^-(c|e|pi|i|Command|p)$/.test(a)) && !operands(w).some((a) => a && !a.startsWith('-'))
      && (sep === '|' || /<</.test(segment) || /(^|\s)<\s*\S/.test(segment) || w.slice(1).includes('-'))) {
      // Code the guard cannot see, fed to an interpreter: piped (base64 -d | sh, curl | bash), a heredoc
      // (python3 - <<'PY'), a redirected file or `-`: counts as a write to the whole checkout.
      targets.push('.');
    } else if (verb === 'sponge') {
      targets.push(...args);
    } else if (verb === 'xargs') {
      // xargs runs a command on paths read from stdin: with a command that writes, any path may be written.
      const inner = w.slice(1).find((a) => !a.startsWith('-') && !/^\d+$/.test(a));
      if (inner && (WRITE_VERBS.has(path.basename(inner)) || ['tee', 'sponge', 'sed', 'perl', 'dd', 'truncate', 'git'].includes(path.basename(inner)) || INTERPRETERS.test(path.basename(inner)))) targets.push('.');
    } else if (w.slice(1).some((a) => /^(--write|-w|--fix|--in-place|--inplace|--overwrite)$/.test(a))) {
      // Formatters and fixers that rewrite their arguments (prettier --write, eslint --fix, gofmt -w, black).
      targets.push(...w.slice(1).filter((a) => !a.startsWith('-')));
    } else if (verb === 'tee') targets.push(...args);
    else if (WRITE_VERBS.has(verb)) targets.push(...args);
    else if ((verb === 'sed' || verb === 'perl') && w.some((a) => /^-[a-zA-Z]*i/.test(a))) targets.push(...inPlaceTargets(w));
    else if (verb === 'git' && GIT_WRITES.test(w[1] ?? '')) {
      const paths = w.slice(2).filter((a) => !a.startsWith('-'));
      const afterDashes = w.indexOf('--') >= 0 ? w.slice(w.indexOf('--') + 1) : null;
      // With a pathspec, those paths; otherwise the whole working tree.
      targets.push(...(afterDashes?.length ? afterDashes : ['stash', 'reset', 'clean', 'merge', 'pull', 'rebase', 'am', 'cherry-pick', 'revert'].includes(w[1]) || !paths.length ? ['.'] : paths));
    } else if (verb === 'find' && w.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint)$/.test(a))) {
      targets.push(...w.slice(1, w.findIndex((a, k) => k > 0 && /^[-(!]/.test(a))));
    } else if (verb === 'dd') targets.push(...w.filter((a) => a.startsWith('of=')).map((a) => a.slice(3)));
    else if (INTERPRETERS.test(verb) && w.some((a) => /^-(c|e|pi|i|Command|p)$/.test(a))) {
      // Inline code: its literal write targets; a computed one counts as the whole checkout. Reading is fine.
      targets.push(...inlineWriteTargets(segment));
    }
    const home = (t) => t.replace(/^~(?=\/|$)/, process.env.HOME ?? '~');
    all.push(...targets.map((t) => path.resolve(dir, home(t))));
    if ((verb === 'cd' || verb === 'pushd') && w[1]) dir = path.resolve(dir, home(w[1]));
  }
  return all;
}

const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);

// What the policy declarations of an app.json are checked against: the profile, and which declared roots hold a
// project manifest on disk.
function policyContext(root, text) {
  const profile = readProfile(root);
  let roots = [];
  try {
    roots = (JSON.parse(text)?.policy?.services ?? []).flatMap((s) => (Array.isArray(s?.roots) ? s.roots.filter((r) => typeof r === 'string') : []));
  } catch {
    /* invalid JSON is reported by the caller */
  }
  return { profile, dirs: manifestDirs(root, profile, roots), root };
}

// A path as the filesystem sees it: its deepest existing ancestor resolved through symlinks (so /tmp/x and
// /private/tmp/x are one path on macOS), the rest appended. New files keep their lexical tail.
export function canonical(p) {
  let cur = path.resolve(p);
  const rest = [];
  while (!fs.existsSync(cur)) {
    const up = path.dirname(cur);
    if (up === cur) break;
    rest.unshift(path.basename(cur));
    cur = up;
  }
  try {
    cur = fs.realpathSync.native(cur);
  } catch {
    /* keep the lexical path */
  }
  return path.join(cur, ...rest);
}

// Whether the filesystem under `root` ignores case (macOS and Windows by default): then .Factory/config.json
// is .factory/config.json.
const caseMemo = new Map();
export function caseInsensitive(root) {
  if (!caseMemo.has(root)) {
    const swapped = root.replace(/[A-Za-z](?=[^A-Za-z]*$)/, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
    let result = process.platform === 'win32' || process.platform === 'darwin';
    try {
      result = swapped !== root && fs.existsSync(swapped) && fs.realpathSync.native(swapped) === fs.realpathSync.native(root);
    } catch {
      /* keep the platform default */
    }
    caseMemo.set(root, result);
  }
  return caseMemo.get(root);
}

export function manifestPaths(config) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(config.root, '.factory/manifest.json'), 'utf8'));
    return Object.keys(manifest.files ?? {});
  } catch {
    return [];
  }
}

// With static analysis on, its configuration and suppression files (the packs' and the tools' `protect` lists, such as a
// secret scanner's ignore file or an analyzer severity file, analysis.protect, and a local rule source) are the
// factory's too: an agent may not silence a tool by changing what it reports.
export function analysisProtected(config) {
  try {
    const a = resolveAnalysis(config);
    if (!a) return [];
    return [...a.protect, ...[...a.tools.values()].map((t) => t.rules?.dir).filter(Boolean)];
  } catch {
    return [];
  }
}

export const protectedList = (config) => [...(config.factoryGuard?.protected ?? PROTECTED_DEFAULT), ...manifestPaths(config), ...analysisProtected(config)];

const guardApplies = (config, agent, env = process.env) => config.factoryGuard?.enabled !== false && env.PIPELINE_DISABLE !== '1' && !(config.factoryGuard?.writers ?? WRITERS_DEFAULT).includes(agent);

function filesUnder(root, rel) {
  const abs = path.join(root, rel);
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return [];
  }
  if (!st.isDirectory()) return [rel];
  return fs.readdirSync(abs).flatMap((n) => filesUnder(root, path.join(rel, n)));
}

// The protected files of the checkout an agent runs in, with their hashes (and contents, to restore them).
export function protectedSnapshot(config, cwd, agent, env = process.env) {
  if (!guardApplies(config, agent, env)) return null;
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 60_000 });
  const root = top.status === 0 ? top.stdout.trim() : cwd;
  const files = new Map();
  for (const rel of new Set(protectedList({ ...config, root }).flatMap((p) => filesUnder(root, p)))) {
    const data = fs.readFileSync(path.join(root, rel));
    files.set(rel, { sha: crypto.createHash('sha256').update(data).digest('hex'), data });
  }
  const appAbs = path.join(root, APP_FILE);
  const app = fs.existsSync(appAbs) ? fs.readFileSync(appAbs) : null;
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  return { root, files, paths: protectedList({ ...config, root }), app, head: head.status === 0 ? head.stdout.trim() : null };
}

// After the run: protected files the agent changed, added or removed are put back, and listed.
export function enforceProtected(snapshot) {
  if (!snapshot) return [];
  const changed = [];
  // Commits the agent made to protected paths: their content goes back to the snapshot's commit (the next
  // commit of the harness records the restore, so the branch's net change to them is nothing).
  if (snapshot.head) {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: snapshot.root, encoding: 'utf8', timeout: 60_000 }).stdout?.trim();
    if (head && head !== snapshot.head) {
      const diff = spawnSync('git', ['diff', '--name-only', snapshot.head, head, '--', ...snapshot.paths], { cwd: snapshot.root, encoding: 'utf8', timeout: 60_000 });
      for (const rel of (diff.stdout ?? '').split('\n').filter(Boolean)) {
        const before = snapshot.files.get(rel);
        if (before) fs.writeFileSync(path.join(snapshot.root, rel), before.data);
        else fs.rmSync(path.join(snapshot.root, rel), { force: true });
        changed.push(`${rel} (committed)`);
      }
    }
  }
  const now = new Set(snapshot.paths.flatMap((p) => filesUnder(snapshot.root, p)));
  for (const rel of now) {
    const before = snapshot.files.get(rel);
    const data = fs.readFileSync(path.join(snapshot.root, rel));
    if (!before) {
      changed.push(rel);
      fs.rmSync(path.join(snapshot.root, rel), { force: true });
    } else if (crypto.createHash('sha256').update(data).digest('hex') !== before.sha) {
      changed.push(rel);
      fs.writeFileSync(path.join(snapshot.root, rel), before.data);
    }
  }
  for (const [rel, before] of snapshot.files) {
    if (now.has(rel)) continue;
    changed.push(rel);
    fs.mkdirSync(path.dirname(path.join(snapshot.root, rel)), { recursive: true });
    fs.writeFileSync(path.join(snapshot.root, rel), before.data);
  }
  // app.json may change, but only within the application's topology.
  const appAbs = path.join(snapshot.root, APP_FILE);
  if (fs.existsSync(appAbs) && (!snapshot.app || !fs.readFileSync(appAbs).equals(snapshot.app))) {
    let problems;
    try {
      problems = appSettingsProblems(JSON.parse(fs.readFileSync(appAbs, 'utf8')), policyContext(snapshot.root, fs.readFileSync(appAbs, 'utf8')));
    } catch (error) {
      problems = [error.message];
    }
    if (problems.length) {
      changed.push(`${APP_FILE} (${problems.join('; ')})`);
      if (snapshot.app) fs.writeFileSync(appAbs, snapshot.app);
      else fs.rmSync(appAbs, { force: true });
    }
  }
  return changed.sort();
}

// Commands that change a finding's state in a scanner's own system (accept, ignore, dismiss, mark false positive,
// lower its severity). Only a person triages there: a finding an agent could wave through in the vendor's UI would
// stop blocking without anyone deciding it. Matched in any pipeline child's shell commands, writers included.
export const VENDOR_TRIAGE = [
  { vendor: 'GitHub code scanning', re: /code-scanning\/alerts\/\d+[\s\S]*(?:-X\s*PATCH|--method[= ]PATCH|\bstate=dismissed|dismissed_reason)|(?:-X\s*PATCH|--method[= ]PATCH)[\s\S]*code-scanning\/alerts\/\d+/i },
  { vendor: 'GitHub secret scanning / Dependabot', re: /(?:secret-scanning|dependabot)\/alerts\/\d+[\s\S]*(?:PATCH|state=(?:resolved|dismissed))/i },
  { vendor: 'SonarQube', re: /api\/issues\/(?:do_transition|set_severity|set_type|bulk_change)|api\/hotspots\/change_status/i },
  { vendor: 'Semgrep', re: /semgrep\.dev\/api\/[\s\S]*(?:triage|\/ignore)|\/findings\/triage/i },
  { vendor: 'Snyk', re: /(?:^|[\s;&|(])snyk\s+ignore\b|api\.snyk\.io\/[\s\S]*\/ignores?\b/i },
  { vendor: 'Checkmarx One', re: /(?:^|[\s;&|(])cx\s+triage\s+update\b|\/api\/(?:sast-results-predicates|kics-results-predicates|predicates)\b/i },
  { vendor: 'Veracode', re: /\/mitigation\b|\/annotations\b[\s\S]*(?:APPROVE|ACCEPTRISK|FP|POSSIBLE|NETWORKENV|OSENV|APPDESIGN)|(?:^|[\s;&|(])veracode\s+(?:mitigat|annotat)/i },
];
export function vendorTriageCommand(command) {
  const hit = VENDOR_TRIAGE.find((v) => v.re.test(String(command ?? '')));
  return hit ? hit.vendor : null;
}

export function factoryGuard(config, payload, env = process.env) {
  const settings = config.factoryGuard ?? {};
  if (settings.enabled === false || env.PIPELINE_CHILD !== '1') return null;
  const shell = SHELL_TOOL.test(payload.tool_name ?? '');
  if (shell) {
    const raw = payload.tool_input?.command;
    const vendor = vendorTriageCommand(Array.isArray(raw) ? raw.join(' ') : raw);
    if (vendor) return `Factory guard: this command changes a finding's state in ${vendor} (accept, ignore, dismiss, false positive or severity). Only a person triages findings in the scanner's own system. Fix the finding, or suppress it inline with a justification the reviewers see, or report it in your result for a person to decide.`;
  }
  if (!WRITE_TOOL.test(payload.tool_name ?? '') && !shell) return null;
  // The work the run does (PIPELINE_AGENT_WORK): the orchestrator doing an agent's work writes what that agent may.
  const agent = env.PIPELINE_AGENT_WORK || env.PIPELINE_AGENT_NAME || '';
  if ((settings.writers ?? WRITERS_DEFAULT).includes(agent)) return null;
  const protectedPaths = protectedList(config);
  const fold = caseInsensitive(config.root) ? (p) => p.toLowerCase() : (p) => p;
  const key = (p) => fold(canonical(p));
  const abs = protectedPaths.map((p) => key(path.resolve(config.root, p)));
  const input = payload.tool_input ?? {};
  const command = typeof input.command === 'string' ? input.command : Array.isArray(input.command) ? input.command.join(' ') : '';
  const cwd = payload.cwd || process.cwd();
  const candidates = shell ? shellWriteTargets(command, cwd) : touchedPaths(payload, protectedPaths);
  const blocked = candidates.filter((p) => abs.some((a) => inside(key(p), a) || inside(a, key(p))));
  // app.json (application topology) is the agents' to change, within its allowed keys.
  const appFile = path.resolve(config.root, APP_FILE);
  // The content app.json would have after this tool call: a Write's content, or the current file with the
  // Edit / MultiEdit replacements applied.
  const afterEdit = () => {
    if (typeof input.content === 'string') return input.content;
    const edits = Array.isArray(input.edits) ? input.edits : typeof input.old_string === 'string' ? [input] : null;
    if (!edits) return null;
    let text = fs.existsSync(appFile) ? fs.readFileSync(appFile, 'utf8') : '';
    for (const e of edits) text = e.replace_all ? text.split(e.old_string).join(e.new_string ?? '') : text.replace(e.old_string, () => e.new_string ?? '');
    return text;
  };
  const appContent = !shell && candidates.some((c) => key(c) === key(appFile)) ? afterEdit() : null;
  if (appContent !== null) {
    let problems;
    try {
      problems = appSettingsProblems(JSON.parse(appContent), policyContext(config.root, appContent));
    } catch (error) {
      problems = [`not valid JSON: ${error.message}`];
    }
    if (problems.length) return `Factory guard: ${APP_FILE} holds only the application's topology (services, ports, URLs, readiness, new services for the architecture policy): ${problems.join('; ')}. Models, gates, review, the policy's rules and classes, commands and the code host, tracker and CI settings are governance (${'.factory/config.json'}), which ${agent || 'this agent'} may not change.`;
  }
  // A shell command's effect on app.json is not knowable in general (jq, sed, inline code): it is refused, and the
  // edit tools, whose result the guard checks, are the way to change it.
  if (shell && !blocked.length && candidates.some((c) => key(c) === key(appFile))) return `Factory guard: a shell command may not write ${APP_FILE}, because the guard cannot check what it would write. Change ${APP_FILE} with the file-editing tools (Edit or Write), so the result is checked: it may hold only the application's topology.`;
  if (!blocked.length) return null;
  const rel = [...new Set(blocked.map((p) => path.relative(canonical(config.root), canonical(p))))].filter(Boolean).join(', ');
  // A write aimed at the whole checkout (git stash, inline code writing a computed path).
  if (!rel) return `Factory guard: this command can change any file of the checkout, .factory/ included, and ${agent || 'this agent'} may not edit the factory's settings, agent addenda, lessons, policy or generated files. Change application files by name instead.`;
  // Topology an agent may change lives in app.json: say so where the agent looks for it.
  const topology = blocked.some((p) => key(p) === key(path.resolve(config.root, OVERLAY_FILE)))
    ? ` The application's topology (project.services, stack ports, URLs, services and publish overrides, teststack readiness) is in ${APP_FILE}, which you may edit: register a new service there.`
    : '';
  return `Factory guard: ${rel} belongs to the factory, not to the application. ${agent || 'This agent'} may not edit the factory's settings, agent addenda, lessons, policy, generated files or static analysis configuration and suppression files.${topology} Report anything else that should change in your result instead (the retro proposes such changes for a person to review).`;
}
