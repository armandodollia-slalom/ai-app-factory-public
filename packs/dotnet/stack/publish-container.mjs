#!/usr/bin/env node
// Image builder of the dotnet pack, for a repository whose services have no Dockerfile: builds each test
// stack image with the .NET SDK's own container support (`dotnet publish -t:PublishContainer`), the way
// .NET services are usually shipped. Use it as the stack's build commands:
//
//   "build": {
//     "all": "node {packs}/dotnet/stack/publish-container.mjs --all",
//     "service": "node {packs}/dotnet/stack/publish-container.mjs {service}"
//   }
//
// and give every built service its project and image in the `stack` section:
//
//   "services": { "catalog-api": { "project": "src/Catalog.API/Catalog.API.csproj",
//                                  "image": { "env": "CATALOG_API_IMAGE", "name": "shop/catalog-api" } } }
//
// Each image is tagged `<image.name>:<build.builtTag or latest>`; the test stack then retags it per slot.
// Images are built for this machine's Linux architecture (no emulation); TESTSTACK_PLATFORM=linux-amd64 or
// linux-arm64 overrides it. Extra MSBuild arguments: `build.env.DOTNET_PUBLISH_ARGS` (space separated).
// Runs from the repository root (where the test stack runs its build commands); reads .factory/config.json.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export function platform(env = process.env, arch = os.arch()) {
  const configured = env.TESTSTACK_PLATFORM;
  if (configured) {
    const m = /^linux-(amd64|x64|arm64)$/.exec(configured);
    if (!m) throw new Error(`TESTSTACK_PLATFORM=${configured}: use linux-amd64 or linux-arm64`);
    return m[1] === 'arm64' ? 'arm64' : 'x64';
  }
  return arch === 'arm64' ? 'arm64' : 'x64';
}

/** The `dotnet publish` argument lists for the named compose services (all built services with `--all`). */
export function publishCommands(stack, names, { env = process.env, arch = os.arch() } = {}) {
  const services = stack?.services ?? {};
  const wanted = names.includes('--all') ? Object.keys(services) : names;
  if (!wanted.length) throw new Error('name the compose services to build, or --all');
  const tag = stack?.build?.builtTag ?? 'latest';
  const extra = String(env.DOTNET_PUBLISH_ARGS ?? stack?.build?.env?.DOTNET_PUBLISH_ARGS ?? '').split(/\s+/).filter(Boolean);
  return wanted.map((name) => {
    const entry = services[name];
    if (!entry || typeof entry !== 'object' || !entry.project) throw new Error(`stack.services.${name}.project is not set (the .csproj this image is published from)`);
    const repository = entry.image?.name ?? name;
    return {
      service: name,
      image: `${repository}:${tag}`,
      // TESTSTACK_BUILD_ARTIFACTS: the image build's own build output, apart from the checkout's other builds.
      // TESTSTACK_BASELINE: a baseline build only compiles and publishes (no image). --disable-build-servers: no
      // compiler server or reused MSBuild node shared with other builds on the machine (dogfood C6: harness builds
      // failed with Razor errors on valid files, the base commit's too, while the same builds outside it passed).
      args: ['publish', entry.project, '-c', 'Release', ...(env.TESTSTACK_BASELINE === '1' ? [] : ['-t:PublishContainer']), '--os', 'linux', '--arch', platform(env, arch), ...(env.TESTSTACK_BUILD_ARTIFACTS ? ['--artifacts-path', env.TESTSTACK_BUILD_ARTIFACTS] : []), '-p:EnableSdkContainerSupport=true', `-p:ContainerRepository=${repository}`, `-p:ContainerImageTag=${tag}`, '-nologo', '-v', 'q', '--disable-build-servers', ...extra],
    };
  });
}

function main(argv) {
  // .factory/config.json with .factory/app.json (where the services are registered) on top.
  const read = (f) => (fs.existsSync(path.join(process.cwd(), f)) ? JSON.parse(fs.readFileSync(path.join(process.cwd(), f), 'utf8')) : {});
  const base = read('.factory/config.json');
  const app = read('.factory/app.json');
  const config = { ...base, stack: { ...(base.stack ?? {}), ...(app.stack ?? {}), services: { ...(base.stack?.services ?? {}), ...Object.fromEntries(Object.entries(app.stack?.services ?? {}).map(([n, s]) => [n, { ...(base.stack?.services?.[n] ?? {}), ...s }])) } } };
  const commands = publishCommands(config.stack, argv);
  for (const command of commands) {
    console.error(`publish-container: ${command.service} -> ${command.image}`);
    const result = spawnSync('dotnet', command.args, { stdio: ['ignore', 2, 2], env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' } });
    if (result.status !== 0) {
      console.error(`publish-container: dotnet publish failed for ${command.service} (${result.status ?? result.error?.message})`);
      return 1;
    }
  }
  return 0;
}

const isMain = (() => {
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMain) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`publish-container: ${error.message}`);
    process.exitCode = 64;
  }
}
