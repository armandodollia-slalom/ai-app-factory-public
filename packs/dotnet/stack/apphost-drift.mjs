#!/usr/bin/env node
// Test stack command of the dotnet pack: `factory teststack drift`. The test stack's compose file must be what
// the application's Aspire AppHost publishes now (stack.publish: packs/dotnet/stack/aspire-publish.mjs), plus
// the declared test-only overrides. This publishes again into a temporary folder and fails on any difference,
// like `factory teststack publish --check`: the AppHost is executed, not parsed, so every form of wiring counts.
//
// It never answers a plain "ok" for something it did not compare: without an AppHost there is nothing to compare
// (said in the result), and an AppHost whose stack is not published from it (stack.publish unset, a hand-written
// compose file) fails, because nothing would notice the two drifting apart.
import fs from 'node:fs';
import path from 'node:path';
import { publish } from '../../../scripts/teststack/lib/images.mjs';
import { findAppHost } from './aspire-publish.mjs';

/** Test stack command: `factory teststack drift`. */
export default async function command(_args, ctx) {
  let appHost;
  try {
    appHost = findAppHost(ctx.root, ctx.stack.publishAppHost);
  } catch (error) {
    if (/no Aspire AppHost/.test(error.message)) return { compared: false, note: 'no Aspire AppHost: nothing to compare' };
    throw Object.assign(error, { exitCode: 64 });
  }
  if (!ctx.stack.publish) {
    throw Object.assign(new Error(`${path.relative(ctx.root, appHost)} composes the application, but the test stack is not published from it (stack.publish is not set), so drift cannot be checked. Set stack.publish to "node {packs}/dotnet/stack/aspire-publish.mjs --out {out}" and add the AppHost's test-stack hook (setup-teststack skill).`), { exitCode: 1 });
  }
  const result = await publish(ctx, { check: true });
  const compose = path.relative(ctx.root, ctx.composeFile);
  return { compared: true, appHost: path.relative(ctx.root, appHost), compose, check: result.check, services: Object.keys((await import('yaml')).parse(fs.readFileSync(ctx.composeFile, 'utf8'))?.services ?? {}).length };
}
