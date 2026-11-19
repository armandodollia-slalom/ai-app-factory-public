// Route extractor "aspnet-minimal-api": the HTTP endpoints an ASP.NET Core minimal-API source file maps
// (`group.MapGet("...", Handler)`, with `MapGroup` prefixes and `HasApiVersion`). Selected with
// `prVideo.api.extractor` in .factory/config.json; the engine itself knows no web framework.
//
// The extractor contract (any module named in `prVideo.api.extractor` exports the same):
//   id                     the extractor's name
//   hasRoutes(source)      a cheap test: can this file map routes at all?
//   parseEndpoints(source) -> [{ method, route, versions: [], line, ranges: [[from, to]] }]
//                          `ranges` are the source lines that implement the endpoint (1-based,
//                          inclusive), used to tell whether a diff touched it.
export const id = 'aspnet-minimal-api';

const MAP_CALL = /(\w+)\s*\.\s*Map(Get|Post|Put|Patch|Delete)\s*\(\s*"([^"]*)"\s*(?:,\s*(\w+)\s*\))?/g;
const HAS_MAP = /\.Map(Get|Post|Put|Patch|Delete)\s*\(/;
export const hasRoutes = (source) => HAS_MAP.test(source);
const GROUP = /(\w+)\s*=\s*[\w.]*?\.MapGroup\s*\(\s*"([^"]*)"\s*\)([^;]*)/g;

// `{id:int}` -> `{id}`, `{brandId:int?}` -> `{brandId?}`
export const normalizeRoute = (route) => route.replace(/\{(\w+)(?::[^{}]*?)?(\?)?\}/g, '{$1$2}');

function joinRoute(prefix, route) {
  const parts = [prefix, route].flatMap((p) => p.split('/')).filter(Boolean);
  return normalizeRoute(`/${parts.join('/')}`);
}

const lineOf = (source, index) => source.slice(0, index).split('\n').length;

// The index of the `;` that ends the statement starting at `from` (brackets, strings and comments skipped), so a
// Map call's lines are its own statement and never the code after it.
function statementEnd(source, from) {
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    const c = source[i];
    if (c === '"' || c === "'") {
      for (i++; i < source.length && source[i] !== c; i++) if (source[i] === '\\') i++;
    } else if (c === '/' && source[i + 1] === '/') i = source.indexOf('\n', i) === -1 ? source.length : source.indexOf('\n', i);
    else if (c === '/' && source[i + 1] === '*') i = source.indexOf('*/', i + 2) === -1 ? source.length : source.indexOf('*/', i + 2) + 1;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ';' && depth <= 0) return i;
    if (depth < 0) return i;
  }
  return source.length - 1;
}

// A member's leading attribute, doc-comment and blank lines belong to it: `[ProducesResponseType]` is the contract.
const isPreamble = (l) => /^\s*(\[|\/\/|$)/.test(l);

// Endpoints mapped in one C# file: method, route (with its MapGroup prefix), API versions, and the
// source lines that implement it (the Map call, an inline lambda up to the next Map call, or the
// named handler method), used to tell whether a diff touched it.
export function parseEndpoints(source) {
  const groups = new Map();
  for (const m of source.matchAll(GROUP)) {
    const versions = [...m[3].matchAll(/HasApiVersion\s*\(\s*([\d.]+)(?:\s*,\s*(\d+))?\s*\)/g)]
      .map((v) => (v[2] !== undefined ? `${v[1]}.${v[2]}` : v[1].includes('.') ? v[1] : `${v[1]}.0`));
    groups.set(m[1], { prefix: m[2], versions });
  }
  const lines = source.split('\n');
  const calls = [...source.matchAll(MAP_CALL)].map((m) => ({ m, line: lineOf(source, m.index) }));
  const endpoints = new Map();
  calls.forEach(({ m, line }, i) => {
    const [, receiver, verb, route, handler] = m;
    const group = groups.get(receiver) ?? { prefix: '', versions: [] };
    const method = verb.toUpperCase();
    const template = joinRoute(group.prefix, route);
    // The Map call's own statement (with an inline lambda, its body), not every line up to the next Map call
    // (council C2: the last mapping's range ran to the end of the file, so every later handler's edit "changed" it).
    const ranges = [[line, lineOf(source, statementEnd(source, m.index))]];
    if (handler) {
      const def = lines.findIndex((l, n) => n + 1 !== line && new RegExp(`\\b${handler}\\s*(<[^>]*>)?\\s*\\(`).test(l) && /\b(static|public|private|internal|async)\b/.test(l));
      if (def !== -1) {
        let start = def;
        while (start > 0 && isPreamble(lines[start - 1]) && lines[start - 1].trim()) start--;
        let next = lines.findIndex((l, n) => n > def && /^\s*(public|private|internal|protected)\b/.test(l));
        if (next === -1) next = lines.length;
        while (next - 1 > def && isPreamble(lines[next - 1])) next--;
        ranges.push([start + 1, next]);
      }
    }
    const key = `${method} ${template}`;
    const existing = endpoints.get(key);
    if (existing) {
      existing.versions = [...new Set([...existing.versions, ...group.versions])].sort();
      existing.ranges.push(...ranges);
    } else {
      endpoints.set(key, { method, route: template, versions: [...group.versions].sort(), line, ranges });
    }
  });
  return [...endpoints.values()];
}
