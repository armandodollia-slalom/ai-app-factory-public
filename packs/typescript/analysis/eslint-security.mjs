#!/usr/bin/env node
// eslint-plugin-security (Apache-2.0) on the changed files, with the factory's ESLint and TypeScript parser and only the
// plugin's recommended rules (the repository's own ESLint config is not used: its style rules are precheck's job). The
// plugin itself comes from the repository's node_modules: the factory does not ship it. Without it, this prints
// "eslint-plugin-security is not installed" and exits 3 (the tool is reported missing, not failed).
//
//   node {packs}/typescript/analysis/eslint-security.mjs <file>...   (run from the repository root; prints ESLint JSON)
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';

const files = process.argv.slice(2);
if (!files.length) {
  process.stdout.write('[]\n');
  process.exit(0);
}
let plugin;
try {
  const resolved = createRequire(path.join(process.cwd(), 'package.json')).resolve('eslint-plugin-security');
  plugin = (await import(pathToFileURL(resolved).href)).default;
} catch {
  process.stderr.write('factory: eslint-plugin-security is not installed in this repository (npm install --save-dev eslint-plugin-security)\n');
  process.exit(3);
}
const recommended = plugin.configs?.recommended ?? { plugins: { security: plugin }, rules: Object.fromEntries(Object.keys(plugin.rules ?? {}).map((r) => [`security/${r}`, 'warn'])) };
const eslint = new ESLint({
  cwd: process.cwd(),
  overrideConfigFile: true,
  errorOnUnmatchedPattern: false,
  overrideConfig: [
    { files: ['**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts}'], languageOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } } } },
    recommended,
  ],
});
const results = await eslint.lintFiles(files);
process.stdout.write(`${JSON.stringify(results.map((r) => ({ filePath: r.filePath, messages: r.messages.map((m) => ({ ruleId: m.ruleId, severity: m.severity, message: m.message, line: m.line })) })))}\n`);
