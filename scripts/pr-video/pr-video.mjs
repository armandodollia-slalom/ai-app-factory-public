#!/usr/bin/env node
// PR demo videos: records the e2e specs a pull request changes and adds the videos to the PR
// description. Run by .github/workflows/pr-demo-video.yml; see docs/ai-pipeline/pr-demo-video.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from '../pipeline/lib/cli.mjs';
import { loadConfig, repoRoot } from '../pipeline/lib/config.mjs';
import { log, setLogTag } from '../pipeline/lib/util.mjs';
import { hostFor } from '../pipeline/lib/hosts/index.mjs';
import { API_MARKERS, expandOpenApiPorts, allEndpoints, apiSettings, apiSources, buildApiSummary, changeScope, changedEndpoints, changedProtos, changedFromOpenApi, loadExtractor, loadOpenApi, openApiFiles, recordedExchanges, renderApiSection } from './lib/api-summary.mjs';
import { loadConfig as loadStackConfig, slotPorts } from '../stack/lib/ports.mjs';
import { changedSpecs, keyFolder, prFolder, publishFolder, renderSection, stageVideos, writePrSection } from './lib/pr-video.mjs';

// The host ports of the test stack slot in use, or null when the repository has no stack.
function stackPorts(root) {
  try {
    const config = loadStackConfig(root);
    return Object.keys(config.ports ?? {}).length ? slotPorts(process.env.TESTSTACK_SLOT || '0', config) : null;
  } catch {
    return null;
  }
}

setLogTag('pr-video');

const USAGE = `Usage: node scripts/pr-video/pr-video.mjs <command> [options]

  specs --base <ref>
        Print the e2e specs (prVideo.specPatterns) changed since the merge base with <ref>, one per line.
  publish --pr <n> [--specs <a,b>] [--videos-dir <prVideo.videosDir>] [--note <text>] [--remove]
          [--branch pr-videos] [--head-sha <sha>] [--run-url <url>]
        Push the recorded videos to the storage branch and update the PR's "Demo video" section.
        --note writes the note instead of videos (and removes the PR's old videos). --remove removes
        the section and the PR's videos (for PRs that don't change the frontend).
  scope --base <ref>
        Print what the PR changes as key=value lines (for $GITHUB_OUTPUT): frontend, backend,
        video (frontend changed) and api (backend changed, frontend not).
  api --base <ref> (--pr <n> | --dry-run) [--manifest <prVideo.videosDir>/manifest.json]
      [--openapi <url,url>] [--specs <a,b>] [--head-sha <sha>] [--run-url <url>]
      [--api true|false --frontend true|false]   the scope from \`scope\`, so it is not diffed again
        Document the HTTP endpoints the PR adds, changes or removes (method, route, parameters, request
        and response types from OpenAPI, and example calls recorded with E2E_API_LOG=1) in the PR's
        "API changes" section, or print it with --dry-run. Only for backend-only PRs; removes the section
        when the PR also changes the frontend or there is nothing to show. The endpoints come from the
        route extractor in prVideo.api.extractor, else from the OpenAPI files in prVideo.api.openapi
        compared with the merge base; with neither configured the section is skipped with a note.

Frontend and backend are told apart by the project model in .factory/app.json (project.frontendPaths,
project.services[].kind) and prVideo.backendPaths / prVideo.neutralPaths.
  cleanup --pr <n> [--branch pr-videos]
        Remove the PR's videos from the storage branch.

Needs git push access and the gh CLI (GH_TOKEN).`;

const VALUE_FLAGS = new Set(['key', 'base', 'pr', 'specs', 'videos-dir', 'note', 'branch', 'head-sha', 'run-url', 'manifest', 'openapi', 'api', 'frontend']);

// A section written for a branch before its PR exists: one file in its own folder of the storage branch, with the head.
function storeKeyed(root, { branch, folder, file, text }) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-video-key-'));
  try {
    fs.writeFileSync(path.join(stage, file), `<!-- head: ${process.env.HEAD_SHA ?? ''} -->\n${text}\n`);
    publishFolder(root, { branch, folder, stageDir: stage, message: `${file} of ${folder}` });
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2), VALUE_FLAGS);
  const [command] = positional;
  const root = repoRoot();
  const config = loadConfig('pr-video', root);
  // The code host the PR lives on (GitHub's GITHUB_REPOSITORY wins, as before the adapters).
  const prHost = hostFor(config, process.env.GITHUB_REPOSITORY ? { repo: process.env.GITHUB_REPOSITORY } : {});
  const settings = { specPatterns: [], videosDir: 'artifacts/e2e-videos', storageBranch: 'pr-videos', ...(config.prVideo ?? {}) };
  const branch = flags.branch ?? settings.storageBranch;
  const pr = Number(flags.pr);

  if (command === 'specs') {
    if (!flags.base) throw new Error('specs needs --base <ref>');
    if (!settings.specPatterns.length) log('no e2e spec pattern is configured (prVideo.specPatterns in .factory/config.json): no specs to record');
    for (const spec of changedSpecs(root, flags.base, settings.specPatterns)) console.log(spec);
    return 0;
  }
  if (command === 'scope') {
    if (!flags.base) throw new Error('scope needs --base <ref>');
    for (const [key, value] of Object.entries(changeScope(root, flags.base, config))) console.log(`${key}=${value}`);
    return 0;
  }
  if (command === 'api') {
    if (!flags.base) throw new Error('api needs --base <ref>');
    if (!(pr > 0) && !flags['dry-run'] && !flags.key) throw new Error('api needs --pr <n>, --key <branch> or --dry-run');
    // --key: no PR yet (implement.preOpen); the section is stored next to the branch's videos for the pipeline's body.
    const who = flags.key ? flags.key : `PR #${pr}`;
    const writeSection = (section) => (flags.key ? storeKeyed(root, { branch, folder: `${keyFolder(flags.key)}-api`, file: 'api.md', text: section ?? '' }) : writePrSection(config, pr, section, API_MARKERS));
    // The workflow passes the scope its first step already worked out (--api, --frontend), so this
    // step does not have to diff the PR again.
    const scope = !flags.api ? changeScope(root, flags.base, config) : { api: flags.api === 'true', frontend: flags.frontend === 'true' };
    if (!scope.api) {
      const reason = 'the PR changes no backend code';
      if (flags['dry-run']) console.log(`(no API changes section: ${reason})`);
      else {
        writeSection(null);
        log(`${who}: no API changes section (${reason})`);
      }
      return 0;
    }
    const manifestFile = path.resolve(root, flags.manifest ?? path.join(settings.videosDir, 'manifest.json'));
    const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
    const api = apiSettings(config);
    const openapi = flags.openapi ? String(flags.openapi).split(',').filter(Boolean) : api.openapi;
    const sources = apiSources({ ...config, prVideo: { ...config.prVideo, api: { ...api, openapi } } });
    const exchanges = recordedExchanges(manifest);
    const protos = changedProtos(root, flags.base);
    if (!sources.ok && !exchanges.length) {
      // Nothing to read the endpoints from: skip, and say why, rather than guess a framework (a changed gRPC contract is
      // still named).
      const grpcOnly = renderApiSection({ endpoints: [], headSha: flags['head-sha'], runUrl: flags['run-url'], origin: sources.reason, protos });
      if (flags['dry-run']) console.log(grpcOnly ?? `(no API changes section: ${sources.reason})`);
      else {
        writeSection(grpcOnly);
        log(`${who}: no API changes section (${sources.reason})`);
      }
      return 0;
    }
    if (!sources.ok) log(`API summary from the recorded calls only: ${sources.reason}`);
    const extractor = sources.mode === 'extractor' ? await loadExtractor(config) : null;
    const changed = extractor ? changedEndpoints(root, flags.base, { extractor, config }) : changedFromOpenApi(openApiFiles(root, flags.base, openapi), config.project);
    const origin = extractor ? `read by the \`${extractor.id}\` route extractor` : sources.mode === 'openapi' ? 'from the OpenAPI files compared with the merge base' : null;
    const endpoints = buildApiSummary({
      changed,
      known: allEndpoints(root, { extractor, config }),
      exchanges,
      docs: await loadOpenApi(expandOpenApiPorts(openapi, stackPorts(root), log), globalThis.fetch, root),
    });
    const specs = typeof flags.specs === 'string' ? flags.specs.split(',').filter(Boolean) : []; // an empty --specs "" parses as true
    const section = renderApiSection({ endpoints, headSha: flags['head-sha'], runUrl: flags['run-url'], specs, origin, protos });
    if (flags['dry-run']) {
      console.log(section ?? '(no API changes)');
      return 0;
    }
    writeSection(section);
    log(`${who}: ${section ? `API changes section lists ${endpoints.length} endpoint(s)${/gRPC contract changes are not extracted/.test(section) ? ' and names the changed gRPC contract' : ''}` : 'no API changes, section removed'}`);
    return 0;
  }
  if (command === 'publish' || command === 'cleanup') {
    if (!(pr > 0) && !flags.key) throw new Error(`${command} needs --pr <n> or --key <branch>`);
    const keyed = !(pr > 0);
    const folder = keyed ? keyFolder(flags.key) : prFolder(pr);
    const who = keyed ? flags.key : `PR #${pr}`;
    if (keyed && command === 'cleanup') {
      publishFolder(root, { branch, folder, stageDir: null, message: `Remove demo videos of ${who}` });
      publishFolder(root, { branch, folder: `${folder}-api`, stageDir: null, message: `Remove the API summary of ${who}` });
      log(`removed ${folder} from ${branch}`);
      return 0;
    }
    if (command === 'cleanup') {
      const r = publishFolder(root, { branch, folder, stageDir: null, message: `Remove demo videos of PR #${pr}` });
      log(r.pushed ? `removed ${folder} from ${branch}` : `${branch} has no ${folder}`);
      return 0;
    }
    if (flags.remove) {
      publishFolder(root, { branch, folder, stageDir: null, message: `Remove demo videos of ${who}` });
      if (keyed) storeKeyed(root, { branch, folder, file: 'section.md', text: '' });
      else writePrSection(config, pr, null);
      log(`${who}: no frontend changes, no demo video section`);
      return 0;
    }
    const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-video-stage-'));
    try {
      const videos = flags.note ? [] : stageVideos(path.resolve(root, flags['videos-dir'] ?? settings.videosDir), stageDir);
      const specs = typeof flags.specs === 'string' ? flags.specs.split(',').filter(Boolean) : []; // an empty --specs "" parses as true
      const note = flags.note || (videos.length ? null : 'The changed e2e specs recorded no video (API-only tests have no browser, or the run failed before any test started).');
      const section = renderSection({ repo: String(prHost.repo), fileUrl: (file, opts) => prHost.fileUrl(file, branch, opts), branch, pr, headSha: flags['head-sha'], runUrl: flags['run-url'], specs, videos, note, folder });
      // Keyed (no PR yet): the section goes with the videos as section.md, with the head it was recorded on.
      if (keyed) fs.writeFileSync(path.join(stageDir, 'section.md'), `<!-- head: ${flags['head-sha'] ?? ''} -->\n${section}\n`);
      publishFolder(root, { branch, folder, stageDir: videos.length || keyed ? stageDir : null, message: `Demo videos of ${who}${flags['head-sha'] ? ` at ${flags['head-sha'].slice(0, 7)}` : ''}` });
      if (!keyed) writePrSection(config, pr, section);
      log(`${who}: ${videos.length ? `${videos.length} video(s) published to ${branch}/${folder}` : 'note written'}`);
    } finally {
      fs.rmSync(stageDir, { recursive: true, force: true });
    }
    return 0;
  }
  console.error(USAGE);
  return command ? 64 : 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`[pr-video] ${error.message}`);
    process.exit(1);
  },
);
