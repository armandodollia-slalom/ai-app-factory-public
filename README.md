# AI app factory

The AI app factory sets up an AI delivery pipeline in an existing codebase, in any language. It installs
agents that turn a ticket into a reviewed, tested pull request, plus the scripts, settings and CI jobs that
run them. The engine stays outside your codebase, and `factory uninstall` removes what it generated.

## What happens to a ticket

1. **A person starts a run** for a ticket on the board: `factory implement run <KEY> --pr`.
2. **Agents write the change.** An *agent* is an AI coding tool (Claude Code, Copilot CLI or Codex) started
   for one job. A planning agent splits the ticket into parts; each part gets a *verifier pair*: one agent
   writes it, a second agent, which never saw the first one's reasoning, checks it.
3. **Agents review and test it.** An architecture review, a test plan and automated tests, each checked by a
   separate agent, then the *PR check*: critic agents argue the change against the ticket and a judge rules.
   Each check has one verifier by default. Any of them can be given to a *council* instead: several
   verifiers on different tools and models, as many as you configure ([council.md](docs/ai-pipeline/council.md)).
   With the intercom switched on, a council's members also discuss their findings with each other before the
   harness merges them ([council-intercom.md](docs/ai-pipeline/council-intercom.md)).
4. **The *harness* proves it.** The harness is the factory's own code, with no AI in it. It runs the scanners,
   pushes the branch and waits until CI is green on that exact commit (a CI system that runs only on pull
   requests gets a draft PR, marked ready when green; with the CI wait off nothing is proven).
5. **The pull request opens once, finished**, with the evidence in its description and, for UI changes, a
   narrated demo video. A low-risk bug fix can merge itself; everything else waits for a person.
6. **When a step cannot finish**, no new pull request opens (a PR held for a re-run is kept, on hold):
   the ticket goes to Failed with the findings and up to three questions for a person, who answers them on the
   ticket and re-queues it. A check that fails after the open keeps the same PR. It gets a fixing round only
   when the PR is confirmed on hold and a round is left; with fixing turned off, the rounds used up or a hold
   that cannot be confirmed, the run stops and a person decides. On hold means a draft, a label or, where
   configured, closed until release, so a run that stops there can leave the PR still on hold.

To see the flow for your own settings, open the [pipeline explorer](https://armandodollia-slalom.github.io/ai-app-factory-public/)
(or [docs/pipeline-explorer.html](docs/pipeline-explorer.html) from a checkout, in a browser): change a setting and
the map redraws, with every decision, exit and resume path.

**Proven?** Live on GitHub and GitHub Actions with one .NET codebase on macOS, in November 2026: single
tickets, a bug group's auto-merge, and demo videos with bug evidence. Every other host, tracker and CI system, and
several features (splitting an epic into several PRs among them), are covered by tests only. Details: [What has been proven](#what-has-been-proven).

## Start here

| You are | Read, in order | Stop when |
| --- | --- | --- |
| **A.** New to it, 10 minutes | this page to here; for more detail, the [explorer](docs/pipeline-explorer.html) or the [pipeline map](docs/ai-pipeline/README.md#the-pipeline-map) | you can say what the six steps do and what is proven |
| **B.** Installing it on a codebase | [setup.md](docs/ai-pipeline/setup.md), [writing-stories.md](docs/ai-pipeline/writing-stories.md), then your first run | your first run ends `done` and its pull request is ready for review (or merged) |
| **C.** Running it, or finding out why a run stopped | [escalations.md](docs/ai-pipeline/escalations.md) (outcome, then what to do), the stage page it names, [configuration.md](docs/configuration.md) for the setting | you know which setting or answer unblocks the ticket |
| **D.** Changing the factory itself | [contributing.md](docs/contributing.md), [internals.md](docs/internals.md), [providers/contracts.md](docs/providers/contracts.md) | your change passes `npm test` and the docs say what it does |

Terms are defined in the [glossary](docs/ai-pipeline/README.md#glossary).

## Quickstart

After [installing the factory](docs/ai-pipeline/setup.md#install-the-factory), in your repository:

```bash
factory detect      # what it sees: languages, buildable units, tests, compose files, CI
factory init        # .factory/ with a draft config, and the generated files
factory doctor      # what this machine and repository still need
```

Then follow [setup.md](docs/ai-pipeline/setup.md#add-it-to-a-repository) to finish the configuration and run a first ticket.

## What has been proven

| Status | What |
| --- | --- |
| **Proven live** | On one codebase (eShop, .NET, several services), run on macOS, with GitHub as code host, GitHub Issues and Projects as tracker and GitHub Actions as CI: see the dated list below the table |
| **Covered by tests or fixtures only** | every other code host, tracker and CI adapter (against fakes built from the vendors' documentation; [status per adapter](docs/providers/README.md#verified-live-or-only-against-fakes)); feature epics split into several PRs (`--pr-split story` and `groups`); narration scope `all` and `none`; `video.bugPair.requireBefore`; council adjudication; the council intercom inside a full pipeline run, and its Copilot or custom members; crash recovery; holding an open PR whose check failed and fixing it; the commercial scanners |
| **Not proven** | other codebases and languages end to end (the Python, Go, Java and Rust analysis tools are not exercised end to end, and the Rust and Java language servers were written from documentation); Linux and Windows machines; write access through any non-GitHub adapter. Some third-party items run with a warning while their licence review is pending ([analysis.md](docs/ai-pipeline/analysis.md#licences-and-paid-client-work), [pr-demo-video.md](docs/ai-pipeline/pr-demo-video.md#toolchain-and-licences)) |

Proven live, by date (on the codebase and services named in the table unless an entry says otherwise):

- **2026-11-13**, from release 0.2.25: a bug epic whose group PR the review gate rated and auto-merged.
- **2026-11-15**: single tickets delivered as PRs through the CI wait and a CI fixing round; the fixes those runs
  found are in releases 0.2.54 and 0.2.55.
- **2026-11-17**: the provider conformance checks against GitHub, read-only (write checks skipped).
- **2026-11-20**, releases 0.2.91 and 0.2.92, on open PRs that were awaiting review at that date: the demo video
  with agent-written narration (scope `headline`) on a feature epic delivered as one PR, a UI bug's before and
  after videos, and a backend bug's request evidence posted on its ticket and PR.
- **2026-11-21**, on a small test repository rather than the codebase above: the council intercom with Claude Code
  and Codex members, which connected to a discussion room by themselves and discussed a toy change; one split was
  ruled by a model and one by hand (`factory council review --rulings`).

Behaviour the docs describe as it is, including where it falls short of the design, is listed under
[Known limits](docs/ai-pipeline/README.md#known-limits).

## Supported services

Each outside service is reached through an adapter, chosen per repository in `.factory/config.json`
([providers](docs/providers/README.md)):

| Kind | Built in |
| --- | --- |
| Code host | GitHub, GitLab, Azure DevOps (Azure Repos), Bitbucket Cloud (alpha) |
| Ticket board (tracker) | GitHub Issues and Projects, Jira, Azure Boards, GitLab Issues, Linear |
| CI system | GitHub Actions, GitLab CI, Azure Pipelines, Jenkins, CircleCI, Bitbucket Pipelines (alpha) |
| Static analysis | the factory's packs (secrets, dependencies, SAST, workflow and IaC checks, a pack per language), plus a client's licensed scanner: Semgrep, CodeQL, Snyk, SonarQube, Checkmarx or Veracode ([commercial-scanners.md](docs/providers/commercial-scanners.md)) |
| Agent CLIs | Claude Code (default), GitHub Copilot CLI, OpenAI Codex, or any command that reads a prompt on stdin; models are allowed per repository ([models.md](docs/ai-pipeline/models.md)) |
| Observability sink | none (default), a directory, an HTTP collector, a command, or OpenTelemetry logs ([observability.md](docs/observability.md)) |

An in-house product of any kind is a `custom` adapter ([custom.md](docs/providers/custom.md)).

Secrets: the harness's text records and output, and every write to a host, tracker or sink, go through one
redaction step, and records are scanned again before they are committed or pushed
([why records are scanned too](docs/ai-pipeline/analysis.md#why-records-are-scanned-too)). Video keyframes are
not masked and finished video frames are not scanned ([what the video checks cover](docs/ai-pipeline/pr-demo-video.md#secrets-never-show)).

## What it sets up

| Component | Page | Set up by |
| --- | --- | --- |
| The pipeline stages: implement, review, feature verification, PR check, review gate, board, retro | [ai-pipeline/README.md](docs/ai-pipeline/README.md) | `factory init`, then the [`onboard-codebase`](skills/onboard-codebase/SKILL.md) skill |
| 24 agent definitions, plus what each repository adds | [agents.md](docs/ai-pipeline/agents.md) | [`write-agent-addenda`](skills/write-agent-addenda/SKILL.md) skill |
| Councils: several verifiers from different tools and models in one seat | [council.md](docs/ai-pipeline/council.md) | `council` in the config |
| Council discussion (intercom): the members settle disagreements with each other, off by default | [council-intercom.md](docs/ai-pipeline/council-intercom.md) | `council.intercom` in the config |
| Static analysis | [analysis.md](docs/ai-pipeline/analysis.md) | `analysis` in the config |
| Code intelligence (language servers) | [code-intelligence.md](docs/code-intelligence.md) | [`setup-lsp`](skills/setup-lsp/SKILL.md) skill |
| Test stack (Docker Compose, seeded from scenarios) | [test-stack.md](docs/test-stack.md) | [`setup-teststack`](skills/setup-teststack/SKILL.md) skill |
| Demo videos and API summaries in pull requests | [pr-demo-video.md](docs/ai-pipeline/pr-demo-video.md) | feature `demoVideo`, `factory video install` |
| Architecture policy, checked before the AI reviewer | [architecture-policy.md](docs/architecture-policy.md) | [`author-architecture-policy`](skills/author-architecture-policy/SKILL.md) skill |
| Code host, PR identity, ticket board, CI | [providers](docs/providers/README.md), [board.md](docs/ai-pipeline/board.md) | [`setup-host`](skills/setup-host/SKILL.md), [`setup-board`](skills/setup-board/SKILL.md) skills, `factory init` |
| Observability and cost records | [observability.md](docs/observability.md), [costs.md](docs/ai-pipeline/costs.md) | [`setup-observability`](skills/setup-observability/SKILL.md) skill |
| Retro: lessons for the agents, proposals for the factory | [retro.md](docs/ai-pipeline/retro.md) | [`setup-retro`](skills/setup-retro/SKILL.md) skill |

Language knowledge lives in `packs/<language>/` (dotnet, typescript, rust, java, python, go). A language
without a pack still works; its commands are written into the config by hand or by the skills. The files the
factory writes into a repository, and who owns each, are listed in
[configuration.md](docs/configuration.md#what-ends-up-in-the-app-repository).

## Work on the factory itself

```bash
npm ci
npm test                                                  # every stage and tool, with a fake agent (no AI calls)
python3 -m unittest discover architecture-policy/tests    # the policy engine
```

[contributing.md](docs/contributing.md) has the layout, the rules and the checks.
