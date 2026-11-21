#!/usr/bin/env node
// `factory video install | status | render`: the local demo-video toolchain (narration and ffmpeg) and a one-off render.
// See docs/ai-pipeline/pr-demo-video.md.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from '../pipeline/lib/cli.mjs';
import { loadConfig, repoRoot } from '../pipeline/lib/config.mjs';
import { log, setLogTag } from '../pipeline/lib/util.mjs';
import { renderVideo } from './lib/render.mjs';
import { installTools, resolveTools, statusLines } from './lib/tools.mjs';

setLogTag('video');

const USAGE = `Usage: factory video <command>

  install   Create the narration virtualenv (kokoro-onnx, soundfile, imageio-ffmpeg at pinned versions) and download
            the Kokoro model files, checked against their pinned size and SHA-256 (packs/video/tools.json).
  status    Where the toolchain is, which ffmpeg is used, whether narration is on, and the licence of every item.
  render <video.webm> [--steps <video.steps.json>] [--out <dir>]
            Render one recorded video as the delivery does (narration, holds, masks, .vtt, secret check).`;

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2), new Set(['steps', 'out']));
  const [command, file] = positional;
  const root = (() => {
    try {
      return repoRoot();
    } catch {
      return process.cwd();
    }
  })();
  const config = (() => {
    try {
      return loadConfig('pr-video', root);
    } catch {
      return {};
    }
  })();
  if (command === 'install') {
    await installTools({ config, log });
    for (const l of statusLines(config)) console.log(l);
    return 0;
  }
  if (command === 'status') {
    for (const l of statusLines(config)) console.log(l);
    return resolveTools(config).ffmpeg ? 0 : 1;
  }
  if (command === 'render') {
    if (!file) throw new Error('render needs a video file');
    const stepsFile = flags.steps ?? file.replace(/\.webm$/, '.steps.json');
    const steps = fs.existsSync(stepsFile) ? JSON.parse(fs.readFileSync(stepsFile, 'utf8')) : null;
    const out = path.resolve(flags.out ?? path.dirname(file));
    const report = renderVideo({ video: path.resolve(file), steps, outDir: out, name: `${path.basename(file, '.webm')}.demo`, tools: resolveTools(config), log });
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }
  console.error(USAGE);
  return command ? 64 : 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`[video] ${error.message}`);
    process.exit(1);
  },
);
