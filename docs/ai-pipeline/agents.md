# Agent catalog

Part of the [AI development pipeline](README.md). Each pipeline call starts a fresh headless process, so no agent sees another's reasoning, and every agent ends with an `AGENT_RESULT: {json}` line the stage parses.

## Where an agent's prompt comes from

An agent's prompt is built from three files, and only the first ships with the factory:

| Part | File | Owner | Holds |
| --- | --- | --- | --- |
| Base definition | `agents/<name>.agent.md` in the factory install | the factory | the process: what the agent is given, what it may touch, how it scores, the `AGENT_RESULT` it returns. Nothing about any codebase or technology stack |
| Addendum | `.factory/agents/<name>.md` in the repository | the repository's team | what this codebase adds: stack, layout, build, test and lint commands, conventions, test frameworks and the story-tag convention, UI stack and design system. Appended to the base as a `## Project context` section |
| Lessons | `.factory/lessons/<name>.md` in the repository | the `retro` agent | rules learned from mistakes that recurred here, appended after the project context |

- The base definitions say "the Project context" wherever a codebase-specific answer is needed. An agent without an addendum still runs: it falls back to `AGENTS.md`, `CONTRIBUTING.md`, the build files and the nearest existing code, and reports what it assumed.
- The **prompt version** recorded in the metrics is the hash of all three files, so a change to the base, the addendum or the lessons starts a new version and `factory metrics` shows whether it helped.
- `.factory/agents/<name>.agent.md` (note the `.agent.md`) replaces the base definition outright in that repository. Use it only as a stopgap for a fix that is waiting for a factory release.
- Skeletons for the addenda are in `templates/agents/`; the `write-agent-addenda` skill (`skills/write-agent-addenda/SKILL.md`) describes how to fill them in for any codebase and what belongs in an addendum, in `.factory/config.json` or in a lesson. `examples/eshop/.factory/agents/` is a complete set for a .NET application.
- `factory render` renders every agent to `.claude/agents/` so the same agents can be run from Claude Code (see [Agent definitions](README.md#agent-definitions-for-copilot-and-claude-code)).

## By stage

| Agent | Stage | Started by | Access | Sees | Returns |
| --- | --- | --- | --- | --- | --- |
| `implementer` | [implement](implement.md) | `implement run`, or you | writes code, commits; no push, reset or branch switch | the story, the codebase, `docs/`, review or bug findings | `done`, `blocked` or `needs-input` |
| `pair-implementer` | [implement](implement.md#what-happens) | implement harness, one per delegated subtask (never by hand) | writes and commits only the files the subtask owns, in its own worktree | the subtask spec, the codebase, the previous round's findings | the subtask's commits |
| `pair-verifier` | [implement](implement.md#what-happens) | implement harness, every pair round | read-only | the subtask spec, its diff, build, unit test and diagnostics output | `APPROVED` or `CHANGES_REQUESTED` with findings |
| `pair-ui-verifier` | [implement](implement.md#ui-verification) | implement harness, every round of a `verify: "ui"` subtask | runs shell commands and a browser against a leased stack slot; no source edits | the subtask spec, its diff, the running app, mockups and their renders | `APPROVED` or `CHANGES_REQUESTED` with findings citing screenshots |
| `arch-review` | [review](review.md) | review stage (as `architecture-policy/agents/arch_review.py review`), before each LLM review; any agent on request | read-only | changed files, Architecture Policy Pack rules | `PASS`, `WARN` or `BLOCK` with rule findings |
| `architecture-reviewer` | [review](review.md) | review stage | read-only | the story, the implementation diff, the repository's convention files | `APPROVED` or `CHANGES_REQUESTED` with findings |
| `test-planner` | [feature-verification](feature-verification.md) | `factory fv plan`, or the feature verification stage after review approval | writes `.factory/plans/` | the story (and its diff when it changed) | test plan files |
| `test-plan-verifier` | [feature-verification](feature-verification.md) | plan loop | read-only | the story and the plan | score 0-10 and gaps |
| `test-automation` | [feature-verification](feature-verification.md) | the feature verification stage after review approval, or `factory fv automate` | writes tests in the application's test tree and `.factory/stack/scenarios/` | the verified plan, the implementation | tests, or `product-bug` |
| `test-automation-verifier` | [feature-verification](feature-verification.md) | automation loop | read-only | case files, tests, scenario, keyframes | score 0-10 and gaps (with `root_stage`) |
| `retro` | [feature-verification](feature-verification.md#auto-improvement) | `factory fv lessons` (weekly) | writes `.factory/lessons/`, plus the paths in `lessons.retro.allowedPaths` (addenda, docs; other edits are discarded) | aggregated metrics, the decision-log retro digest and existing lessons | updated lessons files and proposed changes (opened as a PR) |
| `bug-triage` | [review-gate](review-gate.md) | review gate, once per published bug-fix PR | read-only | every ticket of the PR, the systems it touches, its diff | Impact, Complexity and Fix risk per ticket with reasons, floor categories, its confidence |
| `pr-check` | [pr-check](pr-check.md) | you (Copilot or Claude Code) | runs `factory pr-check run` | the PR or branch | summary of the report |
| `pr-check-acceptance` | [pr-check](pr-check.md) | PR check round | read-only | story, diff | lens score and findings |
| `pr-check-flow` | [pr-check](pr-check.md) | PR check round | read-only | story, diff | lens score and findings |
| `pr-check-design` | [pr-check](pr-check.md) | PR check round, frontend stories only | read-only | story (or every ticket of an epic check), diff, mockups and their renders, frames | lens score and findings |
| `pr-check-style` | [pr-check](pr-check.md) | PR check round | read-only | diff, repo conventions | lens score and findings |
| `pr-check-video` | [pr-check](pr-check.md) | PR check round, when a video exists | read-only | video frames, story | lens score and findings |
| `pr-check-defender` | [pr-check](pr-check.md) | PR check round | read-only | the round's findings, story, diff | concede, rebut or partial per finding |
| `pr-check-judge` | [pr-check](pr-check.md) | PR check round | read-only | the full debate | upheld or dismissed per finding |
| `pr-check-fixer` | [pr-check](pr-check.md) | PR check fix mode | writes code | upheld findings | fixes (the PR check commits) |

Read-only agents are enforced per CLI: Claude Code tool lists in `scripts/agents-claude.json`, Copilot `--deny-tool` flags and Codex's `read-only` sandbox in `scripts/pipeline/lib/agents.mjs`.

## Models

Unset models use the agent CLI's default. The files below are the factory's defaults; a repository overrides any of these keys in its `.factory/config.json`.

| Setting | Agents |
| --- | --- |
| `agent.models.default` in `scripts/pipeline/config.json` | every agent without a more specific setting |
| `agent.models.implementer` in `scripts/implement/config.json` | `implementer` |
| `agent.models.reviewer` in `scripts/review/config.json` | `architecture-reviewer` |
| `agent.models.bugTriage` in `scripts/implement/config.json` | `bug-triage` (`opus`) |
| `agent.models.verifier`, `agent.models.audit` in `scripts/feature-verification/config.json` | feature verification verifiers; the stricter calibration auditor |
| `prCheck.models.<cli>.<role>` in `scripts/pr-check/config.json`, or `PR_CHECK_MODEL_<ROLE>` | PR check critics, defender, judge and fixer (see [pr-check.md](pr-check.md#models)) |

`<ROLE>` is `JUDGE`, `ACCEPTANCE`, `FLOW`, `DESIGN`, `STYLE`, `VIDEO`, `DEFENDER` or `FIXER`. To override the judge for the current terminal session:

| macOS (zsh, bash) | Windows (PowerShell) |
| --- | --- |
| `export PR_CHECK_MODEL_JUDGE=claude-opus-5.5` | `$env:PR_CHECK_MODEL_JUDGE = 'claude-opus-5.5'` |

## Lessons

The pipeline appends `.factory/lessons/<name>.md` to an agent's prompt when that file exists; the file is part of the agent's prompt version in the metrics. `retro` writes a rule once a mistake recurs in 3 or more stories, as a `## L<n>: <instruction>` heading followed by a `<!-- category: …; subtype: …; added: <date> -->` marker the pipeline uses to measure, retire or revert it. Empty skeletons are in `templates/lessons/`. See [Auto-improvement](feature-verification.md#auto-improvement).

| Lessons file | Learns from |
| --- | --- |
| `implementer.md` | blocking architecture review findings; product bugs the integration tests found; PR check findings upheld in round 1 |
| `test-planner.md`, `test-automation.md` | verifier denials attributed to that agent |
| `test-plan-verifier.md`, `test-automation-verifier.md` | gaps the calibration audit found that the verifier missed |
| `pr-check-<lens>.md` | that critic's findings the judge dismissed |
| `pr-check-fixer.md` | findings upheld again after a fix round |

## Changing an agent

Decide first where the change belongs:

- It is about one codebase (a command, a path, a convention, a framework): edit that repository's addendum, `.factory/agents/<name>.md`. Never put it in a base definition.
- It is a mistake agents keep repeating there: leave it to `retro`, which writes the lesson and measures it.
- It is about the process and holds for every codebase: edit the base definition in the factory.

To change a base definition:

1. Edit `agents/<name>.agent.md` in the factory (never a `.claude/agents/` copy). Keep it free of any stack or repository knowledge, and keep the `AGENT_RESULT` shape: the stages parse it.
2. Run `factory render`; `factory check` fails in CI if the generated copies differ.
3. Run the engine tests (`npm run test:pipeline` in the factory). A prompt change starts a new prompt version, so `factory metrics` shows whether it helped.
