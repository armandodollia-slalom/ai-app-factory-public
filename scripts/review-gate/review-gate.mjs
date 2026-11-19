#!/usr/bin/env node
// Post-publish review gate for bug-fix PRs. See docs/ai-pipeline/review-gate.md.
//
//   publish --pr <url> --tickets K1,K2 --base <ref>   run by the implement runner right after it opens a
//                                                     fix PR, in the PR's worktree: assess, record, gate
//   status [--pr <url>]                               the gate state recorded on this machine
//   explain <file>... [--impact L --fix-risk L --categories a,b]
//                                                     what the gate would decide for a change to these files
import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from '../pipeline/lib/agents.mjs';
import { parseArgs, runMain } from '../pipeline/lib/cli.mjs';
import { log, readJson, setLogTag } from '../pipeline/lib/util.mjs';
import { gateConfig, gateOff } from './lib/config.mjs';
import { hostFor } from '../pipeline/lib/hosts/index.mjs';
import { realGh } from './lib/github.mjs';
import { enforce, requiredChecksFor } from './lib/enforcement.mjs';
import { autoMergeSetting } from '../factory/lib/github.mjs';
import { codeOwnerReview, factoryCodeOwners } from './lib/codeowners.mjs';
import { loadGateState, publishGate } from './lib/publish.mjs';
import { floorReasons, prClass, prSeverity, ticketSeverity } from './lib/severity.mjs';
import { gateSystemsSettings, overridePathsHit, systemsTouched } from './lib/systems.mjs';

// The gate's decision for a change to `files` with the given triage ratings: systems, floors, severity.
export function explainFiles(config, files, rating) {
  const s = gateSystemsSettings(config);
  const systems = systemsTouched(files, s);
  const floor = floorReasons({ files, added: rating.added ?? [], categories: rating.categories ?? [] }, s, { overridePathsHit });
  const ticket = ticketSeverity({ impact: rating.impact, complexity: rating.complexity, fixRisk: rating.fixRisk, floorReasons: floor, reopens: 0 }, s);
  const pr = prSeverity({ tickets: [{ severity: ticket }], systems }, s);
  return { systems: systems.systems, floorReasons: floor, ticket, pr, class: prClass({ severity: pr.level, shared: systems.shared || systems.contract }) };
}

setLogTag('review-gate');

const USAGE = `Usage: node scripts/review-gate/review-gate.mjs <command> [options]

  assess --tickets K1,K2 --base <ref> --out <file>
        Before the PR exists: the bug-triage rating and the gate's assessment of the branch's change, for
        publish --assessment (the only model call of the gate; implement.preOpen).
  publish --pr <url> --tickets K1,K2 --base <ref> [--assessment <file>] [--json]
                                assess a fix PR the pipeline just opened (run from its worktree)
  regate --pr <url> [--delivery <file>|--delivery-clear]
                                evaluate one gated PR again and rewrite its notice with its current checks
  status [--pr <url>]           the gate state recorded on this machine
  explain <file>... [--impact Low] [--complexity Low] [--fix-risk Low] [--categories auth,...] [--added a,b] [--json]
                                the systems the files belong to, the floors they hit and the severity the
                                gate computes for these ratings (default Low, no category): no LLM, no GitHub
  enforce [--dry-run] [--json]  make the gate binding on the code host: GitHub, a ruleset on the default branch
                                that requires the review-quorum check (and code-owner review when CODEOWNERS
                                exists), admins may bypass; GitLab, "Pipelines must succeed" and code owner
                                approval; Azure DevOps, a Status policy (required reviewers listed for you).
                                A repository setting: run it yourself (setup-board skill)`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArgs(rest, new Set(['pr', 'tickets', 'base', 'impact', 'complexity', 'fix-risk', 'categories', 'added', 'delivery', 'assessment', 'out']));
  if (!command || command === 'help' || flags.help) {
    console.log(USAGE);
    return 0;
  }
  const config = gateConfig();
  const deps = { gh: realGh, runAgent, log };

  switch (command) {
    case 'publish': {
      const keys = String(flags.tickets ?? '').split(',').map((k) => k.trim().toUpperCase()).filter(Boolean);
      if (typeof flags.pr !== 'string' || !keys.length || typeof flags.base !== 'string') {
        console.error('Usage: review-gate publish --pr <url> --tickets K1,K2 --base <ref>');
        return 2;
      }
      const off = gateOff(config);
      if (off) {
        console.log(`Review gate off (${off}); ${flags.pr} not assessed.`);
        return 0;
      }
      // --assessment <file>: the assessment `assess` computed before the PR opened (implement.preOpen): no model call now.
      const assessment = typeof flags.assessment === 'string' ? JSON.parse(fs.readFileSync(path.resolve(flags.assessment), 'utf8')) : null;
      const r = publishGate(config, { pr: flags.pr, keys, base: flags.base, assessment }, deps);
      if (flags.json) console.log(JSON.stringify({ pr: flags.pr, severity: r.assessment.severity.level, class: r.assessment.class, action: r.decision.action, approvals: r.decision.approvals, problems: r.problems }));
      else console.log(`${flags.pr}: severity ${r.assessment.severity.level ?? 'unknown'}, ${r.decision.action}${r.decision.action === 'review' ? ` (${r.decision.approvals} approval(s))` : ''}.`);
      return 0;
    }

    case 'assess': {
      // Before the PR exists (implement.preOpen): the bug-triage rating and the gate's assessment of the branch's change
      // against the base, written to --out for `publish --assessment` at open. The only model call of the gate.
      const keys = String(flags.tickets ?? '').split(',').map((k) => k.trim().toUpperCase()).filter(Boolean);
      if (!keys.length || typeof flags.base !== 'string' || typeof flags.out !== 'string') {
        console.error('Usage: review-gate assess --tickets K1,K2 --base <ref> --out <file>');
        return 2;
      }
      const off = gateOff(config);
      if (off) {
        console.log(`Review gate off (${off}); not assessed.`);
        return 0;
      }
      const { assessPr } = await import('./lib/assessment.mjs');
      const a = assessPr(config, { pr: null, keys, base: flags.base }, deps);
      fs.mkdirSync(path.dirname(path.resolve(flags.out)), { recursive: true });
      fs.writeFileSync(path.resolve(flags.out), JSON.stringify(a, null, 2));
      console.log(`assessed before the PR: severity ${a.severity.level ?? 'unknown'} (${a.tickets.map((t) => `${t.key} ${t.severity.level ?? '?'}, confidence ${t.confidence.score}`).join('; ')})`);
      return 0;
    }

    case 'regate': {
      // One gated PR evaluated again from what GitHub holds, its notice rewritten with its current checks: run by
      // `implement` once the PR's CI has finished (council C4: notices said "checks: pending" hours after CI).
      if (typeof flags.pr !== 'string') {
        console.error('Usage: review-gate regate --pr <url>');
        return 2;
      }
      const { readPrState } = await import('./lib/gate.mjs');
      const { regate } = await import('./lib/sync.mjs');
      const prior = readPrState(realGh, config.board.repo, flags.pr);
      if (!prior) {
        console.log(`${flags.pr}: no gate notice to evaluate again.`);
        return 0;
      }
      // --delivery <file>: what the CI gate left for a person (council C7); --delivery-clear: a later CI gate passed.
      const delivery = typeof flags.delivery === 'string' ? JSON.parse(fs.readFileSync(path.resolve(flags.delivery), 'utf8')) : flags['delivery-clear'] ? null : undefined;
      const r = regate(config, realGh, flags.pr, { prior, log, delivery });
      console.log(`${flags.pr}: ${r.decision.action}${r.merged ? ' (merged)' : ''}; checks ${r.state.ci ?? 'none'}.`);
      return 0;
    }

    case 'status': {
      const dir = path.join(config.root, config.stateDir, 'review-gate');
      const states = typeof flags.pr === 'string' ? [loadGateState(config, flags.pr)].filter(Boolean) : fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(dir, f), null)).filter(Boolean) : [];
      if (!states.length) console.log('No fix PR assessed on this machine.');
      for (const s of states) {
        const a = s.assessment;
        console.log(`${s.pr}  ${a?.class ?? '-'}  ${s.gate?.action ?? 'assessed'}${s.gate?.approvals ? ` (${s.gate.approvals} approval(s))` : ''}`);
        for (const t of a?.tickets ?? []) console.log(`  ${t.key.padEnd(10)} ${String(t.severity?.level ?? '-').padEnd(7)} confidence ${t.confidence?.score ?? '-'}${t.confidence?.high ? ' (high)' : ''}  ${t.severity?.explanation ?? ''}`);
      }
      return 0;
    }

    case 'explain': {
      if (!positional?.length) {
        console.error('Usage: review-gate explain <file>... [--impact Low] [--fix-risk Low] [--categories a,b]');
        return 2;
      }
      const r = explainFiles(config, positional, { impact: flags.impact ?? 'Low', complexity: flags.complexity ?? 'Low', fixRisk: flags['fix-risk'] ?? 'Low', categories: String(flags.categories ?? '').split(',').filter(Boolean), added: String(flags.added ?? '').split(',').filter(Boolean) });
      if (flags.json) console.log(JSON.stringify(r));
      else {
        console.log(`systems: ${r.systems.map((x) => `${x.name}${x.shared ? ' (shared)' : ''}${x.contract ? ' (contract)' : ''}`).join(', ') || 'none (ignored files)'}`);
        console.log(`floors: ${r.floorReasons.join(', ') || 'none'}`);
        console.log(`ticket severity: ${r.ticket.level} (${r.ticket.explanation})`);
        console.log(`PR severity: ${r.pr.level} (${r.pr.explanation})  class ${r.class}`);
      }
      return 0;
    }

    case 'enforce': {
      if (process.env.PIPELINE_CHILD === '1') {
        console.error('review-gate enforce changes a repository setting: a person runs it, not an agent.');
        return 2;
      }
      let host;
      try {
        host = hostFor(config, { gh: realGh, repo: config.board?.repo });
      } catch (error) {
        console.error(`the code host is unknown (${error.message}): set host in .factory/config.json, or add an origin remote.`);
        return 2;
      }
      if (!String(host.repo ?? '')) {
        console.error('the repository to enforce the gate on is unknown: set host.repo (or board.repo) in .factory/config.json.');
        return 2;
      }
      // Code owners: a CODEOWNERS file (GitHub, GitLab), or owners in .factory/factory.json (Azure DevOps has
      // no CODEOWNERS; the adapter lists the required-reviewers policy for a person).
      const ownersFile = ['.github/CODEOWNERS', '.gitlab/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'].some((f) => fs.existsSync(path.join(config.root, f)));
      const pinned = readJson(path.join(config.root, '.factory/factory.json'), {})?.owners ?? [];
      // A host without a CODEOWNERS file takes the owners pinned in .factory/factory.json (it lists the policy to add).
      const codeOwners = ownersFile || (host.capabilities?.codeOwners === 'partial' && pinned.length > 0);
      // Who opens the pipeline's PRs: the PR bot when it is set up, else the developer's own login. A code-owner rule
      // only that author could meet is never required (codeowners.mjs).
      let review = { satisfiable: true };
      try {
        review = codeOwnerReview({ owners: factoryCodeOwners(config.root), author: host.bot?.author?.() ?? null, botConfigured: Boolean(host.bot?.configured?.()) });
      } catch {
        /* the author cannot be told: the plain rule */
      }
      const requiredChecks = requiredChecksFor(config);
      let r;
      try {
        r = await enforce(host, { codeOwners, review, requiredChecks, dryRun: Boolean(flags['dry-run']) });
      } catch (error) {
        if (error.name !== 'UnsupportedError' && !error.exitCode) throw error;
        console.error(error.message);
        return error.exitCode ?? 3;
      }
      if (flags.json) console.log(JSON.stringify(r));
      else {
        for (const w of r.warnings ?? []) console.log(`WARNING: ${w}`);
        console.log(`${String(host.repo)}: ${r.summary}.`);
        for (const m of r.manual ?? []) console.log(`  by hand: ${m}`);
        // The repository's own test jobs that are not required, and why (council C10, Opus 5): a person merging by hand
        // is not stopped by them. Requiring one needs a distinct job name and a workflow that runs for every PR.
        let uncovered = [];
        try {
          const { ciFor } = await import('../pipeline/lib/ci/index.mjs');
          uncovered = ciFor(config).uncoveredChecks?.(config.root) ?? [];
        } catch {
          // no CI definitions to read
        }
        for (const u of uncovered) console.log(`WARNING: the application's check "${u.name}" (${u.workflow}, job ${u.job}) ${u.shared ? 'shares a required name' : 'is not required'}: ${u.reason}`);
      }
      // The auto-merge setting is reported, not changed: it is the owner's call (docs/ai-pipeline/setup.md).
      const auto = autoMergeSetting(host.sync);
      if (auto && !flags.json) console.log(`${auto[0] ? 'ok' : 'WARNING'}: ${auto[1]}`);
      if (auto && !auto[0] && flags.json) console.error(`WARNING: ${auto[1]}`);
      return 0;
    }

    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      return 2;
  }
}

runMain(main, 'review-gate');
