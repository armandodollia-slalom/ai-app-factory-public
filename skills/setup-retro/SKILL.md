---
name: setup-retro
description: "Set up the factory retro for the repository you are in: connect it to the service that stores the agents' observability data, decide where its two kinds of fix go (this repository's lessons, addenda and policy; and pull requests against the factory itself), and schedule it. USE FOR: \"set up the retro\", \"connect the retro to our metrics store\", \"make the agents learn from their mistakes\", \"let the retro open PRs against the factory\", or a `factory retro status` that says it reads this checkout only."
---

# Set up the retro

The retro reads what the agents logged (verifier denials, review findings, product bugs the tests found, PR
check findings, how people reviewed the pipeline's PRs) and produces two things:

- **For this repository:** a pull request that updates `.factory/lessons/<agent>.md` and, when the decision
  log shows a deeper cause, the agent addenda and the architecture policy.
- **For the factory:** when the cause would hit every codebase (a base agent definition, the factory's docs,
  a template, a skill), a separate pull request against the factory.

```bash
factory retro status
factory retro run --dry-run     # what it would ask for; no agent, no branch
```

## 1. Connect it to the metrics store

`factory retro status` says what the retro can read. "This checkout only" means it misses CI runs and other
developers. Run the `setup-observability` skill first and pick a store that can be read back; then:

```bash
factory sink test       # must end with "Read it back"
factory retro status    # "this checkout plus the <type> store"
```

Each run pushes what is new, pulls the window since the last lessons commit on the base branch, and reads
both without duplicates. Nothing else needs configuring for the connection.

## 2. Where this repository's fixes may land

`retro.allowedPaths` in `.factory/config.json` (default `.factory/agents/`, `.factory/policy/`),
plus the lessons files. Edits anywhere else are discarded before the commit. Widen it only for paths the
person names; never include application source.

The approvals table of the review gate (`implement.reviewGate.approvals`) is changed by the harness, from
review records with guards in code, and written to `.factory/config.json` in the same pull request.

## 3. Where factory fixes go

The retro gives the agent a checkout of the factory inside the lessons worktree's ignored state folder.
Its edits there, limited to `agents/`, `docs/`, `templates/` and `skills/`, become a branch pushed to the
factory's remote and a pull request, opened with the developer's own `git` and `gh` login.

Settings, under `retro.factory` in `.factory/config.json`:

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | `false`: factory-level findings are only listed in this repository's pull request |
| `source` | the pin's `source`, else the install's `origin` | the factory repository to open the pull request against |
| `allowedPaths` | `agents/`, `docs/`, `templates/`, `skills/` | what the agent may edit in the factory checkout |
| `evidence` | `summary` | what the factory pull request says about this repository: `summary` is the agent's one-line reason per file, `none` is the file list only |

Check three things with the person:

1. **Access.** Can their login push a branch to the factory repository? If not, the run saves the change as
   a patch under `.factory/state/retro/` and says so; someone with access sends it. Verify with
   `git ls-remote <source>` and `gh repo view <source> --json viewerPermission`.
2. **What may leave.** If the factory is shared with other teams or clients, keep `evidence` at `summary`
   or set `none`. The decision log itself is never copied to the factory.
3. **The install is a git checkout.** `factory version` prints where the engine is installed; the retro
   clones from there. An install without `.git` (a packaged copy) gets no factory checkout.

A factory fix reaches this repository only when a release containing it is pinned (`factory upgrade
<version>`, then `factory render`). Until then, the same fix can live here as an addendum.

## 4. Schedule it

| How | When to use it |
| --- | --- |
| `factory retro run` by hand | while the factory is new here: read every pull request it opens |
| `git config retro.auto true` | runs `retro run --if-due` after merges, at most once per `retro.intervalDays` (7) |
| the `factory-retro.yml` workflow | weekly on CI; needs the agent CLI's credential and, for a store, its secrets |

Thresholds (`retro.lessons.storyThreshold`, `retro.lessons.maxRules`, `retro.lessons.retireAfterStories`) are in `.factory/config.json`;
leave the defaults until a few runs show they are wrong.

## 5. Prove it

Run `factory retro run --no-push` once there are records. It prints the branch it committed to; show the
person the diff. Report a run that found nothing to do as exactly that, not as a working retro.
