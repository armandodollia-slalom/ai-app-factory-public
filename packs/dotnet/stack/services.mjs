// Stack resolver for .NET: computes the inputs of a compose service from its MSBuild project
// (`stack.services.<name>.project`) by walking ProjectReference items, plus Compile/Protobuf/Content items
// linked from outside the project folder (a shared source folder, another project's .proto file).
// Enable it with "resolver": "pack:dotnet/stack/services.mjs" in the `stack` section.
import fs from 'node:fs';
import path from 'node:path';

const INCLUDE = /\b(ProjectReference|Compile|Content|None|Protobuf|EmbeddedResource|AdditionalFiles)\s[^>]*?\bInclude\s*=\s*["']([^"']+)["']/g;

const normalize = file => path.posix.normalize(String(file).trim().replace(/\\/g, '/')).replace(/^(\.\/)+/, '');

// Literal part of an MSBuild include ("..\\Shared\\*.cs" -> "../Shared/"); null when it starts with a property.
function literalPrefix(include) {
  const text = include.replace(/\\/g, '/');
  if (text.includes('$(')) return null;
  const wildcard = text.search(/[*?]/);
  if (wildcard < 0) return text;
  return text.slice(0, text.lastIndexOf('/', wildcard) + 1);
}

/**
 * Repo-relative paths a project depends on: its own folder, the folders of every project it references
 * (transitively) and any file or folder it includes from outside its folder. Folders end with "/".
 */
export function projectInputs(projectFile, { root, seen = new Set() }) {
  const project = normalize(projectFile);
  if (seen.has(project)) return [];
  seen.add(project);
  const dir = `${path.posix.dirname(project)}/`;
  const inputs = [dir];
  let text;
  try {
    text = fs.readFileSync(path.join(root, project), 'utf8');
  } catch {
    return inputs;
  }
  for (const [, kind, include] of text.matchAll(INCLUDE)) {
    for (const part of include.split(';')) {
      const prefix = literalPrefix(part.trim());
      if (!prefix) continue;
      const resolved = path.posix.normalize(path.posix.join(dir, prefix));
      if (resolved.startsWith('..')) continue;
      if (kind === 'ProjectReference') {
        inputs.push(...projectInputs(resolved, { root, seen }));
      } else if (!resolved.startsWith(dir)) {
        inputs.push(prefix.endsWith('/') ? `${resolved.replace(/\/?$/, '/')}` : resolved);
      }
    }
  }
  return [...new Set(inputs)];
}

/** Resolver entry point: the inputs of one service, from its `project` (a .csproj/.fsproj/.vbproj path). */
export function serviceInputs(service, { root }) {
  return service.project ? projectInputs(service.project, { root }) : [];
}
