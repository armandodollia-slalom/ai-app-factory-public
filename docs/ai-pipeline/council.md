# Council verifiers

A verification stage can seat a **council**: several independent verifiers (members), each on its own agent CLI
(Claude Code, Codex, GitHub Copilot or a custom command), model, reasoning effort and lens, instead of its single
verifier. The harness runs the members in parallel and merges their results deterministically. The rules every member
follows are the factory's `council` skill (`skills/council/SKILL.md`), which is injected into every member's prompt.

With no `council` section in `.factory/config.json` (the default), and for every stage the section does not list,
nothing changes: each stage runs its single verifier with its own round limit.

## Configuration

The section is governance: it lives in `.factory/config.json`, never in `app.json`.

```jsonc
"council": {
  "rounds": 3,                  // most review rounds; a stage may override
  "passScore": 9,               // every blocking member must score this or more
  "blockOn": "any",             // any | majority | all: members needed to uphold a blocking finding
  "onUnavailable": "fail",      // fail | report: never substitute another model
  "members": [
    { "name": "opus",    "cli": "claude",  "model": "opus",   "effort": "high", "lens": "correctness" },
    { "name": "sol",     "cli": "codex",   "model": "sol",    "effort": "high", "lens": "correctness" },
    { "name": "tests",   "cli": "copilot", "model": "sonnet", "lens": "test-value" },
    { "name": "rewrite", "cli": "claude",  "model": "opus",   "lens": "rewrite", "blocking": false }
  ],
  "stages": {
    "pairVerify":     { "members": ["opus", "tests"] },
    "review":         { "members": ["opus", "sol", "rewrite"] },
    "testAutomation": { "members": ["tests", "sol"], "rounds": 5 },
    "prCheck":        { "rounds": 6 }      // no "members": the whole council sits
  }
}
```

`examples/eshop/.factory/config.json` carries this sample under `$councilSample` (not enabled).

### Members

| Key | Meaning |
| --- | --- |
| `name` | unique short name (letters, digits, `-`, `_`); the PR table and the logs use it |
| `cli` | `claude`, `codex`, `copilot` or `custom` |
| `model` | an alias from `agent.allowedModels`; it must have an id for the member's CLI in `agent.modelIds.<cli>` (Codex has none by default: add `agent.modelIds.codex`). Optional for `custom` |
| `effort` | `low`, `medium`, `high`, `xhigh` or `max`: Claude Code's `--effort`, Codex's `model_reasoning_effort` (`max` becomes `xhigh`). Copilot's CLI documents no effort option, so a Copilot member runs at its model's default; a custom command gets `PIPELINE_AGENT_EFFORT` |
| `lens` | `correctness`, `acceptance`, `security`, `test-value`, `rewrite` or `ui` (the skill's table) |
| `blocking` | default `true`; `false` makes the member's findings feedback (see below) |
| `cmd` | `custom` only: the command, which reads the prompt on stdin (like `PIPELINE_AGENT_CMD`; it gets `PIPELINE_AGENT_MODEL` too) |
| `timeoutSec` | optional; else the stage's verifier time limit |
| `env` | optional variables for the member's CLI process, such as a second login's home folder: `{ "CODEX_HOME": "~/.codex-personal" }`. `~` and `${NAME}` are expanded when the member starts. Settings only, never secrets: a variable whose name looks like a token, key or password must be a `${NAME}` reference, a value that looks like a credential is refused, and `PIPELINE_*`, `FACTORY_*` and `NODE_OPTIONS` cannot be set. `factory doctor` and `factory council check` check the member's login with this environment; the metrics record the login home as configured (`login`), never an expanded value |

`PIPELINE_AGENT_CMD` (the test fake agent) still wins over every member's CLI.

The shipped defaults map `sol` to `gpt-6.1-sol` on Codex (`agent.modelIds.codex`), so a Codex member on `sol` loads
without extra settings. An implement role (`implement.roles.<role>`) takes the same `env` beside its `cli`. Example: a
two-member council of Opus 5.5 on Claude Code and Sol 6.1 on a second Codex login:

```json
"council": {
  "members": [
    { "name": "opus", "cli": "claude", "model": "opus", "effort": "high", "lens": "correctness" },
    { "name": "sol", "cli": "codex", "model": "sol", "effort": "high", "lens": "correctness", "env": { "CODEX_HOME": "~/.codex-personal" } }
  ],
  "stages": { "review": {}, "prCheck": {} }
}
```

### Stages

| Key | What the council replaces | Round limit it overrides | Agent each member runs |
| --- | --- | --- | --- |
| `pairVerify` | the pair verifier of a code subtask ([implement.md](implement.md)) | `implement.maxPairRounds` | `pair-verifier` |
| `pairUiVerify` | the pair UI verifier of a UI subtask | `implement.maxPairRounds` | `pair-ui-verifier`, on the pair's leased stack slot, screenshots under `round-<n>/<member>/` |
| `review` | the LLM architecture reviewer ([review.md](review.md)); the policy pack still runs first | `review.maxRounds` | `architecture-reviewer` |
| `testPlan` | the test plan verifier ([feature-verification.md](feature-verification.md)) | `loops.planMaxRounds` | `test-plan-verifier` |
| `testAutomation` | the test automation verifier | `loops.automationMaxRounds` | `test-automation-verifier` |
| `prCheck` | the PR check critics its members' lenses cover ([pr-check.md](pr-check.md)); the defender, the judge and the fixer stay, and so do the stage's own critics no member covers: acceptance (unless a member has that lens), flow (the list of behaviour changes outside the ticket, unless a member's lens is correctness or security), design on a frontend PR (unless a member's lens is ui) and video when there are recordings | `prCheck.maxRounds` (an explicit `--max-rounds`, such as the delivery's fix rounds, still wins) | the critic closest to the lens: acceptance → `pr-check-acceptance`, correctness and security → `pr-check-flow`, test-value and rewrite → `pr-check-style` |

A stage is listed with `members` (names from `council.members`) or `{}` (the whole council, without `ui` members), and optionally `lenses`: a member's lens for that stage only, so the same two members can judge code through `correctness` in one stage and tests through `test-value` in another (`"testAutomation": { "lenses": { "opus": "acceptance", "sol": "test-value" } }`). The member must sit for the stage, and `ui` is allowed only for `pairUiVerify`.
A `ui` member needs a leased app stack slot, so it may sit only for `pairUiVerify`. A Codex member cannot have the `ui` lens: Codex's sandbox cannot start a browser. It can still sit for `pairUiVerify` with another lens: it checks the running app over HTTP (its verify runs may reach localhost) and in the code, and leaves layout and styling to the browser members. Every stage needs at least one
blocking member. `council.stages.<stage>.rounds` overrides `council.rounds`; with a council, these take precedence over
the stage's own limit, and at the limit the story escalates exactly as it does without one.

A lens adds to the stage's own instructions and `AGENT_RESULT` contract; it does not replace them. Every member's task
is the stage's task, then a "Council member" section (who it is, its lens, the round, the extra fields) and the skill.

The settings load fails on a bad section: an unknown key, stage or lens, duplicate names, a member model without an id
for its CLI, a stage member that does not exist. `factory council check` prints the problems, or who sits for each stage.

## How a round works

1. All members start at once, each a fresh read-only process. Read-only is each CLI's own: Claude Code's read tool list
   (the UI stage: shell, no edits), Codex's `read-only` sandbox (the UI stage: `workspace-write`, and the harness
   discards what is left), Copilot's `--deny-tool write` and `shell`. The factory guard and the story guard apply to
   every member on every CLI; a read-only stage also fails the round when the working tree changed while members ran
   (what a custom command could do). A headless `codex exec` ignores the repository's `.codex/hooks.json` (an
   untrusted folder, and Codex hooks need a trust the user grants interactively), so every Codex run defines the
   factory's PreToolUse guard itself (`-c hooks.PreToolUse=...` with `--dangerously-bypass-hook-trust`, Codex's switch
   for automation that vets its hook sources; the hook is `factory hook pre-tool`). Verified with codex-cli 0.167.1:
   a read of another ticket's cached story is blocked.
2. A blocking member is waited for. A non-blocking member is not: when the last blocking member has answered, a
   non-blocking one still running finishes in the background and its result is handed to the next round as feedback
   (a minor note: it never blocks). Its score is never recorded. Per stage:
   - pair, feature verification and PR check: the stage's process lives across rounds, so the late result is kept in
     memory for its next round (in the PR check it joins the debate as a minor finding);
   - review: each round is a Stop hook process that ends with the round, so a non-blocking member runs as a detached
     process (`scripts/pipeline/council-member.mjs`) that writes its result under
     `.factory/state/council/review-<KEY>/`; the next round reads it once as feedback.

   A late result that comes after the stage's last round has no round to inform and is not used.
3. A member whose CLI is not installed, not signed in or whose provider is out (`outage.mjs`) is **unavailable**.
   `onUnavailable: "fail"` fails the round (the pair stops the story as `agent-unavailable`, the review gives no
   verdict, the PR check escalates); `"report"` goes on without it and records it. Another model is never substituted.
   An outage is still recorded for the run as for any agent (`PIPELINE_OUTAGE_FILE`).
4. The harness merges (`scripts/pipeline/lib/council.mjs` `mergeCouncil`):
   - Findings of different members that name the same defect (same id, same test, overlapping rewrite regions, same
     file within three lines or with similar text) become one finding with every member's name and evidence.
   - `blockOn` counts the blocking members that raised the finding as non-minor, out of the blocking members that
     answered: `any` one, `majority` more than half, `all` every one. A finding below that is a note (`notUpheld`).
   - Minor findings never block. A non-blocking member's findings are feedback unless a blocking member raised the same.
   - **Pass**: no finding stands, and every blocking member scored `passScore` or more (a member with no score must
     approve). A low score counts unless every non-minor finding that member raised was outvoted; a low score with no
     blocking finding at all becomes a finding of its own, so the implementer has something to answer.
   - An upheld `rewrite` replaces the fix list for the regions it deletes: findings inside them become notes.
   - An upheld `delete-test` is acted on, except (harness-enforced) a test that belongs to another story (a ticket key
     in its file name or case id), a regression test kept for an upheld finding (`kept-for` on its plan case), or the
     only test of an acceptance line (the only plan case covering one of its `covers` lines). Those become notes.
   - Contradictions (one member deletes a test another wants fixed; two upheld rewrites of the same regions) are
     surfaced with both positions in the finding the implementer reads. The same contradiction two rounds running is a
     question for the ticket's owner: the pair reports blocked (the escalation questions ask it), the review escalates,
     and the PR check ends `QUESTION`.
   - A blocking finding whose own fix asks for no change ("none required") is a note (`noChange`): nothing could
     resolve it. Only when it cannot hide a request: every blocking member's item in the cluster asks for no change,
     nothing after the "none" asks for one ("None required; remove the limit" is a request), and it is not a scope
     objection. A scope objection asks to take the behaviour out whatever its fix says: it stands, and its fix becomes
     that instruction.
   - **Memory across rounds.** Every stage (pair, UI pair, review, test plan, test automation, PR check) keeps, per
     story and subtask, the findings each round of the sitting upheld (for the PR check, the judge's upheld findings),
     their agreed fixes and a snapshot of the tree that round judged (`.factory/state/council/memory/`). The next round's
     members read them ("Findings the council upheld in earlier rounds"): a change that resolves one is required by it.
     A finding no member named gets an id (`<stage or subtask>-r<round>-<n>`).
   - **Provenance of a fix.** The agent that fixes upheld findings (pair implementer, implementer, PR check fixer,
     test plan and test automation agents) declares, per finding id, the line ranges it changed to carry out that
     finding's agreed fix, in `.factory/state/council/fixes/<stage>--<story>[--<subtask>].json` (git-ignored; the task
     says where and how: `fixDeclarationText`). The harness seals the declaration against the diff of that fixing step
     only (`sealFixes`; the next round of the stage, or right after the implementer's run for a review or a PR check
     return): it keeps the lines the step added whose text was not in the file before it and is not text the step
     removed (moved code), and records refusals (`rejected`: an id that round did not uphold, a range wider than 200
     lines, original or moved lines).
   - **Adjudication, never settlement by the harness.** A declaration proves the fixer wrote a line, not that the
     remedy needed it, so the harness never decides that by itself. A later finding that is a scope objection (`kind`
     "scope", or rule 3's wording "no ticket line asks for it") whose own line (never a line its evidence cites) is a
     sealed line of exactly one upheld finding (the line's text not generic and once in its file, the finding about the
     file or its agreed fix naming it) **stands** and is a candidate (`adjudicate`). The stage then holds one
     adjudication sitting (`adjudicate()`): every blocking member, fresh and read-only, sees the earlier finding, its
     agreed fix, the lines the fixer declared for it and the objection, nothing else of the fixer's, and answers per
     item "does the agreed fix require this specific behaviour?" `yes` or `no` with evidence. Only a plain `yes` with
     evidence from every blocking member makes the objection a note crediting that one finding (`sanctionedBy`, with
     `acceptedBy`; `earlierRound` in the round's record). A `no`, a missing or unparsable answer, a hedged or doubled
     answer, a yes without evidence, an unavailable member, or a member that changed the tree: the objection stands,
     and its fix becomes a concrete instruction (take out the behaviour the adjudication did not accept, keep the change
     that carries out the earlier finding's agreed fix). Non-blocking members are not asked. The sitting is recorded in
     `council-rounds.jsonl` with `kind` "adjudication" (members, executions, each item's outcome and who said what), its
     usage under the stage with step `adjudication-<member>`, and listed in the PR body's council section. If a later
     round demands that earlier finding again after its objection stood, the council has contradicted itself: one owner
     question stating both positions (a contradiction with `escalate`), asked at once. Anything that is not a candidate
     (no declaration, two findings, a neighbouring or repeated line, original code, a file the remedy does not cover)
     is an ordinary finding of the council. A defect in how the fix was done is not a scope objection and still
     blocks, and so does a cluster in which any blocking member's finding is not a scope objection. A round number not
     after the last recorded one starts a new sitting; the old sitting's rounds become history.
   - **Across stages.** The memory is per story: a stage also reads the rulings of the story's other stages and earlier
     sittings (the PR check reads what the review upheld; the review, after a return from the PR check, what the PR check
     upheld). Sealed lines are matched by their text, so a later stage recognises an objection to them however far later
     changes moved them (and the objection still goes to adjudication).
5. The implementer (or the fixer, or the test-automation agent) gets the merged findings in the stage's usual format.
   A `DELETE TEST` finding is acted on by deleting the test; a `REWRITE` by deleting the regions and writing them again.
   How to handle both is added to that agent's task only when a council sits for the stage
   (`council.mjs` `councilActionsText`): the agent definitions are unchanged, so a repository without a council keeps
   its prompt versions.
6. After every implementer, fixer or test-automation round in a stage with a council, the harness checks the round's
   diff (`guardProtectedTests`): a deleted test, or a test removed from a file, that is another story's, kept for an
   upheld finding or the only cover of an acceptance line is restored to its content before the round. The pair and the
   test automation loop then fail the round with a finding the agent answers next round; the review asks for the change
   again; the PR check commits the fix without the deletion and logs what came back. Tests are recognised by their plan
   case ids (`TC-<KEY>-<n>-<nn>`) and their file's ticket key.

### Disputes with several members

The implementer's nit and out-of-scope disputes (`scripts/implement/lib/disputes.mjs`) work as with one verifier. Each
dispute goes only to the members that raised the finding, in the stage's own disputes block. Their rulings merge: one
raiser re-asserting with evidence keeps the finding; it is accepted when every raiser that ruled accepted it. A finding
re-asserted twice can no longer be disputed, as before.

## PR check: every member re-sits every round

Without a council the PR check carries a lens over from the round before when the last fix cannot have changed what it
judges (the design critic when no frontend file changed, the video critic when the frames are the same). A council does
not: every member critiques every round. A member's lens (`correctness`, `security`, `test-value`, `rewrite`) is about
the whole change, not a class of files, so no fix can be shown to leave its judgement untouched, and carrying an earlier
10 would let it stand over code the member never saw; an acceptance-lens member rates every ticket line against the code
the round ends on. The cost is one critic run per member per round: a council of three for six rounds is
up to 18 critic runs (plus the acceptance critic when no member has that lens, the defender and the judge), where the
stage's own five critics with carry-over often run three or four per round after the first.

## Cost and concurrency

Every member is an agent run:

- A non-blocking member that is not waited for still runs to the end and still costs its run.
- In the pair loop, each member goes through the story's agent call: it takes a slot of `implement.maxConcurrentAgents`
  (the machine-wide semaphore) and counts against `implement.maxAgentRunsPerStory`. A council of three in a pair costs
  three runs per round; raise `maxAgentRunsPerStory` with the council size (for example by the number of members times
  the pair rounds times the subtasks) or the story ends `limit-agent-runs`.
- The review, feature verification and PR check stages already run their agents outside the per-story budget; members
  there start in parallel like the PR check's critics do today.
- Language servers: members read through the `lsp` MCP server's read-only tools, on the checkout's own daemon, as any
  verifier. A UI council shares the pair's one leased stack slot for all members.
- Token usage is attributed per member (`usage.jsonl`, step `<subtask or stage>:<member>`).

## Records

- `.factory/metrics/council-rounds.jsonl`: one record per council round: stage, story, step (the subtask), round,
  rounds, passScore, blockOn, pass, the lowest blocking score, and per member its name, CLI, model, effort, lens,
  blocking, status (`ok`, `failed`, `unavailable`, `late`), score and verdict.
- `decisions.jsonl`: stage `council-<stage>`, with every merged finding and why it stands or not.
- The stage's own streams as before (`subtask-runs.jsonl`, `arch-reviews.jsonl`, `verifier-runs.jsonl` with the
  members, `pr-checks.jsonl`).
- The PR description gets the skill's **Council review** table (blocking members only, `no score` when a member gave
  none), one per stage and subtask that seated a council, from the latest run. It is regenerated in place when the
  PR check runs again, like the other generated sections.

## By hand

```bash
factory council check                          # validate the section; list who sits where
factory council review --stage review          # seat the review council on this branch against baseRef
factory council review --stage prCheck --base origin/main --story SHOP-1 --json
```

`review` gives every member the branch's diff and the active (or named) story, prints the merged result and the table,
records the round, and exits 0 when the council passes, 1 when not, 2 when it could not sit. The UI council needs a
leased stack slot and runs only in the pipeline.

`factory doctor` checks every member a stage seats: its CLI installed, signed in (`claude auth status`,
`codex login status`; for Copilot a token in the environment or its config folder), and its model resolving to an id.

### Who sits again in a PR check round

A member whose last score passed (`passScore`), with nothing it raised upheld, is carried to the next PR check round with its score when the fix touched nothing it judges. Its scope is test files for `test-value`, frontend files for `ui`, and production code for the other lenses. The record marks it "carried over". The `acceptance` lens always sits again. A non-blocking member that answers after the last round is waited for up to `council.lateGraceSec` (120); its findings become follow-ups of the check instead of being lost.
