// A stand-in for a commercial scanner's CLI (Snyk Code's shape: SARIF to the file it is given, exit 1 on findings,
// exit 2 and an authentication error without its token). It reads src/db.js of the checkout it runs in:
//   a line with `query(`        -> CWE-89, security-severity 8.0 (high)
//   a line with `eval(`         -> CWE-95, security-severity 9.5, triaged in the vendor's system (false positive)
//   a line with `console.log(`  -> CWE-532, security-severity 2.0 (low)
// --flavor oss: an open-source tool's report of the same query( line (level warning, CWE-89 tag, no severity score).
import fs from 'node:fs';

const args = process.argv.slice(2);
const out = args[0];
const oss = args.includes('--flavor') && args[args.indexOf('--flavor') + 1] === 'oss';
if (!oss && process.env.SNYK_TOKEN !== 'good-token') {
  console.error('Authentication error (SNYK-0005): the token is missing or wrong');
  process.exit(2);
}
let text = '';
try {
  text = fs.readFileSync('src/db.js', 'utf8');
} catch {
  /* no file: no findings */
}
const results = [];
const rules = [];
text.split('\n').forEach((line, i) => {
  const at = (ruleId, extra = {}) => ({ ruleId, level: 'error', message: { text: `${ruleId} on line ${i + 1}` }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/db.js' }, region: { startLine: i + 1 } } }], ...extra });
  if (line.includes('query(')) results.push(oss ? at('oss/sqli', { level: 'warning' }) : at('javascript/Sqli', { properties: { 'security-severity': '8.0' } }));
  if (!oss && line.includes('eval(')) results.push(at('javascript/CodeInjection', { properties: { 'security-severity': '9.5' }, suppressions: [{ kind: 'external', status: 'accepted', justification: 'False positive: test fixture only' }] }));
  if (!oss && line.includes('console.log(')) results.push(at('javascript/LogLeak', { level: 'note', properties: { 'security-severity': '2.0' } }));
});
if (oss) rules.push({ id: 'oss/sqli', properties: { tags: ['security', 'CWE-89: SQL Injection'] } });
else rules.push({ id: 'javascript/Sqli', properties: { cwe: ['CWE-89'] } }, { id: 'javascript/CodeInjection', properties: { cwe: ['CWE-95'] } }, { id: 'javascript/LogLeak', properties: { cwe: ['CWE-532'] } });
fs.writeFileSync(out, JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: oss ? 'oss' : 'SnykCode', rules } }, results }] }));
process.exit(results.length && !oss ? 1 : 0);
