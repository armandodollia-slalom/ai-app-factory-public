#!/usr/bin/env node
// Retro stage: turns what the agents logged (verifier denials, review findings, product bugs, PR check
// findings, how people reviewed the pipeline's PRs) into lessons for this repository and proposed fixes
// to the factory itself. See docs/ai-pipeline/retro.md.
import { parseArgs, readStdin, runMain } from '../pipeline/lib/cli.mjs';
import { isDisabled, loadConfig } from '../pipeline/lib/config.mjs';
import { git, mergeBase, revExists } from '../pipeline/lib/git.mjs';
import { checkScorecardPush, computeScorecard, scorecardPath, scorecardProblems, scorecardRecords, writeScorecard } from '../pipeline/lib/scorecard.mjs';
import { lessonsDisabled } from '../pipeline/lib/run-tags.mjs';
import { sinkSettings } from '../pipeline/lib/sink.mjs';
import { readJson, setLogTag } from '../pipeline/lib/util.mjs';
import { spawnBackground } from '../pipeline/lib/background.mjs';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LESSONS_KEY, calibrateCommand, factorySource, formatLessonsRecovery, lessonsCommand, lessonsRunFile, recoverLessons } from './lib/lessons.mjs';
import { LESSONS_STAGE } from '../pipeline/lib/decisions.mjs';

setLogTag('retro');

const USAGE = `Usage: factory retro <command> [options]

  run [--dry-run] [--local] [--if-due] [--no-push] [--resume] [--since <ISO date>|all]
                          read the metrics (this checkout's, plus the remote store's when it can be
                          read back), update the lessons files, hold the factory retro over the
                          decision log, and open the pull requests: one in this repository (lessons,
                          agent addenda, policy) and, for root causes every codebase would hit, one
                          against the factory. --local edits this checkout instead of a branch;
                          --dry-run only reports what it would ask for
  calibrate [--stage plan|automation] [--sample <n>]
                          audit recent passing verifier verdicts with a stricter auditor
  scorecard [--check]     compute the council scorecard from the records and write it beside the lessons
                          (<lessonsDir>/scorecard.json); --check only says whether the file there is
                          the pipeline's own and matches the records, and exits 1 when it is not
  status                  the last run, the metrics store, and where factory fixes would go
  resume [--force]        continue a run that died (crash, kill, reboot)
  selftest                a plumbing check of the factory pull request path, not a proposal: pushes a
                          branch retro/selftest-<date> with one scratch file to the factory source the
                          pin names, opens the PR "retro self-test (no change proposed)", verifies it,
                          then closes it and deletes the branch

Hooks (called by the dispatcher)
  hook session-start
  git-hook post-merge     runs \`run --if-due\` in the background, only with \`git config retro.auto true\`
  git-hook pre-push       refuses a push that changes the scorecard by hand`;

const SELF = fileURLToPath(import.meta.url);

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest, new Set(['stage', 'sample', 'since']));
  if (!command || command === 'help' || flags.help) {
    console.log(USAGE);
    return 0;
  }
  // The lessons code reads the feature verification settings (loops, categories, timeouts) too.
  const config = loadConfig('feature-verification');
  switch (command) {
    case 'run': {
      const result = await lessonsCommand(config, { dryRun: Boolean(flags['dry-run']), local: Boolean(flags.local), ifDue: Boolean(flags['if-due']), push: !flags['no-push'], resume: Boolean(flags.resume), since: typeof flags.since === 'string' ? flags.since : null });
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    case 'calibrate': {
      console.log(JSON.stringify(calibrateCommand(config, { stage: flags.stage ?? null, sample: Number(flags.sample ?? 3) }), null, 2));
      return 0;
    }
    case 'status': {
      const run = readJson(lessonsRunFile(config), null);
      const sink = sinkSettings(config);
      const src = factorySource(config);
      console.log(run ? `Last run: ${run.status}${run.phase ? ` (${run.phase})` : ''}${run.branch ? ` on ${run.branch}` : ''}${run.finishedAt ? `, finished ${run.finishedAt}` : ''}.` : 'No retro has run in this checkout.');
      console.log(`Metrics: ${sink.canPull ? `this checkout plus the ${sink.type} store` : sink.type === 'none' ? 'this checkout only (no metrics store configured)' : `this checkout only (the ${sink.type} store cannot be read back)`}.`);
      console.log(`Factory fixes: ${src ? (src.source ? `a pull request against ${src.source}` : 'saved as a patch (the factory install has no remote)') : 'in this repository (no separate factory checkout)'}.`);
      return 0;
    }
    case 'selftest': {
      const { retroSelftest } = await import('./lib/selftest.mjs');
      const r = retroSelftest(config);
      console.log(JSON.stringify(r, null, 2));
      return r.status === 'passed' ? 0 : 1;
    }
    case 'resume': {
      const r = recoverLessons(config, { force: Boolean(flags.force) });
      console.log(r ? formatLessonsRecovery(r) : 'No interrupted retro run.');
      return 0;
    }
    case 'hook': {
      if (isDisabled()) return 0;
      if (positional[0] === 'session-start') {
        const r = recoverLessons(config);
        if (r) process.stdout.write(formatLessonsRecovery(r));
      }
      return 0;
    }
    case 'scorecard': {
      if (flags.check) {
        const file = scorecardPath(config);
        const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
        const problems = text === null ? ['there is no scorecard yet'] : scorecardProblems(config, text);
        if (!problems.length && JSON.parse(text).version !== computeScorecard(config, scorecardRecords(config)).version) problems.push('it is out of date: newer records give other numbers (`factory retro scorecard` writes them)');
        console.log(problems.length ? `scorecard: ${problems.join('; ')}` : 'scorecard: the pipeline\'s own');
        return problems.length ? 1 : 0;
      }
      const { doc, changed } = writeScorecard(config);
      console.log(`scorecard ${doc.version}: ${doc.rows.length} row(s), ${doc.rows.filter((r) => r.unknown).length} unknown${changed ? '' : ' (unchanged)'}`);
      return 0;
    }
    case 'git-hook': {
      // A hand edit of the pipeline's scorecard is refused, as for the other files the pipeline owns.
      if (positional[0] === 'pre-push') {
        if (isDisabled()) return 0;
        const from = (remoteSha) => (/^0+$/.test(remoteSha ?? '') || !revExists(config.root, remoteSha) ? mergeBase(config.root, config.baseRef) : remoteSha);
        return checkScorecardPush(config, await readStdin(), { from }) ? 1 : 0;
      }
      if (isDisabled() || lessonsDisabled() || positional[0] !== 'post-merge') return 0;
      const on = (key) => git(config.root, ['config', '--bool', key]).stdout.trim() === 'true';
      // fv.autoLessons is the name this switch had while the retro lived in the feature verification stage.
      if (on('retro.auto') || on('fv.autoLessons')) spawnBackground(config, { script: SELF, key: LESSONS_KEY, stage: LESSONS_STAGE, args: ['run', '--if-due'] });
      return 0;
    }
    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      return 2;
  }
}

runMain(main, 'retro');
