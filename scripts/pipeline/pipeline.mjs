#!/usr/bin/env node
// AI development pipeline: one entry point for agent and git lifecycle hooks, dispatched to the
// stages listed in stages.json. See docs/ai-pipeline/README.md.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { readPayload, readPayloadStrict, readStdin, parseArgs, requireStory, runMain } from './lib/cli.mjs';
import { INSTALL_ROOT, isDisabled, loadConfig } from './lib/config.mjs';
import { epicReport, findEpic, formatEpic, formatOverview, formatStory, overviewReport, storyReport } from './lib/costs.mjs';
import { dispatchGitHook, dispatchSessionStart, dispatchStop, dispatchText, loadStages, runStage, sessionStartOutput } from './lib/dispatch.mjs';
import { experimentReport, formatReport, gradeExperiment, runExperiment } from './lib/experiment.mjs';
import { git, implChanges } from './lib/git.mjs';
import { changedFiles, lintChanged } from './lib/lint.mjs';
import { listEscalations, loadState, setActiveStory, updateState } from './lib/state.mjs';
import { activeStory } from './lib/stories.mjs';
import { botSetup, botStatus } from './lib/bot-setup.mjs';
import { mockupsDir } from './lib/tickets.mjs';
import { factoryGuard } from './lib/factory-guard.mjs';
import { pushInBackground } from './lib/sink.mjs';
import { denyOutput, installGuard, networkGuard, storyGuard, foreignTestGuard, stackGuard, ticketWriteGuard } from './lib/story-guard.mjs';
import { loadUsageAcrossWorktrees } from './lib/usage.mjs';
import { nowIso } from './lib/util.mjs';
import { recordGraphifyCall } from './lib/search-calls.mjs';

const CMD = 'factory';

const USAGE = `Usage: ${CMD} <command> [options]

Implementation agent
  start <story>                 set the story you are working on (resets its review)
  done [story]                  mark the line of work complete; the stages run when your turn ends
  status [story]                state of every stage for a story
  resume [story] [--force]      continue every stage's runs that died (crash, kill, reboot): implement
                                batches, review rounds, feature verification plan/automation, PR checks. Each restarts in
                                the background from its last saved round; --force also restarts runs
                                escalated after crashing repeatedly

Pipeline
  implement [run] <KEY|dir|story.md>... | --epic <EPIC> [--parallel N] [--base <ref>] [--pr] [--force] [--dry-run]
                                implement every story given (or of an epic), each on its own worktree
                                and branch; claims each story's board card (--force takes it over)
  implement stop                end the current implement run and everything it started; nothing resumes it
  implement resume [--parallel N] [--pr]
                                continue the last implement run that did not finish
  implement requeue [--requeue-only] [--dry-run] [--parallel N|auto] [--no-pr]
                                run the Failed tickets a human resolved on GitHub (escalation-resolved)
                                in one batch; safe on a timer (scripts/implement/requeue-schedule.mjs)
  implement status [story]      progress of the latest implement run
  implement cleanup [story...]  remove subtask worktrees a failed run left behind
  implement decisions [--story KEY] [--json]
                                orchestrator decisions and how they turned out
  experiment run --epic <EPIC> [--modes epic,story] [--repeat N] [--sequential] [--base <ref>]
                 [--parallel N|auto] [--no-grade]
                                run the epic once per delivery mode (and repeat), each arm in its own
                                worktree from the same base, board/lessons/PRs off, then grade the arms
                                (pooled epic e2e tests, PR check without fixer); docs/ai-pipeline/experiments.md
  experiment grade <id>         grade (again) the arms of an experiment
  experiment report <id> [--json]
                                cost, tokens, wall clock, overhead, rework, shared tests, findings per arm
  stages                        list the stages and the events they handle
  metrics [--json] [--since <iso-date>]
  costs [story] [--epic <epic>] [--since <iso-date>] [--worktrees] [--json] [--markdown]
                                agent tokens, cache hits and cost: one ticket itemized by stage, one
                                epic itemized by ticket and stage, or (no story) the overview by epic,
                                ticket, stage, model and month

PR bot (docs/ai-pipeline/setup.md#the-pipelines-pr-bot)
  bot setup [--force] [--org <org>] [--public]
                                create your dev-bot-<gh login> GitHub App (click "Create", then "Install"
                                on the repo); the pipeline then opens its PRs as the bot, so you can
                                approve them
  bot status                    bot name, configured, installed on the repo, token can be minted
                                (exit 1 when not configured or installed)

Hooks (called by agent tool configs and .githooks)
  hook stop | hook session-start [--nested] | hook pre-tool
  git-hook post-commit | post-merge | pre-push`;

// The guards' reason to deny a tool call, or null. An allowed call is traced when it searches (search-calls.mjs: the
// clean-code rules ask for graphify searches); a denied call searched nothing.
function guardToolCall(config, toolCall) {
  const reason = storyGuard(config, toolCall) ?? installGuard(config, toolCall) ?? networkGuard(config, toolCall) ?? ticketWriteGuard(config, toolCall) ?? foreignTestGuard(config, toolCall) ?? stackGuard(config, toolCall) ?? factoryGuard(config, toolCall);
  if (!reason) recordGraphifyCall(toolCall);
  return reason;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest, new Set(['since', 'epic', 'modes', 'repeat', 'base', 'parallel', 'org']));
  if (!command || command === 'help' || flags.help) {
    console.log(USAGE);
    return 0;
  }
  const config = loadConfig();
  const stages = loadStages();

  switch (command) {
    case 'implement': {
      const stage = stages.find((s) => s.name === 'implement');
      const args = process.argv.slice(3);
      if (args[0] && !['run', 'resume', 'requeue', 'stop', 'story', 'status', 'cleanup', 'decisions', 'metrics', 'help', '--help'].includes(args[0])) args.unshift('run');
      return runStage(config, stage, args, { inherit: true }).status;
    }

    case 'start': {
      const story = requireStory(config, positional[0], { update: true });
      setActiveStory(config, story.key);
      updateState(config, story.key, (s) => (s.done = null));
      console.log(`Active story: ${story.key}. Story: ${story.file}${mockupsDir(config, story.key) ? `; mockups: ${story.mockupsDir}/` : ''}.`);
      for (const { stdout } of dispatchText(config, stages, 'hooks', 'story-start', [story.key])) if (stdout.trim()) console.log(stdout.trim());
      console.log(`Run \`${CMD} done\` when the line of work is complete.`);
      return 0;
    }

    case 'done': {
      const story = requireStory(config, positional[0], { fallbackActive: true });
      const { hash, files } = implChanges(config);
      updateState(config, story.key, (s) => (s.done = { at: nowIso(), hash }));
      console.log(`${story.key} marked complete (${files.length} implementation file(s) changed). The pipeline stages run when this agent turn ends.`);
      return 0;
    }

    case 'status': {
      const story = positional[0] ? requireStory(config, positional[0]) : activeStory(config);
      if (story) console.log(`Active story: ${story.key} (${loadState(config, story.key).done ? 'done' : 'in progress'})`);
      for (const { stage, stdout } of dispatchText(config, stages, 'commands', 'status', story ? [story.key] : [])) {
        console.log(`\n[${stage}]\n${stdout.trimEnd()}`);
      }
      const escalations = listEscalations(config);
      if (escalations.length) console.log(`\nEscalations: ${escalations.join(', ')}`);
      return 0;
    }

    case 'resume': {
      // Each stage restarts its interrupted runs in the background, so this returns right away.
      const args = [...(positional[0] ? [requireStory(config, positional[0]).key] : []), ...(flags.force ? ['--force'] : []), '--background'];
      for (const { stage, stdout } of dispatchText(config, stages, 'commands', 'resume', args)) console.log(`[${stage}]\n${stdout.trimEnd()}`);
      return 0;
    }

    case 'metrics': {
      const args = [...(flags.json ? ['--json'] : []), ...(flags.since ? ['--since', flags.since] : [])];
      const results = dispatchText(config, stages, 'commands', 'metrics', args);
      if (flags.json) console.log(JSON.stringify(Object.fromEntries(results.map((r) => [r.stage, JSON.parse(r.stdout)])), null, 2));
      else for (const { stage, stdout } of results) console.log(`== ${stage} ==\n${stdout.trimEnd()}\n`);
      return 0;
    }

    case 'costs': {
      const opts = { since: flags.since, ...(flags.worktrees ? { rows: loadUsageAcrossWorktrees(config) } : {}) };
      let report;
      let format;
      if (flags.epic) {
        const epic = findEpic(config, flags.epic);
        if (!epic) {
          console.error(`Unknown epic "${flags.epic}".`);
          return 2;
        }
        [report, format] = [epicReport(config, epic.key, opts), formatEpic];
      } else if (positional[0]) [report, format] = [storyReport(config, requireStory(config, positional[0]).key, opts), formatStory];
      else [report, format] = [overviewReport(config, opts), formatOverview];
      console.log(flags.json ? JSON.stringify(report, null, 2) : format(report, { markdown: Boolean(flags.markdown) }));
      return 0;
    }

    case 'experiment': {
      const [sub, id] = positional;
      if (sub === 'run') {
        if (typeof flags.epic !== 'string') {
          console.error('Usage: pipeline experiment run --epic <EPIC> [--modes epic,story] [--repeat N] [--sequential]');
          return 2;
        }
        const implConfig = loadConfig('implement');
        const exp = await runExperiment(implConfig, {
          epic: flags.epic,
          modes: String(flags.modes ?? 'epic,story').split(',').filter(Boolean),
          repeat: Math.max(1, Number(flags.repeat ?? 1) || 1),
          sequential: Boolean(flags.sequential),
          base: typeof flags.base === 'string' ? flags.base : implConfig.baseRef,
          parallel: flags.parallel ?? 'auto',
          grade: !flags['no-grade'],
        });
        console.log(formatReport(experimentReport(implConfig, exp.id)));
        return 0;
      }
      if (!id || !['grade', 'report'].includes(sub)) {
        console.error('Usage: pipeline experiment run --epic <EPIC> ... | grade <id> | report <id> [--json]');
        return 2;
      }
      const implConfig = loadConfig('implement');
      if (sub === 'grade') await gradeExperiment(implConfig, id);
      const report = experimentReport(implConfig, id);
      console.log(flags.json ? JSON.stringify(report, null, 2) : formatReport(report));
      return 0;
    }

    case 'bot': {
      const sub = positional[0];
      if (sub === 'setup') return botSetup(config, { force: Boolean(flags.force), org: typeof flags.org === 'string' ? flags.org : null, isPublic: Boolean(flags.public) });
      if (sub === 'status') return botStatus(config);
      console.error('Usage: pipeline bot setup [--force] [--org <org>] [--public] | bot status');
      return 2;
    }

    case 'stages': {
      for (const s of stages) console.log(`${s.name.padEnd(8)} ${s.cli.padEnd(28)} hooks=${s.hooks.join(',') || '-'} git=${s.gitHooks.join(',') || '-'}\n         ${s.description}`);
      return 0;
    }

    case 'hook': {
      const event = positional[0];
      // The story guard also binds the agents the pipeline starts (PIPELINE_CHILD); only PIPELINE_DISABLE lifts it.
      if (event === 'pre-tool') {
        if (process.env.PIPELINE_DISABLE === '1') return 0;
        // Fail closed: a guard that cannot read the tool call denies it.
        const read = await readPayloadStrict();
        if (read.error || (read.empty && process.env.PIPELINE_CHILD === '1')) {
          process.stdout.write(JSON.stringify(denyOutput(`Factory guard: ${read.error ?? 'the tool call arrived empty'}, so it cannot be checked and is denied. Retry the call; if it keeps failing, report it in your result.`)));
          return 0;
        }
        const toolCall = read.payload;
        const reason = guardToolCall(config, toolCall);
        if (reason) process.stdout.write(JSON.stringify(denyOutput(reason)));
        return 0;
      }
      if (isDisabled()) return 0;
      const payload = await readPayload();
      if (event === 'stop') {
        const output = dispatchStop(config, stages, payload);
        if (output) process.stdout.write(JSON.stringify(output));
        // Ship new metrics records to the configured store, detached: a hook never waits on a remote service.
        pushInBackground(config, () => spawn(process.execPath, [path.join(INSTALL_ROOT, 'bin/factory.mjs'), 'sink', 'push'], { cwd: config.root, detached: true, stdio: 'ignore', env: { ...process.env, PIPELINE_DISABLE: '1' } }).unref());
        return 0;
      }
      if (event === 'session-start') {
        const story = activeStory(config);
        const header = [];
        if (story) {
          header.push(`AI pipeline: active story ${story.key} (story: ${story.file}${mockupsDir(config, story.key) ? `, mockups: ${story.mockupsDir}/` : ''}).`);
          if (!loadState(config, story.key).done) header.push(`When your line of work for ${story.key} is complete, run \`${CMD} done\` before finishing so the review and test stages run.`);
        }
        const escalations = listEscalations(config);
        if (escalations.length) header.push(`Pipeline escalations needing a human: ${escalations.join(', ')} (.factory/state/escalations/).`);
        const output = sessionStartOutput(dispatchSessionStart(config, stages, payload, header), { nested: Boolean(flags.nested) });
        if (output) process.stdout.write(JSON.stringify(output));
        return 0;
      }
      console.error(`Unknown hook event "${event}".`);
      return 2;
    }

    case 'git-hook': {
      if (isDisabled()) return 0;
      const event = positional[0];
      if (event === 'pre-commit') return preCommit(config);
      if (!['post-commit', 'post-merge', 'pre-push'].includes(event)) {
        console.error(`Unknown git hook "${event}".`);
        return 2;
      }
      return dispatchGitHook(config, stages, event, event === 'pre-push' ? await readStdin() : '');
    }

    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      return 2;
  }
}

// pre-commit: keep the shared graphify semantic cache (a deleted entry is restored to the index and the
// worktree: other branches use it), then lint the lines the commit touches (SKIP_LINT=1 skips the lint once).
function preCommit(config) {
  const deleted = git(config.root, ['diff', '--cached', '--name-only', '--diff-filter=D', '--', 'graphify-out/cache/semantic']).stdout.split('\n').filter(Boolean);
  if (deleted.length) {
    git(config.root, ['restore', '--staged', '--worktree', '--source=HEAD', '--', ...deleted]);
    console.error(`pre-commit: restored ${deleted.length} deleted graphify semantic-cache entr${deleted.length === 1 ? 'y' : 'ies'} (shared by every branch; the weekly prune removes unused ones).`);
  }
  if (process.env.SKIP_LINT === '1') return 0;
  // The linters are feature verification's precheck.lint (one list for the hook, CI and the precheck).
  const skipped = [];
  const notes = [];
  const errors = lintChanged(loadConfig('feature-verification', config.root), changedFiles(config.root, { staged: true }), { staged: true, skipped, notes });
  for (const sk of skipped) console.error(`pre-commit: lint skipped: ${sk}`);
  for (const n of notes) console.error(`pre-commit: lint note: ${n}`);
  for (const e of errors) console.error(e);
  if (errors.length) console.error('pre-commit: fix the problems above on the lines you changed (SKIP_LINT=1 git commit ... skips this once).');
  return errors.length ? 1 : 0;
}

runMain(main, 'pipeline');
