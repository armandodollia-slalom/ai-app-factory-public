# Council discussion (intercom)

**Who reads this:** B and C, when a [council](council.md) should settle disagreements among its members before the
harness merges them. With `council.intercom.enabled` (off by default), the members of a council talk to each other
directly in a chat room after their independent first round, so the orchestrator's context is not filled with their
discussion. It gets a small result instead: settled disputes, rulings, owner questions, withdrawn findings and
changed scores. The members' rules are in the [`council` skill](../../skills/council/SKILL.md#discussion-intercom).

With the setting absent or `false`, no server starts and round 1 runs as before; the few differences are listed under
[Changes when the setting is off](#changes-when-the-setting-is-off).

## When a discussion runs

Only in round 1, only after every seated member has returned (with the setting on, round 1 also waits for
non-blocking members), only when at least two members gave a result, no member changed the working tree, and there is
something to discuss: a finding, or members whose scores or verdicts differ. Later rounds never discuss.

## The room

One MCP server per `factory` process, hand-written on `node:http` (Streamable HTTP, JSON-RPC 2.0, no dependency),
hosts any number of rooms at once: parallel stories and councils of one run share its listener, started on first use
and stopped when the last room closes. Two `factory` processes each run their own on a free port. A council whose
`host`, `port` or `advertiseHost` differ from the running listener's gets no discussion (the log says why) and its
round goes on with round 1 alone.

- **Seats and tokens.** Every member of the council has a seat, including one that gave no result (it can never join,
  and it still counts for the majority). Each member that joins gets a random bearer token for its seat of this room,
  through its CLI's own MCP option and the environment (`--mcp-config` for Claude Code, `-c mcp_servers.…` with
  `bearer_token_env_var` for Codex, `--additional-mcp-config` for Copilot, `FACTORY_INTERCOM_URL` and
  `FACTORY_INTERCOM_TOKEN` for a `custom` command); never in a prompt, an argument, a log, the journal or a metric. A
  member's `env` cannot override these variables. A token works only for its own room and seat, and not at all once
  the room is closed. A member that makes no call to the room has no further turn; what it prints is never read.
- **Seed.** Every member's round-1 result as it wrote it (redacted), plus an index of findings keyed `<seat>:<n>` (the
  n-th finding of that member: two findings with the same id are two keys). A member's own id works as an alias when
  it names exactly one finding.
- **Tools.** `read_messages` (pass `since` to move your cursor; it moves only then, so a lost reply is read again),
  `post_message` (a post; it may withdraw findings its author raised and revise the author's score or verdict, the
  only way a score changes), `open_dispute`, `vote_dispute`, `room_status`. A `requestId` makes a call safe to retry:
  the retry gets the first answer; the same id with another tool or other arguments is refused.
- **Limits.** Bodies over 64 KB are refused, and so is every argument the tool does not take or that is over its bound,
  before anything else looks at it. Any `Origin` header is refused, and any `Host` other than the bound or advertised
  address. Each member has `maxTurnsPerMember` posts and twice as many
  dispute and vote calls (an identical re-vote is free); a dispute names a seeded finding.
- **Redaction.** Everything a member sends passes the factory's redaction boundary and a search for every token this
  process issued (next to punctuation, inside a longer word) before the room sees it; an id that held a credential is
  refused without being echoed. Every journal event passes the same boundary as it is written.

## Disputes

| Kind | Settled by | Notes |
| --- | --- | --- |
| `fix` | a majority of all seats, counted on `effect` (`drop`, `keep`, `note`) | the position's wording is never counted |
| `fact` | the same | every position and vote cites `file:line` of a line that exists in a file inside the repository (symlinks resolved); the line must start within the file's first 2 MB, and one call reads at most 4 MB of cited files |
| `product` | never voted | an owner question at once |

- A finding is dropped or noted by the majority only if its author took part in the room (called one of its tools at
  least once before it closed); the author's silence on that one dispute is no veto. Nothing is dropped while the author has not
  taken part yet, and a finding whose author never did goes to the owner.
- No majority possible (three positions, or 1–1 with two members) is a split. The room makes an escalation record: the
  question in one sentence, each seat's effect and position in at most two lines, and the evidence. Where the stage
  has a model with the implementation context (the implement orchestrator for pair councils, the PR check judge for
  PR check councils), the harness asks it once, read-only, with only that record, fenced as JSON and marked as
  member-written data, never instructions. Its run must finish successfully and answer `{ "ruling", "reason" }` with
  a one-line reason; anything else (an error, a timeout, an oversized or malformed answer) makes the split an owner
  question, without a retry. The review and feature verification stages have no such model: a split there is an
  owner question.
- `maxEscalations` splits at most go to a ruling; beyond it, and with `onSplit: "owner"`, a split is an owner question.
- A closed dispute is never reopened in the round.

## What the merge does with it

`mergeCouncil` takes every finding the discussion disposed of (withdrawn, dropped, noted, held for the owner, awaiting
a ruling) out by its `<seat>:<n>` key before it groups findings, so it never joins another member's finding, counts for
`blockOn` or sets a severity. It stays as a note with its `disposition` (the earlier one wins: a vote, then a later
withdrawal, reads as the vote), and it still explains its member's low score. The architecture review never lifts such
a note to blocking, and the PR check never sends it to the debate, the judge or the fixer. Revised scores are used. A
council with an owner question or a split awaiting a ruling does not pass. Owner questions go where each stage already
sends them ([escalations.md](escalations.md#owner-questions-from-a-council-discussion)): the pair subtask is blocked for the owner, the architecture review and both feature
verification loops escalate (never passing over the question, also when a URL-caption gap is demoted), and the PR
check ends at `QUESTION` before any fixing round. The council round's metrics record the room, its counts and the
rulings with their reasons.

## By hand

`factory council review` runs the discussion too. A split there waits for you (or the model calling the command):
the result lists each awaiting dispute with the room id. Answer with a second call that runs nobody:

```bash
factory council review --stage review --rulings .factory/state/rulings.json
```

```json
{ "roomId": "review--SHOP-1--r1--…", "rulings": [{ "disputeId": "D1", "findingId": "opus:1", "ruling": "drop", "reason": "the line is dead code" }] }
```

Everything is checked before anything is written, under a lock on the room (one `--rulings` call at a time): the room
finished, it was this stage's, its members still sit, the checkout (HEAD and working tree) is the one the council
reviewed, and each ruling names, by both ids, a dispute of that room that still awaits a ruling, with one line of
reason of at most 300 characters. Any refusal names the entry and applies nothing. Accepted rulings are written to the
room's journal once and merged with the saved round-1 results. Keep the rulings file outside the checkout or under
`.factory/state`: a new file in the working tree is a changed checkout. Without the factory, the orchestrator relays
every result verbatim to the other members and applies the same rules (see the skill).

## Journal and crash recovery

Each room has a journal, `.factory/state/council/intercom/<room>.jsonl`, created exclusively (never overwritten or
deleted). Every event is redacted, written and `fsync`ed before the room changes and before the member gets an
answer, so after a crash the journal is complete up to the last acknowledged event. When the factory process dies, its
member CLIs die with it, so a room is never resumed or reattached: a server only ever serves rooms it created.

A re-run of the same council round (same subject, stage, step and round, the same reviewed inputs (the stage's base
and diff, or its task), the same checkout and the same member results; any change starts afresh):

- finds a **finished** room: it reuses its saved result and nobody discusses again;
- finds an **unfinished** room: it appends an `abandoned` event, keeps the file for audit, and runs the discussion
  again from the start in a new room. Nothing from the unfinished room is applied. If the discussion of that round was
  already run again once and was interrupted again, the round merges round 1 alone.

Reading a journal ignores an unfinished last line (no trailing newline: never acknowledged); any other line that does
not parse is an error naming the file and line, and the journal is left as it is. A discussion that fails in any way
(it cannot write its journal, it cannot close its room) is logged and dropped, and round 1 is merged alone. A room is
finished only through a `finished` marker, written last, after the close event was synced and the journal closed: the
discussion succeeds when that marker is on disk (an error closing the file afterwards is only logged), and before it
any failure drops the result and the room is never reused. A journal write that fails is cut off the journal again,
and the room then refuses every further write. A by-hand ruling batch is one journal record: a failed write applies
none of it, and the same file can be submitted again.

## Settings

Under `council.intercom`, and per stage under `council.stages.<stage>.intercom`; validated when the configuration
loads; `factory doctor` and `factory council check` report them.

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | run the discussion |
| `host` | `127.0.0.1` | the address the listener binds: a hostname or an IP address, not a URL |
| `port` | `0` | `0` is a free port; a fixed port already in use fails with a message naming this setting |
| `advertiseHost` | none | the address members are given; required, and never a wildcard, when `host` is not loopback |
| `allowInsecureRemote` | `false` | required to bind anything but loopback |
| `maxTurnsPerMember` | `2` | posts per member (1 to 20); also the number of discussion waves |
| `maxEscalations` | `3` | splits that go to a ruling (0 to 20) |
| `onSplit` | `orchestrator` | `owner` sends every split to the owner |

## Changes when the setting is off

- `factory doctor` prints a `council intercom` row that says the setting is off.
- `factory council review --rulings <file>` stops with an error instead of ignoring an option it did not know.
- The read-only check of every council round also catches a member that rewrites a file that was already untracked
  (before, only the file's name was compared).

**A member on another machine.** Keep `host` at `127.0.0.1` and forward the port over SSH (`ssh -R`). A non-loopback
`host` makes `factory doctor` warn, because without a tunnel the bearer token crosses the network in clear HTTP.
