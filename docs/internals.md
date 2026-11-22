# Pipeline internals

**Who reads this:** D (contributors), and C when a hook or guard needs explaining. How the stages are wired
together: the dispatcher, the hooks, the guards, the agent definitions, shared state, and how to add a stage.
The pipeline itself is on the [map](ai-pipeline/README.md#the-pipeline-map).

## Hooks and lifecycle events

Every stage is a separate Node CLI under `scripts/<stage>/`, listed in order in `scripts/pipeline/stages.json`.
One dispatcher, `scripts/pipeline/pipeline.mjs` (what `factory <command>` runs for any command that is not a
tool), calls them from the agent tools' hooks, the git hooks and the commands.

| When | Hook | Dispatcher call | Stages | Agent cost |
| --- | --- | --- | --- | --- |
| `factory start <KEY>` | (command) | `story-start` | review, feature-verification, pr-check, board (claims the card) | none |
| Any agent tool call | `PreToolUse` (Gemini `BeforeTool`) | `hook pre-tool` | the [guards](#guards) | none |
| Agent session start or resume | `SessionStart` | `hook session-start` | implement, review, feature-verification, pr-check | none |
| Agent turn ends | `Stop` and `SubagentStop` | `hook stop` | review, then feature-verification, then pr-check, then board | only after `factory done` |
| Commit or merge | `.factory/githooks/post-commit`, `post-merge` | `git-hook post-commit\|post-merge` | feature-verification lessons after a merge, only with `git config fv.autoLessons true` | if opted in |
| `factory board fetch` brings a changed story | (command) | none | feature-verification plans it in the background, only with `git config fv.autoPlan true` | if opted in |
| Push | `.factory/githooks/pre-push` | `git-hook pre-push` | feature-verification (plans and tests of touched stories are verified and current) | none |
| Push of a pipeline branch, and pull requests | the factory's CI jobs for `ci.provider` ([hosts-and-trackers.md](hosts-and-trackers.md#ci-systems)) | `factory check`, `factory lint`, the policy self-check, the feature verification check, the analysis jobs | all | none |
| A bug fix is delivered | the delivery (`deliverFinished`) | `review-gate assess` before the open, `publish` at the open, `regate` after the PR's checks ([review gate](ai-pipeline/review-gate.md)) | review-gate | one `bug-triage` run per PR |
| The delivery, with the `demoVideo` feature | the delivery | `pr-video local` ([demo videos](ai-pipeline/pr-demo-video.md)) | none | `demo-narrator`: one run for the videos' scripts and one for a backend bug's reproduction steps, each retried once |
| `factory board sync` (start of every `implement run`, by hand, `implement requeue`) | (command) | none | board, review-gate (human reopens, gated PRs evaluated again) | none |
| Pull request opened, pushed, labeled or reviewed | the `review-quorum` CI job | `review-quorum` from the base branch | the approvals check | none |
| The retro, weekly or by hand | the retro CI job | `retro calibrate`, `fv metrics`, `retro run` ([retro](ai-pipeline/retro.md)) | feature-verification, retro | yes |

`factory init` points `core.hooksPath` at `.factory/githooks` unless the repository already has a hooks path
([setup.md](ai-pipeline/setup.md#add-it-to-a-repository)). No agent starts on its own when tickets change: agent
work starts only from a command (`implement run`, `fv plan`, `fv automate`) or from `factory done` in a session
you started. `PIPELINE_DISABLE=1` turns every hook off. Agents the pipeline starts run with `PIPELINE_CHILD=1`,
so their own Stop and git hooks do nothing and cannot recurse.

`factory start` records the active story and tells each stage (the review resets its rounds, the PR check its
runs). `factory done` marks the work complete; nothing reviews or tests it until then, so an agent can stop
mid-story without triggering anything.

## The dispatcher

The dispatcher runs each stage's CLI as a separate process, so a stage that crashes cannot take down the
others or the agent.

- **Stop:** stages run in order with the hook payload on stdin. A stage prints nothing, a `systemMessage`, or a
  Claude-format `{"decision": "block", "reason": ...}`. The first block ends the dispatch, so later stages run
  only once earlier gates pass. A stage that fails becomes a message, never a broken turn.
- **SessionStart:** each stage prints plain text. The dispatcher adds the active story and open escalations and
  wraps it once: top-level `additionalContext` (Copilot reads only this) plus `hookSpecificOutput` (Claude
  Code, Cursor). `--nested` emits only the nested form, for Codex.
- **Git hooks:** stage output goes straight to the terminal. Only `pre-push` can fail.
- **`status` and `metrics`:** each stage's own command, grouped by stage.

## Agent tool coverage

`factory render` writes the hook files for the tools the pin lists (`.factory/factory.json`).

| Tool | Hook file | Covers | Trust step |
| --- | --- | --- | --- |
| Claude Code | `.claude/settings.json` | all | accept the project's hooks when prompted |
| GitHub Copilot CLI and VS Code agent | `.claude/settings.json` (the factory writes no `.github/hooks/` file) | all | add the repository to `trustedFolders` in `~/.copilot/config.json` |
| Cursor | `.claude/settings.json` (third-party hooks, on by default) | all; Cursor has no `Glob` hook | leave Cursor's third-party hooks setting on |
| Windsurf / Devin | `.claude/settings.json` | pipeline hooks; the graphify guard is advisory through `AGENTS.md` | none |
| OpenAI Codex | `.codex/hooks.json` | all; the graphify check and the story guard cover `Bash` only | trust the project, then approve the hooks in `/hooks` |
| Gemini CLI | `.gemini/settings.json` through `scripts/hooks/gemini-adapter.mjs` | all; `AfterAgent` stands in for `Stop` | approve the project hooks when prompted |

Not covered: the Copilot cloud agent, Cline, Kiro and OpenCode (no way for a hook to block a turn from ending).
For those, the git hooks and CI still enforce the stage checks.

## Guards

The same `PreToolUse` hook (`hook pre-tool`) holds three guards. Only `PIPELINE_DISABLE=1` lifts them; people are
never affected.

- **Story guard.** Agents ignore the ticket cache (`storyGuard.folders` in `scripts/pipeline/config.json`:
  `.factory/state/board/`) except what was handed to the pipeline: the story given to `factory start <KEY>`
  (recorded in `.factory/state/active-story`), and the tickets given to `factory implement run` (and the epic's
  own folder with `--epic`), passed to every worker as `PIPELINE_STORY_SOURCES`. A handed ticket is open in the
  main checkout and in every worktree that carries a copy; every other ticket's folder is closed, in any
  checkout, and a symlink into one is denied too. A recursive search of the whole repository does not name the
  folder and can still reach it; the instructions in `AGENTS.md` cover that case. To let an agent write
  stories, have it use `factory board new` or `factory board publish`.
- **Read guard.** Agents the pipeline starts stay inside their own repository: no reading of the factory
  install, other agents' session stores, any other git repository on the machine, or paths in
  `FACTORY_GUARD_DENY` or `storyGuard.denyPaths`. Toolchains and caches outside any repository stay readable.
- **Network guard.** Pipeline agents stay on this repository's GitHub (`board.repo`, else `origin`): `gh` aimed at
  another repository, `gh search`, git network commands, curl and web fetches of another repository's GitHub
  URLs, any host in `storyGuard.denyHosts`, and web searches naming a repository in `storyGuard.denyRepos` are
  denied. Documentation sites, package registries and the application's own stack stay reachable.
  `storyGuard.networkOpen: true` turns this guard off.

## Instruction check

`factory check` reads the texts agents read and flags a sentence that tells an agent to write a path the
[factory guard](configuration.md#factory-guard-factoryguard) denies it (`scripts/pipeline/lib/instruction-check.mjs`).

How it reads sentences:
- write cues are matched by stem anywhere in the sentence, including -ing forms and imperative passives ("must be updated");
- sentences are joined across wrapped lines;
- a noun after an article ("a change") is not a cue;
- a path is recognised with backslashes (`.factory\policy\profile.yaml`) or without its leading dot (`factory/policy/...`);
- a clause after a semicolon continues the one before ("lives in `<path>`; keep it current" is an instruction to change it), unless that one was a prohibition;
- "keep … current / up to date / in sync" is a write cue;
- a read cue on the path with every write cue in a later clause (when, if, before, after, while, once) is harmless: "Follow the patterns in `<path>` when you add an endpoint".

What it reads:
- each agent's prompt: definition, addendum without its comments, lessons;
- every string of the policy's rules, patterns and validator registry, as the engine renders them;
- the root instruction files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md`, `.cursor/rules`), whole;
- the repository's skills (`.claude/skills`, `.github/skills`, `.agents/skills`);
- the `e2e/` tree and the Playwright configs;
- the Markdown files in `tests/` (`tests/README.md` and the like);
- the prose in `.factory/app.json` (`$comment` and any string with spaces);
- the policy's profile, `policy.yaml` and exceptions (their justifications), and the YAML comments of every policy file.

## Agent definitions

`agents/<name>.agent.md` in the factory is the single source of every agent. The stages build their prompts
from it (`scripts/pipeline/lib/agents.mjs`), adding the repository's addendum (`.factory/agents/<name>.md`),
its lessons and the rules every agent gets (for example never to write a credential). For interactive sessions
`factory render` also writes `.claude/agents/<name>.md` (with Claude-only settings from
`scripts/agents-claude.json`) and `.github/agents/<name>.agent.md`; a repository can override a whole definition
with `.factory/agents/<name>.agent.md`. `factory check` fails when a generated copy was edited. Every agent ends
its final message with `AGENT_RESULT: {json}`, which the stage parses. See [agents.md](ai-pipeline/agents.md).

## Shared code and state

`scripts/pipeline/lib/` holds what every stage uses: config loading, git helpers, the ticket loader
(`tickets.mjs`), per-story state, escalations, the agent runner, background runs and the redaction boundary.

- **Config:** `scripts/pipeline/config.json` is merged with the stage's own `scripts/<stage>/config.json`, then
  the repository's `.factory/config.json` ([configuration.md](configuration.md)). Environment overrides:
  `PIPELINE_AGENT_CLI`, `PIPELINE_AGENT_CMD`, `PIPELINE_BASE_REF`, `PIPELINE_ROOT`.
- **State:** `.factory/state/` (not committed) holds the active story, one `stories/<KEY>.json` per story with a
  section per stage, locks, logs and escalations (`escalations/<KEY>-<stage>.md`).
- **Recovery:** every stage survives a crash, kill or reboot. Runs record their pid and the boot they started
  in and hold a lock, so a pid reused after a reboot is never mistaken for the run. A run that died is found on
  the next session start or Stop hook, or by `factory resume`, and continues from its last saved round. Each is
  retried `recovery.maxAttempts` times (3), waiting `recovery.backoffSec` (60) and then twice as long each time,
  then escalated; `factory resume <KEY> --force` restarts an escalated run (`scripts/pipeline/lib/recovery.mjs`).

  | Stage | What is saved | Picked up by |
  | --- | --- | --- |
  | implement | the batch (`batch.json`) and each story's phase | session start; `factory resume` or `implement resume` ([implement](ai-pipeline/implement.md#resume-and-interrupted-runs)) |
  | review | the round in progress | the next Stop ([review](ai-pipeline/review.md#interrupted-reviews)) |
  | feature-verification | plan and automation round and feedback | session start, Stop, `factory resume` ([feature verification](ai-pipeline/feature-verification.md#crash-recovery)) |
  | pr-check | the Stop-hook waiter; manual runs after each critique and fix | session start, Stop, `factory resume` ([PR check](ai-pipeline/pr-check.md#interrupted-checks)) |
  | lessons and retro | `lessons-run.json` | the next `fv lessons`, session start, `factory resume` ([retro](ai-pipeline/retro.md)) |

- **Councils:** `council-config.mjs` validates the `council` section, `council.mjs` seats and merges a council. The
  discussion between members ([council-intercom.md](ai-pipeline/council-intercom.md)) is three modules:
  `intercom.mjs` (the step a stage calls after its first round: the process's one listener, recovery by restart and
  the rulings), `intercom-room.mjs` (the dispute rules and the journal) and `intercom-server.mjs` (the MCP server on
  `node:http`). Room journals are in `.factory/state/council/intercom/`.
- **Metrics:** `.factory/metrics/` holds JSON lines, committed with the branch's work (`merge=union` keeps every
  record across branches). `decisions.jsonl` is shared: every stage records why its agents decided what they
  did, and the retro reads it. `token-usage.jsonl` holds every agent run's tokens and cost ([costs](ai-pipeline/costs.md)).
  See [observability.md](observability.md).

## Adding a stage

1. Create `scripts/<stage>/<stage>.mjs` with the shared lib (`loadConfig('<stage>')`, `runMain`,
   `readPayload`). Implement the events it needs: `hook stop` (print nothing, a `systemMessage`, or a block),
   `hook session-start` (plain text), `hook story-start <KEY>`, `git-hook <event>` (exit nonzero only on
   `pre-push`), plus `status [story]` and `metrics [--json]`. A stage whose runs can be cut short also implements
   `resume [story] [--force] [--background]`, using `runDied` and `nextAttempt` from `recovery.mjs`.
2. Add it to `scripts/pipeline/stages.json` in the right order, with its `hooks`, `gitHooks` and `commands`. A
   stage that must wait for another reads that stage's section of the story state (as feature verification
   reads `review.approvedHash`).
3. Put its tests in `scripts/<stage>/test/`. For a PR gate, add a job to the CI templates
   (`templates/ci/<provider>/`) and a parity entry (`scripts/implement/lib/ci-parity.mjs`, [ci-parity.md](ai-pipeline/ci-parity.md)).
4. Document it in `docs/ai-pipeline/<stage>.md` and on the [map](ai-pipeline/README.md#the-pipeline-map).

## Commands

```bash
factory start|done|status [KEY]
factory resume [KEY] [--force]       # continue every stage's runs that died (crash, kill, reboot)
factory implement [run] <KEY|dir|story.md>... | --epic <EPIC> [--parallel N|auto] [--base <ref>] [--pr] [--force] [--dry-run]
factory implement resume|status|stop|requeue|cleanup|decisions|metrics
factory experiment run --epic <EPIC> [--modes epic,story] [--repeat N]   # experiments.md
factory bot setup|status             # the GitHub PR bot (setup.md)
factory stages
factory metrics [--json] [--since <date>]
factory costs [KEY] [--epic <epic>] [--since <date>] [--json|--markdown]
factory hook stop|session-start [--nested]|pre-tool
factory git-hook post-commit|post-merge|pre-push
factory review run|status|resume|metrics [KEY]
factory fv plan|automate|check|lessons|metrics [KEY]
factory pr-check run --pr 42 [--no-fix]
factory review-gate assess|publish|regate|status|explain|enforce
factory pr-video local|embed|specs|scope|publish|api|cleanup
factory board setup|guide|fetch|new|publish|move|review|fail|sync|status   # board.md
npm test                             # every stage's tests (fake agent, no AI calls)
```
