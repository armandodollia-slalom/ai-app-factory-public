#!/usr/bin/env node
// ESLint for a repository that has TypeScript or JavaScript its agents touch (Playwright specs, scripts) but
// no ESLint of its own: the factory's ESLint with the recommended JavaScript and typescript-eslint rules
// (no type information needed), browser and Node globals. A repository with its own ESLint config uses that
// instead (factory init drafts its node_modules/.bin/eslint).
//
//   node {packs}/typescript/lint/eslint.mjs [--fix] <file>...      (run from the repository root)
//
// Output is ESLint's stylish format; exit 1 when a file has an error.
import js from '@eslint/js';
import { ESLint } from 'eslint';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const args = process.argv.slice(2);
const fix = args.includes('--fix');
const files = args.filter((a) => a !== '--fix');
if (!files.length) process.exit(0);

const eslint = new ESLint({
  cwd: process.cwd(),
  fix,
  overrideConfigFile: true,
  errorOnUnmatchedPattern: false,
  overrideConfig: [
    js.configs.recommended,
    ...tseslint.configs.recommended,
    { languageOptions: { globals: { ...globals.node, ...globals.browser }, ecmaVersion: 'latest', sourceType: 'module' } },
    { files: ['**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts}'] },
    { files: ['**/*.{jsx,tsx}'], languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } } },
    { files: ['**/*.cjs'], languageOptions: { sourceType: 'commonjs' } },
  ],
});
const results = await eslint.lintFiles(files);
if (fix) await ESLint.outputFixes(results);
const text = (await eslint.loadFormatter('stylish')).format(results);
if (text) process.stdout.write(`${text}\n`);
process.exitCode = results.some((r) => r.errorCount > 0) ? 1 : 0;
