// API summary for backend pull requests: the HTTP endpoints a PR adds, changes or removes, documented
// from OpenAPI documents and illustrated with the real calls its e2e specs made (E2E_API_LOG=1, the e2e
// fixtures). Rendered as the PR's "API changes" section. See docs/ai-pipeline/pr-demo-video.md.
//
// Nothing here knows a web framework or a folder layout:
//   - what is frontend and what is backend comes from the project model (`project.frontendPaths`,
//     `project.services[].kind`) and `prVideo.backendPaths` / `prVideo.neutralPaths`;
//   - the endpoints come from a route extractor chosen with `prVideo.api.extractor` (a built-in name such
//     as "aspnet-minimal-api", or the path of a module with the same exports) reading the files matched
//     by `prVideo.api.sources`;
//   - with no extractor, the changed endpoints are the difference between each OpenAPI file listed in
//     `prVideo.api.openapi` at the merge base and at HEAD; with neither, only the recorded calls show.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isFrontendFile, matchesAnyPath, servicesOfFile } from '../../implement/lib/project.mjs';
import { INSTALL_ROOT } from '../../pipeline/lib/config.mjs';
import { git } from '../../pipeline/lib/git.mjs';
import { workflowFile } from './pr-video.mjs';

export const API_MARKERS = { start: '<!-- pr-api-summary:start -->', end: '<!-- pr-api-summary:end -->' };
const SECTION_BUDGET = 40000;
const EXAMPLES_PER_ENDPOINT = 3;
const EXAMPLE_BODY_LIMIT = 1500;

// `prVideo.api` with its defaults.
export const apiSettings = (config) => ({ extractor: null, sources: [], exclude: [], openapi: [], ...(config?.prVideo?.api ?? {}) });

// The built-in route extractors, by name.
const BUILT_IN = { 'aspnet-minimal-api': '../../../packs/dotnet/pr-video/aspnet-minimal-api.mjs' };

// Loads the configured route extractor, or null when none is configured. A name that is not built in is
// a module path, looked up in the app repository first, then in the engine's install root.
export async function loadExtractor(config) {
  const name = apiSettings(config).extractor;
  if (!name) return null;
  let spec = BUILT_IN[name];
  if (!spec) {
    const file = [config?.root, config?.installRoot ?? INSTALL_ROOT].filter(Boolean).map((r) => path.resolve(r, name)).find((f) => fs.existsSync(f));
    if (!file) throw new Error(`prVideo.api.extractor "${name}" is neither a built-in extractor (${Object.keys(BUILT_IN).join(', ')}) nor a module in the repository or the install root`);
    spec = pathToFileURL(file).href;
  }
  const mod = await import(spec);
  if (typeof mod.parseEndpoints !== 'function') throw new Error(`prVideo.api.extractor "${name}" does not export parseEndpoints(source)`);
  return { id: mod.id ?? name, hasRoutes: mod.hasRoutes ?? (() => true), parseEndpoints: mod.parseEndpoints };
}

// The service a file belongs to: its name in the project model, else the folder the file is in.
const serviceOf = (file, project) => servicesOfFile(file, project)[0]?.name ?? (path.posix.dirname(file) === '.' ? file : path.posix.dirname(file));

const isSource = (file, api) => matchesAnyPath(file, api.sources) && !matchesAnyPath(file, api.exclude);

function changedLines(root, mergeBase, file) {
  const diff = git(root, ['diff', '-U0', mergeBase, 'HEAD', '--', file]).stdout;
  const lines = [];
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    // A pure deletion (count 0) touches the line it was removed after.
    for (let n = start; n < start + Math.max(count, 1); n++) lines.push(n);
  }
  return lines;
}

function mergeBaseOf(root, base) {
  const result = git(root, ['merge-base', base, 'HEAD']);
  if (result.status === 0) return result.stdout.trim();
  // Say why, so a CI failure can be diagnosed from the log.
  const info = (args) => git(root, args).stdout.trim() || '?';
  throw new Error([
    `git merge-base ${base} HEAD failed (${result.status}): ${result.stderr.trim() || 'no output'}`,
    `HEAD=${info(['rev-parse', 'HEAD'])} ${base}=${info(['rev-parse', '--verify', '--quiet', base])} shallow=${info(['rev-parse', '--is-shallow-repository'])} ${info(['--version'])}`,
  ].join('\n'));
}

function changedFiles(root, mergeBase) {
  return git(root, ['diff', '--name-status', '--no-renames', mergeBase, 'HEAD'], { allowFail: false }).stdout
    .split('\n')
    .map((l) => l.trim().split('\t'))
    .filter(([status, file]) => status && file)
    .map(([status, file]) => ({ status: status[0], file }));
}

// The gRPC contract files (.proto) a PR adds, changes or removes since the merge base with `base`.
export function changedProtos(root, base) {
  return changedFiles(root, mergeBaseOf(root, base)).filter((f) => /\.proto$/i.test(f.file)).map((f) => f.file);
}

// Whether the changed files touch the frontend, the backend, or both. A PR gets a demo video
// when it changes the frontend, and an API summary whenever it changes the backend (including mixed PRs).
//   frontend  a file matching `project.frontendPaths` or the paths of a service with kind "frontend"
//   backend   any other file under `prVideo.backendPaths`, or (when that is empty) in a service of
//             another kind; never a file matching `prVideo.neutralPaths` (app wiring, shared defaults)
// Files in neither (tests, e2e specs, docs, CI) count as neither.
export function classifyFiles(files, config = {}) {
  const project = config.project ?? {};
  const settings = config.prVideo ?? {};
  const backendPaths = settings.backendPaths ?? [];
  const isBackend = (f) => (backendPaths.length ? matchesAnyPath(f, backendPaths) : servicesOfFile(f, project).some((s) => s.kind !== 'frontend'));
  const frontend = files.some((f) => isFrontendFile(f, project));
  const backend = files.some((f) => isBackend(f) && !isFrontendFile(f, project) && !matchesAnyPath(f, settings.neutralPaths ?? []));
  // A full-stack change gets both: the demo video and the API summary (council C10, Opus 4: #243 changed GET /api/orders and
  // had no API changes section because it also changed the frontend).
  return { frontend, backend, video: frontend, api: backend };
}

export function changeScope(root, base, config = {}) {
  return classifyFiles(changedFiles(root, mergeBaseOf(root, base)).map(({ file }) => file), config);
}

// Endpoints added, modified or removed since the merge base with `base`, read by the route extractor
// from the changed source files. Without an extractor there is nothing to read: [].
export function changedEndpoints(root, base, { extractor = null, config = {} } = {}) {
  if (!extractor) return [];
  const api = apiSettings(config);
  const mergeBase = mergeBaseOf(root, base);
  const result = [];
  for (const { status, file } of changedFiles(root, mergeBase)) {
    if (!isSource(file, api)) continue;
    const before = status === 'A' ? '' : git(root, ['show', `${mergeBase}:${file}`]).stdout;
    const after = status === 'D' || !fs.existsSync(path.join(root, file)) ? '' : fs.readFileSync(path.join(root, file), 'utf8');
    if (!extractor.hasRoutes(before) && !extractor.hasRoutes(after)) continue;
    const old = new Map(extractor.parseEndpoints(before).map((e) => [`${e.method} ${e.route}`, e]));
    const touched = status === 'D' ? [] : changedLines(root, mergeBase, file);
    const service = serviceOf(file, config.project);
    for (const e of extractor.parseEndpoints(after)) {
      const key = `${e.method} ${e.route}`;
      const was = old.get(key);
      old.delete(key);
      const versions = e.versions ?? [];
      const modified = was && (touched.some((n) => (e.ranges ?? []).some(([a, b]) => n >= a && n <= b)) || (was.versions ?? []).join() !== versions.join());
      if (!was || modified) result.push({ change: was ? 'modified' : 'added', method: e.method, route: e.route, versions, service, file, line: e.line });
    }
    for (const e of old.values()) result.push({ change: 'removed', method: e.method, route: e.route, versions: e.versions ?? [], service, file, line: e.line });
  }
  return result;
}

// Every endpoint the extractor finds in the source files at HEAD, to name the route templates the
// recorded calls hit.
export function allEndpoints(root, { extractor = null, config = {} } = {}) {
  if (!extractor) return [];
  const api = apiSettings(config);
  const files = git(root, ['ls-files'], { allowFail: false }).stdout.split('\n').filter((f) => f && isSource(f, api));
  const out = [];
  for (const file of files) {
    const full = path.join(root, file);
    if (!fs.existsSync(full)) continue;
    const source = fs.readFileSync(full, 'utf8');
    if (!extractor.hasRoutes(source)) continue;
    for (const e of extractor.parseEndpoints(source)) out.push({ method: e.method, route: e.route, versions: e.versions ?? [], service: serviceOf(file, config.project), file, line: e.line });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// OpenAPI: documents to describe the endpoints with, and (for documents kept as files in the
// repository) the difference between the merge base and HEAD.
// ---------------------------------------------------------------------------------------------

const isUrl = (entry) => /^https?:\/\//i.test(entry);
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null; // not JSON (a YAML document, for example): not read
  }
};

// The OpenAPI files of `prVideo.api.openapi` (repository-relative JSON files; URLs are skipped) at HEAD
// and at the merge base: [{ file, head, base }], either side null when missing or unreadable.
export function openApiFiles(root, base, entries) {
  const files = (entries ?? []).filter((e) => !isUrl(e));
  if (!files.length) return [];
  const mergeBase = mergeBaseOf(root, base);
  return files.map((file) => {
    const full = path.join(root, file);
    const before = git(root, ['show', `${mergeBase}:${file}`]);
    return { file, head: fs.existsSync(full) ? parseJson(fs.readFileSync(full, 'utf8')) : null, base: before.status === 0 ? parseJson(before.stdout) : null };
  });
}

const operations = (doc) => {
  const out = new Map();
  for (const [route, item] of Object.entries(doc?.paths ?? {})) {
    for (const method of HTTP_METHODS) if (item?.[method]) out.set(`${method.toUpperCase()} ${route}`, { method: method.toUpperCase(), route, op: { ...item[method], parameters: [...(item.parameters ?? []), ...(item[method].parameters ?? [])] } });
  }
  return out;
};

// Endpoints added, modified (the operation's definition differs) or removed between two versions of
// one OpenAPI document.
export function openApiDiff(baseDoc, headDoc, { service = '', file = '' } = {}) {
  const before = operations(baseDoc);
  const after = operations(headDoc);
  const version = (doc) => (doc?.info?.version ? [String(doc.info.version)] : []);
  const result = [];
  for (const [key, e] of after) {
    const was = before.get(key);
    if (!was) result.push({ change: 'added', method: e.method, route: e.route, versions: version(headDoc), service, file });
    else if (JSON.stringify(was.op) !== JSON.stringify(e.op)) result.push({ change: 'modified', method: e.method, route: e.route, versions: version(headDoc), service, file });
  }
  for (const [key, e] of before) if (!after.has(key)) result.push({ change: 'removed', method: e.method, route: e.route, versions: version(baseDoc), service, file });
  return result;
}

// Changed endpoints from the OpenAPI files in the repository (the fallback without a route extractor).
export const changedFromOpenApi = (files, project = null) =>
  files.flatMap(({ file, head, base }) => openApiDiff(base, head, { service: head?.info?.title ?? base?.info?.title ?? serviceOf(file, project), file }));

// What the API summary can be built from, and why not when it cannot: { ok, reason }.
export function apiSources(config) {
  const api = apiSettings(config);
  const hasFiles = api.openapi.some((e) => !isUrl(e));
  if (api.extractor && !api.sources.length) return { ok: hasFiles, mode: hasFiles ? 'openapi' : 'none', reason: `prVideo.api.extractor is "${api.extractor}" but prVideo.api.sources lists no source files` };
  if (api.extractor) return { ok: true, mode: 'extractor', reason: null };
  if (hasFiles) return { ok: true, mode: 'openapi', reason: null };
  return { ok: false, mode: 'none', reason: 'no route extractor (prVideo.api.extractor) and no OpenAPI file to compare (prVideo.api.openapi) are configured' };
}

function routeRegex(route) {
  const pattern = route
    .split('/')
    .filter(Boolean)
    .map((seg) => {
      const optional = /^\{\w+\?\}$/.test(seg);
      const body = /^\{\w+\??\}$/.test(seg) ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return optional ? `(?:/${body})?` : `/${body}`;
    })
    .join('');
  return new RegExp(`^${pattern || ''}/?$`, 'i');
}

// Literal segments win over parameters when several templates match a path.
const specificity = (route) => route.split('/').filter((s) => s && !s.startsWith('{')).length;

export function matchEndpoint(endpoints, method, url) {
  const pathname = new URL(url).pathname;
  return endpoints
    .filter((e) => e.method === method && routeRegex(e.route).test(pathname))
    .sort((a, b) => specificity(b.route) - specificity(a.route))[0];
}

// Recorded calls from artifacts/e2e-videos/manifest.json (last attempt of each test).
export function recordedExchanges(manifest) {
  const latest = new Map();
  for (const t of manifest?.tests ?? []) {
    const key = [t.project, t.file, ...t.titlePath].join('\u0000');
    if (!latest.has(key) || latest.get(key).retry <= t.retry) latest.set(key, t);
  }
  return [...latest.values()].flatMap((t) => (t.api ?? []).map((x) => ({ ...x, test: t.titlePath.slice(2).join(' › ') || t.title, file: t.file })));
}

// The documents to describe endpoints with: URLs are fetched (a running stack), anything else is a JSON
// file in the repository at `root`.
// `{port:<name>}` in an OpenAPI URL is the host port of that name (stack.ports) on the test stack slot in use
// (TESTSTACK_SLOT, default 0), so the documents the running services serve are read on any slot. An entry
// whose port is unknown, or with no stack configured, is skipped and reported.
export function expandOpenApiPorts(entries, ports, warn = () => {}) {
  const out = [];
  for (const entry of entries ?? []) {
    if (!/\{port:[^}]+\}/.test(entry)) {
      out.push(entry);
      continue;
    }
    const missing = [...entry.matchAll(/\{port:([^}]+)\}/g)].map((m) => m[1]).filter((name) => !(ports && name in ports));
    if (missing.length) warn(`prVideo.api.openapi: ${entry} names no stack port ${missing.join(', ')} (stack.ports has: ${Object.keys(ports ?? {}).join(', ') || 'none'}); skipped`);
    else out.push(entry.replace(/\{port:([^}]+)\}/g, (_, name) => String(ports[name])));
  }
  return out;
}

export async function loadOpenApi(entries, fetchImpl = globalThis.fetch, root = null) {
  const docs = [];
  for (const url of entries ?? []) {
    if (!isUrl(url)) {
      const full = root ? path.join(root, url) : url;
      const doc = fs.existsSync(full) ? parseJson(fs.readFileSync(full, 'utf8')) : null;
      if (doc) docs.push({ url: pathToFileURL(full).href, doc });
      continue;
    }
    // A held controller and timer, not AbortSignal.timeout() (its signal can be collected before it fires).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (response.ok) docs.push({ url, doc: await response.json() });
    } catch {
      // A service that is down or has no OpenAPI document is simply not documented.
    } finally {
      clearTimeout(timer);
    }
  }
  return docs;
}

const templateKey = (route) => route.toLowerCase().replace(/\{\w+\??\}/g, '{}').replace(/\/+$/, '') || '/';

function schemaName(schema) {
  if (!schema) return 'any';
  if (schema.$ref) return schema.$ref.split('/').pop();
  if (schema.type === 'array') return `${schemaName(schema.items)}[]`;
  const type = Array.isArray(schema.type) ? schema.type.filter((t) => t !== 'null').join(' | ') : schema.type;
  return [type ?? 'object', schema.format ? `(${schema.format})` : ''].join('');
}

function resolve(schema, doc) {
  const name = schema?.$ref?.split('/').pop();
  return name ? doc.components?.schemas?.[name] : schema;
}

// OpenAPI operation details for one endpoint, merged across the documents (API versions) that have it.
export function describeOperation(docs, method, route) {
  const found = [];
  for (const { url, doc } of docs) {
    const entry = Object.entries(doc.paths ?? {}).find(([p]) => templateKey(p) === templateKey(route));
    const op = entry?.[1]?.[method.toLowerCase()];
    if (!op) continue;
    const params = [...(entry[1].parameters ?? []), ...(op.parameters ?? [])].map((p) => {
      const param = p.$ref ? doc.components?.parameters?.[p.$ref.split('/').pop()] ?? p : p;
      return { name: param.name, in: param.in, required: !!param.required, type: schemaName(param.schema) };
    });
    const content = op.requestBody?.content ?? {};
    const [contentType, media] = Object.entries(content)[0] ?? [];
    const bodySchema = media?.schema;
    const fields = Object.entries(resolve(bodySchema, doc)?.properties ?? {}).map(([name, s]) => `${name}: ${schemaName(s)}`);
    const responses = Object.entries(op.responses ?? {}).map(([code, r]) => {
      const schema = Object.values(r.content ?? {})[0]?.schema;
      return { code, description: r.description ?? '', type: schema ? schemaName(schema) : null };
    });
    found.push({
      version: doc.info?.version ?? path.basename(new URL(url).pathname, '.json'),
      summary: op.summary ?? op.description ?? '',
      params,
      request: contentType ? { contentType, type: schemaName(bodySchema), required: !!op.requestBody?.required, fields } : null,
      responses,
    });
  }
  if (!found.length) return null;
  const latest = found[found.length - 1];
  return { ...latest, versions: found.map((f) => f.version) };
}

const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const clip = (text = '', limit = EXAMPLE_BODY_LIMIT) => (text.length > limit ? `${text.slice(0, limit)}\n… (truncated)` : text);
const CHANGE_LABEL = { added: '🆕 Added', modified: '✏️ Changed', removed: '🗑️ Removed', exercised: '🧪 Exercised' };

function renderExample(x) {
  const url = new URL(x.url);
  const request = [`${x.method} ${url.pathname}${url.search}`];
  for (const [k, v] of Object.entries(x.requestHeaders ?? {})) request.push(`${k}: ${v}`);
  if (x.requestBody) request.push('', clip(x.requestBody));
  const lang = /json/i.test(x.responseContentType ?? '') ? 'json' : 'text';
  return [
    `<details><summary>Example: <code>${x.status}</code> · ${cell(x.test)}</summary>`,
    '',
    '**Request**',
    '',
    '```http',
    ...request,
    '```',
    '',
    `**Response** \`${x.status}\`${x.responseContentType ? ` \`${x.responseContentType}\`` : ''}`,
    '',
    ...(x.responseBody ? [`\`\`\`${lang}`, clip(x.responseBody), '```'] : ['_(empty body)_']),
    '',
    '</details>',
  ];
}

function renderEndpoint(e, withExamples) {
  const out = ['', `### \`${e.method} ${e.route}\``, ''];
  const where = e.change === 'exercised' && !e.file ? `by \`${e.calls[0]?.file ?? 'e2e specs'}\`` : `in \`${e.file}${e.line ? `:${e.line}` : ''}\``;
  const meta = [`${CHANGE_LABEL[e.change]} ${where}`];
  if (e.versions?.length) meta.push(`API versions ${e.versions.join(', ')}`);
  out.push(meta.join(' · '));
  const op = e.operation;
  if (op) {
    if (op.summary) out.push('', op.summary);
    if (op.params.length) out.push('', `**Parameters:** ${op.params.map((p) => `\`${p.name}\` (${p.in}, ${p.type}${p.required ? ', required' : ''})`).join(', ')}`);
    if (op.request) {
      out.push('', `**Request body:** \`${op.request.contentType}\` \`${op.request.type}\`${op.request.required ? ' (required)' : ''}`);
      if (op.request.fields.length) out.push(`<br>Fields: ${op.request.fields.map((f) => `\`${f}\``).join(', ')}`);
    }
    if (op.responses.length) out.push('', `**Responses:** ${op.responses.map((r) => `\`${r.code}\`${r.type ? ` \`${r.type}\`` : ''}${r.description ? ` ${r.description}` : ''}`).join(' · ')}`);
  } else if (e.change !== 'removed') {
    out.push('', '_Not in the OpenAPI documents._');
  }
  if (withExamples && e.examples.length) out.push('', ...e.examples.flatMap(renderExample));
  return out.join('\n');
}

// Groups the recorded calls by endpoint, attaches OpenAPI details, and renders the section.
// Returns null when the PR neither changes an endpoint nor records a call.
export function buildApiSummary({ changed = [], known = [], exchanges = [], docs = [] }) {
  const endpoints = new Map();
  for (const e of changed) endpoints.set(`${e.method} ${e.route}`, { ...e, calls: [] });
  const candidates = [...changed.filter((e) => e.change !== 'removed'), ...known];
  for (const x of exchanges) {
    const match = matchEndpoint(candidates, x.method, x.url);
    const route = match?.route ?? new URL(x.url).pathname;
    const key = `${x.method} ${route}`;
    if (!endpoints.has(key)) endpoints.set(key, { change: 'exercised', method: x.method, route, versions: match?.versions ?? [], service: match?.service ?? new URL(x.url).host, file: match?.file ?? '', line: match?.line, calls: [] });
    endpoints.get(key).calls.push(x);
  }
  const order = { added: 0, modified: 1, removed: 2, exercised: 3 };
  return [...endpoints.values()]
    .sort((a, b) => order[a.change] - order[b.change] || a.route.localeCompare(b.route) || a.method.localeCompare(b.method))
    .map((e) => {
      const byStatus = new Map();
      for (const x of e.calls) if (!byStatus.has(x.status)) byStatus.set(x.status, x);
      const examples = [...byStatus.values()].sort((a, b) => a.status - b.status).slice(0, EXAMPLES_PER_ENDPOINT);
      return { ...e, operation: e.change === 'removed' ? null : describeOperation(docs, e.method, e.route), examples };
    });
}

// `origin` says where the changed endpoints were read from ("from the route mappings in the source",
// "from the OpenAPI files").
// `protos`: changed .proto files. The summary reads HTTP endpoints only; a gRPC contract change is named and said to be
// outside it, never left out silently (council C11, Sol 3: a gift-message gRPC field showed no API section at all).
export function renderApiSection({ endpoints, headSha, runUrl, specs = [], origin = null, protos = [] }) {
  const source = `${headSha ? `commit ${headSha.slice(0, 7)}` : 'this PR'}${runUrl ? `, [workflow run](${runUrl})` : ''}`;
  const grpc = protos.length ? `gRPC contract changes are not extracted: this PR changes ${protos.map((p) => `\`${p}\``).join(', ')}, and the summary reads HTTP endpoints only; read the \`.proto\` diff for the gRPC contract.` : '';
  if (!endpoints.length) {
    if (!grpc) return null;
    return ['## API changes', '', `No HTTP endpoint changes found (${origin ?? 'no endpoint source'}; ${source}). ${grpc}`, '', `<sub>Updated by \`${workflowFile()}\` on every push; edits inside this section are overwritten.</sub>`].join('\n');
  }
  const lines = [
    '## API changes',
    '',
    `HTTP endpoints this PR adds, changes or removes${origin ? ` (${origin})` : ''}, documented from OpenAPI and illustrated with the calls ${specs.length ? `its e2e specs (${specs.map((s) => `\`${s}\``).join(', ')})` : 'its e2e specs'} made (${source}).`,
    ...(grpc ? ['', grpc] : []),
    '',
    '| Change | Method | Endpoint | Service | Request | Responses | Recorded calls |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const e of endpoints) {
    const request = e.operation?.request ? `\`${e.operation.request.type}\`` : '';
    const responses = e.operation?.responses.map((r) => r.code).join(', ') ?? '';
    const statuses = [...new Set(e.calls.map((x) => x.status))].sort((a, b) => a - b);
    const calls = e.calls.length ? `${e.calls.length} (${statuses.join(', ')})` : '';
    lines.push(`| ${CHANGE_LABEL[e.change]} | \`${e.method}\` | \`${cell(e.route)}\` | ${cell(e.service)} | ${request} | ${responses} | ${calls} |`);
  }
  const footer = ['', `<sub>Updated by \`${workflowFile()}\` on every push; edits inside this section are overwritten. Secrets in recorded calls are redacted and long bodies truncated.</sub>`];
  let text = lines.join('\n');
  const detailed = endpoints.filter((e) => e.change !== 'removed');
  for (const [i, e] of detailed.entries()) {
    const full = renderEndpoint(e, true);
    const brief = full.length + text.length > SECTION_BUDGET ? renderEndpoint(e, false) : full;
    if (brief.length + text.length > SECTION_BUDGET) {
      text += `\n\n_${detailed.length - i} more endpoint(s) left out to fit the PR description; see the workflow run's artifact._`;
      break;
    }
    text += `\n${brief}`;
  }
  return `${text}\n${footer.join('\n')}`;
}
