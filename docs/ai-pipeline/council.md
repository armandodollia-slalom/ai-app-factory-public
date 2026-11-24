# Council verifiers

**Who reads this:** B and C, when they want several models to verify a stage. Every verification stage (the pair
verifier, the pair UI verifier, the architecture review, the test plan, the test automation and the PR check) is a
**council**: one verifier or several independent ones (members), each on its own entry of the model pool (an agent CLI:
Claude Code, Codex, GitHub Copilot or a custom command; a model; a reasoning effort) and through its own lens. The harness runs the members in parallel and merges
their results deterministically, the same way for one member as for several. The rules every member follows are the factory's
[`council` skill](../../skills/council/SKILL.md), which is injected into every member's prompt. Adjudication
(below) is proven by fixture tests only ([proof](../../README.md#what-has-been-proven)).

By default (`council.members` 1) every stage seats **one member**: its own verifier, on its own agent's pool entry
(`models.agents.<agent>`, [models.md](models.md)). Seating more changes who reviews and nothing else.

## Round limit and pass score

Each stage has one round limit and one pass score, used for any council size: the council passes when every blocking
member scores the pass score or more (one decimal place allowed, such as 9.5) and no blocking finding stands; at the
round limit the stage escalates.

| Stage | Round limit | Default | Pass score | Default |
| --- | --- | --- | --- | --- |
| pair verifier, pair UI verifier | `implement.maxCouncilRounds` | 3 | `implement.councilPassScore` | 9.5 |
| architecture review | `architectureReview.maxCouncilRounds` | 5 | `architectureReview.councilPassScore` | 9.5 |
| test plan | `testPlan.maxCouncilRounds` | 5 | `testPlan.councilPassScore` | 9.0 |
| test automation | `testAutomation.maxCouncilRounds` | 5 | `testAutomation.councilPassScore` | 9.0 |
| PR check | `prCheck.maxCouncilRounds` | 3 | `prCheck.councilPassScore` | 9.5 |

The PR check reads `prCheck.maxCouncilRounds` in every caller (delivery, an epic, a CI fix and a run by hand, where
`--max-rounds` overrides it for that run). A test stage is verified once its council passes; nothing asks for a repeated
pass on unchanged work. Each stage section may also carry `councilIntercom`, its own override of `council.intercom`.

## A council of one

A stage that seats one member runs its own verifier as the sole member, on the pool entry the stage's
[orchestrator](orchestrators.md) picks for it ([seats](#seats)). It reviews everything (its lens is recorded as
`all`) and gets the same rules as any member, without the parts that need other members: no seat list, no lens to look
through first, no lens table, no "work alone", no discussion, no non-blocking members and none of the orchestrator's
sections of the skill. `council.blockQuorum` has no effect, no discussion is held, and an unavailable member fails the
round. In the PR check the sole member is the stage's own critic panel (the critics, the defender and the judge), which
passes at `prCheck.councilPassScore` with no blocking finding upheld; its critics run on the picked entry (the defender
and the judge on their own).

With `council.shadowSeat.enabled` (default off), a second member sits beside the sole member: the shadow seat, the
best-ranked pool entry ([seats](#seats)) of another model family than the sole member's, with lens `all`. It is
non-blocking: the stage does not wait for it, its score is never recorded, and its findings, on time or late, are
feedback for the sole member, in every stage: never part of a verdict, never raised to blocking (the harness's raise
of a minor finding that describes a user-visible error or weaker access skips feedback), never debated or judged in a
PR check; they are recorded and reach the producer as notes. Only the sole member decides, so the council still holds no discussion and fails its
round when the sole member cannot run. The shadow gives the scorecard a unique-findings signal for a one-seat stage,
at the cost of a second verifier run per round. Beside the PR check's panel the shadow is one more critic (the flow
critic, reviewing every lens) on its own entry, of another family than the panel's. It never touches the verdict: its
findings are follow-ups of the check and council records, never debated or judged; one shadow run sits at a time, and
one still running when the check ends is stopped, not waited for.

## Configuration

The section is governance: it lives in `.factory/config.json`, never in `app.json`. Members are not listed here: they are
entries of the model pool, `models.pool` ([models.md](models.md)), and the council setting says how many sit.

```jsonc
"models": {
  "pool": [
    { "name": "opus",  "cli": "claude",  "model": "claude-opus-5-5",   "effort": "high" },
    { "name": "sol",   "cli": "codex",   "model": "gpt-6.1-sol",       "effort": "high", "env": { "CODEX_HOME": "~/.codex-personal" } },
    { "name": "tests", "cli": "copilot", "model": "claude-sonnet-5.5", "effort": "medium" }
  ]
},
"council": {
  "members": 1,                 // how many sit, in every stage that does not say otherwise
  "blockQuorum": "any",         // any | majority | all: members needed to uphold a blocking finding
  "onUnavailable": "fail",      // fail | report: never substitute another model
  "explorationSeat": { "enabled": true },  // with two or more seats, one goes to the least-sampled entry
  "shadowSeat": { "enabled": false }       // with one seat, a non-blocking member of another family beside it
},
"architectureReview": { "councilMembers": 3 },
"prCheck": { "councilMembers": 2 }
```

`examples/eshop/.factory/config.json` carries this sample under `$councilSample` (not enabled).

| Setting | Meaning |
| --- | --- |
| `council.members` | how many members a council seats (default 1: the stage's own verifier alone) |
| `<section>.councilMembers` | the same for one section's stages: `implement` (both pair verifiers), `architectureReview`, `testPlan`, `testAutomation` or `prCheck`; `null` uses `council.members` |
| `council.blockQuorum` | `any`, `majority` or `all` blocking members must object for a finding to block (no effect with one member) |
| `council.onUnavailable` | `fail` the round, or `report` and go on without the member, when a member cannot run (one member always fails) |
| `council.explorationSeat.enabled` | with two or more seats, one seat goes to the pool entry with the fewest seats in the stage (default on) |
| `council.shadowSeat.enabled` | with one seat, a non-blocking member of another family sits beside the sole member (default off) |
| `council.scorecard.*` | the scorecard's minimum sample and weights ([retro.md](retro.md#council-scorecard)) |

### Seats

The stage's [orchestrator](orchestrators.md) picks the seats once per ticket, one seat too. With one seat it picks the
pool entry the stage's own verifier runs on (it reviews everything, lens `all`); the pair UI verifier's must drive a
browser, and a bad pick twice seats the verifier on its own agent's entry. With two or more it picks one pool entry and
one lens per seat, with a reason for each. It is given the pool with each entry's family, the stage, the number of seats, the
ticket's shape (UI, backend, test, bug fix) and the [scorecard](retro.md#council-scorecard) (empty until there are records), and
is told to favour different families. The harness rejects a pick that:

- has the wrong number of seats, or names an entry that is not in the pool;
- seats a family twice while a family of the pool has no seat (repeats are allowed once every family sits), or an
  entry twice while an entry of the pool has no seat;
- gives a lens the stage does not allow, or the `ui` lens to an entry whose CLI cannot drive a browser (Codex);
- leaves out the stage's core lens: `ui` on the pair UI verifier, `test-value` on the test stages, `acceptance` on the
  PR check;
- seats two members with one lens while a lens that fits the stage has no seat.

Entries are ranked for a stage and lens by the scorecard: a row's `score`, with an unknown row (fewer seats than
`council.scorecard.minSeats`, or none) counted as 0, so it is neither preferred to a known good row (a positive score)
nor ranked below a known bad one (a negative score); pool order among equals. The orchestrator sees the stage's rows.

With two or more seats and `council.explorationSeat.enabled` (default on), one seat is the exploration seat: the pool
entry with the fewest seats in the stage, summed over its rows (pool order among equals), must sit, so selection keeps
gathering evidence on models it knows little about and does not lock in an early favourite. The orchestrator is told
which entry; a pick without it goes back. Among entries with as many seats as each other (an empty scorecard), it is the
last in pool order, the one the fill would otherwise seat least. The family rule still applies.

A rejected pick goes back once with the reason. If the second also fails, the harness fills the seats itself, held
to the same rules as a pick, in work bounded by the seats times the pool: one entry per family first (each family's
best-ranked entry, families by that rank), then the entries not yet seated, then repeats, seats in pool order; the
stage's lenses in order, core lens first, each to the best-ranked seat left that can take it. When that breaks a rule
(the exploration entry not seated, no browser entry for `ui`), every fill that differs in one seat is tried and the
first that keeps the rules is seated. A one-seat stage's fallback is its own verifier's entry when that keeps the
rules (on the pair UI verifier, one that can drive a browser), else the best-ranked entry that does. Only what no fill
can meet (too few entries for the seats) is recorded on the event as `fillProblems`. Every
seat blocks. Seat names are unique in a sitting: an entry's first seat is its name, a repeat `<entry>-2`, `<entry>-3`,
skipping a name another entry already has. The pick is kept for the ticket, in
`.factory/state/council/seats/<stage>--<ticket>.json`, so the same members and lenses sit in every round and on resume
(members keep their findings' ids and disputes) and no new pick is made; a kept pick that names an entry the pool no
longer has is not used. Each pick is one `council.selection` event in `.factory/metrics/council-selections.jsonl`: the
pool, the pick, the lenses, the reasons, the scorecard version seen, which seat was the exploration seat
(`explorationSeat`) and which the shadow seat (`shadowSeat`, non-blocking), any rejected pick with its reason, and who chose
(`orchestrator` or `harness`; a council of one is the harness's, with lens `all`).

| Stage | Lenses it allows, in the harness's order (core lens first) | Agent each member runs |
| --- | --- | --- |
| `pairVerify` | correctness, acceptance, security, rewrite, test-value | `pair-verifier` ([implement.md](implement.md)) |
| `pairUiVerify` | ui, correctness, acceptance, security, rewrite | `pair-ui-verifier`, on the pair's leased stack slot, screenshots under `round-<n>/<member>/` |
| `architectureReview` | correctness, security, rewrite, acceptance, test-value | `architecture-reviewer` ([review.md](review.md)); the policy pack still runs first |
| `testPlan` | test-value, acceptance, correctness | `test-plan-verifier` ([feature-verification.md](feature-verification.md)) |
| `testAutomation` | test-value, correctness, acceptance, rewrite | `test-automation-verifier` |
| `prCheck` | acceptance, correctness, security, rewrite, test-value | the critic closest to the lens: acceptance → `pr-check-acceptance`, correctness and security → `pr-check-flow`, test-value and rewrite → `pr-check-style`. The defender, the judge and the fixer stay, and so do the stage's own critics no member covers: acceptance (unless a member has that lens), flow (the list of behaviour changes outside the ticket, unless a member's lens is correctness or security), design on a frontend PR (unless a member's lens is ui) and video when there are recordings ([pr-check.md](pr-check.md)) |

The `ui` lens goes only to an entry whose CLI can drive a browser: a Codex entry's sandbox cannot start one, so the lens
moves to another seat, and with no such seat nobody takes it. A Codex member still sits for `pairUiVerify` with another
lens: it checks the running app over HTTP (its verify runs may reach localhost) and in the code. The round limit and the
pass score are the stage's own (above), whatever the council's size.

`PIPELINE_AGENT_CMD` (the test fake agent) still wins over every entry's CLI. A pool entry's `env` (a second login's home
folder) is checked by `factory doctor` and `factory council check`; the metrics record the login home as configured
(`login`), never an expanded value.

A lens adds to the stage's own instructions and `AGENT_RESULT` contract; it does not replace them. Every member's task
is the stage's task, then a "Council member" section (who it is, its lens, the round, the extra fields) and the skill.

The settings load fails on a bad section or pool: an unknown key, a list of members (`council.members` is a count), a
pool entry that breaks a rule, a setting that names no pool entry. `factory council check` prints the problems, or the
pool with each entry's family and who sits for each stage.

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
   - `blockQuorum` counts the blocking members that raised the finding as non-minor, out of the blocking members that
     answered: `any` one, `majority` more than half, `all` every one. A finding below that is a note (`notUpheld`).
   - Minor findings never block. A non-blocking member's findings are feedback (`feedback`, never raised or judged) unless a blocking member raised the same, and even then only the blocking members' items decide the finding (its id, evidence, rule 4 and action); the non-blocking member's evidence is kept for the record:
     the same id or similar words, never nearby lines alone (two defects on one line stay apart), and the merged
     finding keeps a blocking member's text.
   - **Pass**: no finding stands, and every blocking member scored the stage's pass score or more (a member with no score
     does not pass). A low score counts unless every non-minor finding that member raised was ruled not upheld
     (outvoted, settled on adjudication or by an earlier round, or a question for want of evidence); a low score, or no
     score, with no finding of the member's behind it becomes a finding of its own, so the implementer has something
     to answer.
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

## Discussion between members

With `council.intercom.enabled` (off by default), a stage's first round gets a discussion step between the members'
independent reviews and the merge. It runs only in the first round, only when at least two members gave a result and
there is something to discuss: a finding, or different scores or verdicts. The members read each other's results in a chat room and can
withdraw their own findings, revise their scores, or dispute a finding:

- a point settles by a majority of all the council's seats; a finding is dropped only if its author took part;
- a split (no majority possible) is ruled by the stage's own model where it has one (the implement orchestrator for
  pair councils, the PR check judge), otherwise it goes to the owner;
- a product question is never voted: it goes to the owner, and the stage stops for that answer
  ([escalations.md](escalations.md#owner-questions-from-a-council-discussion)).

The merge then works as this page describes, on what is left. Settings, limits, the by-hand rulings and crash recovery:
[council-intercom.md](council-intercom.md).

## Who sits again in a PR check round

A member whose last score passed (the stage's pass score), with nothing it raised upheld, is carried to the next PR check round with its score when the fix touched nothing it judges. Its scope is test files for `test-value`, frontend files for `ui`, and production code for the other lenses. A member with the `acceptance` lens sits again. When every finding the last fix addressed was minor, a shorter rule replaces this one: every member that scored 10 with nothing upheld is carried, whatever the fix touched, except a member with the `acceptance` lens, whatever its name. The record marks a carried member "carried over". A non-blocking member that answers after the last round is waited for up to `council.lateGraceSec` (120); its findings become follow-ups of the check instead of being lost.

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
- A discussion adds runs bounded by its settings: [costs.md](costs.md#council-discussion).

## Records

- `.factory/metrics/council-selections.jsonl`: one `council.selection` event per pick of a stage's seats ([seats](#seats)).
- `<lessonsDir>/scorecard.json`: what the retro computes from the records below, per model, lens and stage
  ([retro.md](retro.md#council-scorecard)).
- `.factory/metrics/council-findings.jsonl`: what came of every finding, to learn which models do well in which roles.
  `kind: "finding"`: one record per finding per round per member that raised it (ticket, stage, step, round, finding
  id, the member's seat, pool entry, model, family and lens, severity, action, file and line, and `shared` when another
  member raised it too). In the PR check both carry the check run (`check`), as each check of a ticket starts its ids again.
  A non-blocking member's (the shadow's) finding is recorded too, marked `feedback`, and never gets an outcome.
  `kind: "outcome"`: in the PR check what came of it (`upheld` or `dismissed`), the judge's own
  ruling (`ruling`, null when it gave none) and who decided (`by`: `judge`, or `harness` when the finding stood
  without a ruling or the harness reversed one), with the judge's pool entry, model and family when it ruled; in the other stages `led-to-change` (the fix declaration names lines changed for it) or
  `no-change` (a note, outvoted, superseded, disputed and dropped, or no change declared). `kind: "miss"`: a problem
  found after a council passed, against the members that sat on it with the matching lens, or its sole member, each with
  its seat's entry and model (the scorecard charges that model, whoever holds the seat later): a PR check upheld
  finding by its own lens, once per check run, against the councils of the tickets it names (every ticket of the check
  when it names none), a red CI check, once per ticket, check and head (a failing test counts as `test-value`, a build or static
  analysis failure as `correctness`), and with `lowWeight` a person's "changes requested" review or a later bug ticket
  that names the ticket, against every member. Every problem but the PR check's own findings counts against the PR
  check's council too. No evidence text and no absolute path is recorded. A member's own usage
  rows (`token-usage.jsonl`) carry its `seat`, `entry`, `family` and `lens`, so its tokens, cost and seconds sum per
  member.
- `.factory/metrics/council-rounds.jsonl`: one record per council round: stage, story, step (the subtask), round,
  rounds, passScore, blockQuorum, pass, the lowest blocking score, and per member its name, pool entry, family, CLI, model, effort, lens,
  blocking, status (`ok`, `failed`, `unavailable`, `late`), score and verdict; after a discussion, also its room, its
  journal (relative to the repository) and the counts of what it settled, with each ruling and its reason.
- `decisions.jsonl`: stage `council-<stage>`, with every merged finding and why it stands or not.
- The stage's own streams as before (`subtask-runs.jsonl`, `arch-reviews.jsonl`, `verifier-runs.jsonl` with the
  members, `pr-checks.jsonl`).
- The PR description gets the skill's **Council review** table (blocking members only, `no score` when a member gave
  none), one per stage and subtask that seated a council, from the latest run. It is regenerated in place when the
  PR check runs again, like the other generated sections.

## By hand

```bash
factory council check                          # validate the section; list who sits where
factory council review --stage architectureReview   # seat the architecture review council on this branch against baseRef
factory council review --stage prCheck --base origin/main --story SHOP-1 --json
```

`review` gives every member the branch's diff and the active (or named) story, prints the merged result and the table,
records the round, and exits 0 when the council passes, 1 when not, 2 when it could not sit. The UI council needs a
leased stack slot and runs only in the pipeline.

`factory doctor` checks every member a stage seats: its CLI installed, signed in (`claude auth status`,
`codex login status`; for Copilot a token in the environment or its config folder), and its model resolving to an id.
