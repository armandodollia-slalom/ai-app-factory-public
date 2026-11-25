---
name: onboard-codebase
description: "Generate the AI app factory for the repository you are in, whatever its language (Rust, Java, Go, Python, TypeScript, .NET or one no pack knows): run `factory init`, then turn its draft into a correct project model with real build, test and lint commands, and hand over to the component skills. USE FOR: \"set up the factory here\", \"onboard this repo\", \"point the factory at this codebase\", a repository that has no .factory/ folder yet, or one whose .factory/config.json is still the draft."
---

# Onboard a codebase to the factory

Result: `.factory/config.json` describes this codebase truthfully, the generated files are in place, and
`factory doctor` lists only components the person chose not to set up.

The engine is installed outside this repository. Run it as `factory`; if that is not on PATH, use
`node <path to the factory checkout>/bin/factory.mjs` until `init` has written `.factory/bin/factory`.

## 1. Read before you write

1. `factory detect`: languages, buildable units, compose files, CI, docs. It reads file names only.
2. Read what it listed: the README and CONTRIBUTING, the CI workflow (the commands CI runs are the commands
   that work), the build files of each unit, and one existing test per test framework.
3. Ask the person about every stage, through the factory's setup interview: `factory init` asks it in a terminal,
   and it is the same list of questions for an agent (`factory init --questions` prints them with their ids). Show
   what detection found as the default and have the person confirm or correct it, never assume it:
   - the code host (detected from `origin`: GitHub, GitLab, Azure DevOps, Bitbucket, or a server detection only
     guessed), its URL and repository;
   - the ticket board: which product (GitHub Projects, Jira, Azure Boards, GitLab, Linear, or their own through a
     custom adapter), its URL, project and board, an existing or a new board, whether it is shared, and how its
     statuses map to the pipeline's lanes;
   - the CI system (the host's own by default; Jenkins, CircleCI and others are chosen independently);
   - who may merge (the review gate's auto-merge and its identity) and whether an admin will enforce the gate;
   - the agent CLIs installed and signed in here and allowed in CI, and the models each may use (the council is
     seated from these), whether a browser and the test stack are available for UI verification and videos, where
     metrics go, whether static analysis runs, and the client's commercial scanner if they have one.
   Never ask for a token's value: credential questions take the NAME of the environment variable or CI secret.
4. Write the answers to a file and run the interview headless, so the result is the same as typed:

   ```json
   { "tracker.type": "jira", "tracker.url": "https://acme.atlassian.net", "tracker.project": "SHOP",
     "tracker.token": "JIRA_API_TOKEN", "ci.provider": "jenkins", "agents.local": "claude, codex" }
   ```

   `factory init --answers answers.json --dry-run` shows what it would write; drop `--dry-run` to write it. A later
   run edits the config (each current value is the default), never overwrites it.

## 2. Generate

```bash
factory init --answers answers.json --tools <the tools they use> [--with graphify] [--without lsp,ci]
```

It never overwrites an existing `.factory/config.json`: with answers it edits only what they change. Everything it wrote outside `.factory/` is listed in
`.factory/manifest.json`; `factory uninstall` takes it all back.

## 3. Correct the draft

Open `.factory/config.json` and `.factory/app.json` (the application's topology: services, stack ports and URLs, readiness; product agents may change it, so keep only topology there). The draft comes from file names, so check every part against what you read.

`host`, `tracker` and `ci` in `.factory/config.json` (never `app.json`: they are governance, with token references) come from the interview; `setup-host` and `setup-board` finish them. Run `factory render` if `ci.provider` changed: it writes that CI system's files instead.

| Section | Make it true |
| --- | --- |
| `project.services` | One entry per deployable or separately built unit: `name`, `kind` (`backend`, `frontend`, `worker`, `library`), `paths` (globs that own its files), `unitTests` (where its unit tests live). Remove units that are tooling, examples or generated code. A monolith is one service. |
| `project.frontendPaths` | Globs of everything a user sees: templates, components, styles. Empty for a codebase without UI. |
| `project.configSources` | Globs of the files where the application's configuration defaults live: options or settings classes, `appsettings*.json`, config modules, `.env.example`, settings modules. The repeated-values check compares new fallbacks and literals with them (a `?? 900` beside an options default of 900). `init` drafts it from the language packs' candidates; read the code for where defaults are really declared. When you cannot find where they live, ask the person; never guess a source. |
| `project.toolPaths` | Folders that hold the toolchain when it is not on the default PATH (hooks do not load a shell profile). |
| `implement.prepareCmd`, `implement.checks`, `implement.unitTests` | The commands CI runs to restore, build and unit-test. Run each one yourself; a command you have not seen pass does not go in. |
| `precheck.testRunners` | One runner per test framework in use, with the convention that ties a test to its story. Start from the pack's `tests.json`; adjust paths. |
| `precheck.lint`, `precheck.fix` | The linters and formatters CI enforces, per file extension. Every language agents will write needs one: when the repository has TypeScript or JavaScript (Playwright specs, scripts) but no ESLint, keep the TypeScript pack's own ESLint that `init` drafted (`node {packs}/typescript/lint/eslint.mjs`). Lint runs on changed lines only (`factory lint`), so existing findings do not block. |
| `implExclude` | Test folders and anything else that is not implementation. |
| `baseRef` | The branch PRs target, when it is not `origin/main`. |
| `project.services[].kind`, `dependsOn`, `partOf` | `library` for code that builds no executable, `host` for an orchestrator (an Aspire AppHost). `dependsOn` from the build files' references (init drafts them). A library used by exactly one service is part of it for the review gate; check that `factory review-gate explain <a domain file>` names the service, not a shared system. For every library several units use, decide whether it is shared (High on any change) or part of one service (`partOf`), counting users outside the model too (a mobile or desktop client in the full solution but not in the one the pipeline builds), and record the decision and its reason on the entry as `"$decision": "..."`. |
| `implement.reviewGate.floor.paths` | Every path where a change must never auto-merge: identity and authentication, payments, schema migrations, CI, the factory's settings. `init` drafts them from names and the language pack; read the code for the ones it missed (auth configuration in a shared project, a payments folder inside a service). |
| `implement.reviewGate.sharedPaths`, `contractPaths` | Shared code no service owns (root build files, linked source folders) and the contracts other services depend on (integration events, published API schemas). Prove the model with `factory review-gate explain <file>` on one file per sensitive area, one shared file, one contract and one test: each sensitive, shared and contract file must come out High on Low ratings, the test must touch no system. |

For a language no pack covers, write these sections by hand from the CI workflow: the engine needs commands
and globs, not a pack.

Rules:

- Every command must be one you ran in this repository and saw succeed. Record nothing from memory.
- Paths are globs relative to the repository root. No two services may own the same file.
- Do not copy another repository's config. Do not invent services to make the model look complete.

## 4. Verify

```bash
factory check          # generated files in step
factory stages         # the engine loads this repository's config
factory implement run --dry-run <a story key>    # only once the board is set up
factory doctor
```

Then build once with the configured commands, exactly as written in the config.

## 5. Hand over to the component skills

Each is independent; do the ones the person wants, in this order:

1. `write-agent-addenda`: what the agents must know about this codebase.
2. `setup-lsp`: code intelligence for its languages.
3. `setup-teststack`: the scenario-seeded Docker stack that feature verification tests against.
4. `author-architecture-policy`: the rules the review enforces before the LLM reviewer.
5. `setup-host`: the PR identity and the branch policies on the code host, and the CI system's one-time setup.
6. `setup-board`: the ticket tracker, its lane, type and field mapping, and the review gate.
7. `setup-observability`, then `setup-retro`: where agent metrics are stored, and the retro that learns from them.

Commit `.factory/` and the generated files together, in one commit that changes nothing else.
