---
name: write-agent-addenda
description: Write the per-agent project context files (.factory/agents/<name>.md) that teach the factory's agents a codebase they have never seen, in any language or stack, from its README, CONTRIBUTING, build files, CI configuration and existing tests. Use when installing the factory into a repository, when an agent keeps guessing commands or conventions, or when the stack, layout or test setup of the repository changed.
---

# Write agent addenda

The factory ships one base definition per agent (`agents/<name>.agent.md` in the factory install). Base definitions describe the process and know nothing about any codebase. Everything an agent must know about *this* repository comes from three places:

| Where | Read by | Holds |
| --- | --- | --- |
| `.factory/agents/<name>.md` (addendum) | the agent, appended to its base definition as `## Project context` | facts and instructions about the codebase that the agent applies with judgment |
| `.factory/config.json` | the engine | settings the engine itself acts on |
| `.factory/lessons/<name>.md` | the agent, appended after the addendum | rules learned from mistakes, written by the `retro` agent |

An agent's prompt version is the hash of its base definition, addendum and lessons, so every addendum change starts a new version in the metrics.

## What goes where

Ask who needs the information and how it came to be known.

- **Addendum:** what a new engineer would be told on day one. The stack in one or two sentences; the layout; the exact build, test, lint and format commands; which existing code to copy for each concern; the test framework for each layer and how a test carries its story key and case id; the UI stack and design system; how to drive the running app; the docs that define conventions. It is true today regardless of any mistake an agent made.
- **`.factory/config.json` and `.factory/app.json`:** anything the engine runs or matches without an agent. The application's topology (`project.services`, `project.frontendPaths`, `project.testRoots`, the stack's ports, URLs and services, readiness, new projects for the policy) is in app.json; the rest of the project model (`project.name`, `project.languages`, `project.toolPaths`), the test roots and file extensions it scans for case ids, the commands of the automated pre-checks (build, filtered test run, lint, scenario validation), models and limits. If the engine and an agent both need a fact (the story-tag filter, for example), put it in the config and state the same thing in the addendum; they must agree.
- **Lesson:** a rule that exists because an agent repeated a mistake across stories. Do not write lessons by hand and do not pre-load an addendum with guesses about mistakes; the retro adds, measures and retires lessons from the logs. When a lesson turns out to be a plain fact about the codebase ("unit tests use framework X"), move it into the addendum.
- **Neither:** the factory's process (what an agent is given, its `AGENT_RESULT` shape, scoring, read-only rules). That is the base definition; an addendum must not restate or contradict it.

## Steps

1. **List the agents that need context.** Start from the skeletons in the factory's `templates/agents/`: `implementer`, `pair-implementer`, `pair-verifier`, `pair-ui-verifier`, `architecture-reviewer`, `test-planner`, `test-plan-verifier`, `test-automation`, `test-automation-verifier`, `pr-check-style`, `pr-check-design`, `pr-check-fixer`, `pr-check-flow`, `pr-check-video`. Skip the UI ones (`pair-ui-verifier`, `pr-check-design`, `pr-check-video`) when the repository has no user interface. The other agents work from the story and the debate alone and need no addendum.
2. **Read the sources, in this order,** and take notes with the file and line each fact came from:
   - `README`, `CONTRIBUTING`, `AGENTS.md` and the docs folder: purpose, architecture, conventions, how to run.
   - Build files (`Cargo.toml`, `pom.xml`, `build.gradle`, `package.json`, `pyproject.toml`, `go.mod`, `*.sln`, `Makefile`, `justfile`): modules, dependency management, the task names for build, test, lint and format.
   - CI configuration (`.github/workflows`, `.gitlab-ci.yml`, `Jenkinsfile`): the commands that really gate a merge. When CI and the README disagree, CI wins.
   - Formatter and linter configuration: what is enforced by tools, so the addendum does not repeat it as prose.
   - Existing tests, at least two per layer: framework, folder and naming, fixtures, how tests are tagged or filtered, how they reach the app.
   - One or two recent, typical changes (`git log`): which files change together for a feature.
3. **Answer these from the code** (a grep or the code graph, not memory), in `implementer.md`; each answer names the files to touch or copy:
   - **A new service or module end to end:** every place it must be registered: the orchestrator or composition root (an Aspire AppHost, a compose file, a workspace manifest), identity and auth configuration (clients, scopes), the factory's test stack: in `.factory/app.json` the service's `stack.services`, `stack.ports`, `stack.urls`, `teststack.services` and, when the stack is published from the orchestrator, its `stack.publishOverrides` entries; for a NEW service, its declaration for the architecture policy in `.factory/app.json` under `policy.services` (id, the roots of its projects, the datastores it owns). A project's class is derived from the project itself by the policy profile's conventions: name and place it like the existing ones. A project that fits no convention is escalated to a person, never declared; then `factory teststack publish` (regenerates `.factory/stack/docker-compose.yaml`; never edit that file by hand when `stack.publish` is set) and `factory teststack drift`. Agents may change `.factory/app.json` but never `.factory/config.json` or anything else under `.factory/`; name app.json, never config.json, for topology. CI build lists. Missing one of these is the most common way a new service passes review and fails on the stack.
   - **Time:** the clock abstraction in use (`grep` for `TimeProvider`, `IClock`, `Clock`, `now()` wrappers). If there is none, say which one new code injects (the platform's: `TimeProvider` in .NET 8+, `java.time.Clock`, ...) and that existing direct calls are left alone.
   - **UI rendering model:** how pages render and when interactivity is used (for Blazor: static SSR with `[StreamRendering]`, `@rendermode InteractiveServer` only where needed, forms with `[SupplyParameterFromForm]` and `Enhance`; for React: server or client components). Name one page that does it right.
   - **Optional integrations** that are off by default (AI clients, feature flags): where they are wired and that code must work with them off.
   - **Generated files** and the command that regenerates each (OpenAPI documents, client code, migrations). Run each generator in a fresh shell with the agents' PATH before you name it: the tool must exist at the version the code uses (for EF Core, `dotnet-ef` pinned in the local tool manifest at the EF Core version; `factory doctor` checks it), or the addendum sends agents into a detour.
4. **Run every command before you write it down.** Build, one unit test target, lint. Record what a fresh shell needs (toolchain path, environment variables, a dependency install). A command you could not run is marked as unverified in the addendum, with the reason.
5. **Decide the story-tag convention** for each test framework, if the repository has none: something the test runner can filter on, carrying the story key (`SHOP-3`) and, per test, the case id (`TC-SHOP-3-07`). Prefer the framework's own mechanism (attribute, annotation, marker, tag, or a name the runner can match). Put the filter command in `.factory/config.json` and the convention in the `test-automation` addendum.
6. **Write the addenda.** Copy each skeleton to `.factory/agents/<name>.md`, fill it in and delete the comments and the sections that do not apply. Rules for the text:
   - Headings start at level 3 (the file is placed under `## Project context`).
   - Instructions, not description: "Run `cargo clippy --all-targets -- -D warnings`", not "the project uses clippy".
   - Exact commands, paths and symbol names. Point at an existing file to copy for each concern rather than describing the pattern.
   - Shared knowledge lives once: write the conventions in `implementer.md` and let `pair-implementer.md`, `pr-check-fixer.md` and `pr-check-style.md` point at it ("Follow the conventions in `.factory/agents/implementer.md`").
   - No process, no result formats, nothing a formatter enforces, nothing that will be stale next month (version numbers, team names).
   - Short. An addendum is read on every run; the implementer's is the longest and rarely needs more than 60 lines.
   - Nothing from pending work. Never draw an example, a rule, an emphasis or a named endpoint from a ticket the pipeline will run: open or planned stories, bugs and epics on the board, or a bug you know about. Take every example from code the repository already has, and name concerns, not fixes ("errors return ProblemDetails", not "a negative page size returns 400"). An addendum written with a pending ticket in mind solves that ticket for the agents and hides how the factory does on unseen work. If you have read the board, say so and re-read each addendum for traces before you commit.
7. **Check.** Re-read each base definition once against its addendum: every place the base says "the Project context" must have an answer, or a deliberate silence.
8. **Commit** the `.factory/agents/` files with the configuration change they belong to. Do not create lessons files.


Before you finish, run `factory check`: it assembles every agent's prompt and fails when an addendum or lesson tells an agent to edit a path the factory guard denies it, or places topology in `.factory/config.json`.
## Worked example: a Rust service

A single Axum service with a Postgres database, a Cargo workspace (`crates/api`, `crates/domain`, `crates/store`), `sqlx` migrations and CI running `cargo fmt --check`, `cargo clippy` and `cargo nextest`.

`.factory/agents/implementer.md`:

```markdown
### Stack

Rust workspace: `crates/api` (Axum HTTP handlers), `crates/domain` (pure business rules, no I/O), `crates/store` (sqlx, Postgres). Read `docs/architecture.md` before adding a crate or a table.

### Shell setup

`cargo` is in `~/.cargo/bin`. Database-backed code compiles offline: keep `SQLX_OFFLINE=true`.

### Conventions: which example to follow

| Concern | Follow |
| --- | --- |
| New endpoint | `crates/api/src/routes/invoices.rs`: one router function per resource, extractors for auth, errors through `ApiError` |
| Domain logic | `crates/domain/src/invoice.rs`: pure functions and methods, no `sqlx`, no `tokio` |
| Persistence | `crates/store/src/invoices.rs`; a schema change is a new file from `sqlx migrate add <name>` in `migrations/` |
| Auth | `crates/api/src/auth.rs` scopes |

### Rules

- Dependency versions go in `[workspace.dependencies]` of the root `Cargo.toml`; crates use `workspace = true`.
- Time comes from the `Clock` trait in `crates/domain/src/clock.rs`, never `Utc::now()`.
- After changing a query, run `cargo sqlx prepare --workspace` and commit `.sqlx/` (generated; never edit by hand).
- No `unwrap()` or `expect()` outside tests.

### Checks before you commit

- Build: `cargo build --workspace`
- Unit tests of a crate you touched: `cargo nextest run -p <crate> --lib`
- Lint and format: `cargo fmt --all -- --check` and `cargo clippy --workspace --all-targets -- -D warnings` (`cargo fmt --all` fixes formatting)
- Do not run `cargo nextest run --test '*'` (integration tests need the test stack).
```

`.factory/agents/test-automation.md`:

```markdown
### Test framework per layer

- `functional`: integration tests in `crates/api/tests/<story-key-lowercase>.rs`, using the `TestApp` fixture in `crates/api/tests/common/mod.rs` against the test stack.
- `unit`: `#[cfg(test)]` modules next to the code in `crates/domain`.
- `e2e`: none; this service has no UI. Report a case with layer `e2e` as a plan problem.

### Story tag

Rust has no test attributes to filter on, so the name carries both: every test function is `tc_<key>_<nn>_<slug>` inside a module named after the story, for example `mod shop_3 { #[tokio::test] async fn tc_shop_3_07_expired_coupon_is_rejected() { … } }`. The case id is the function name with underscores for dashes, upper-cased.

### Commands

- Build: `cargo build -p api --tests`
- A story's tests: `cargo nextest run -p api -E 'test(/shop_3::/)'`
```

`.factory/config.json` gets the matching engine settings: `project.languages: ["rust"]`, `project.toolPaths: ["~/.cargo/bin"]`, the test roots (`crates`), the `.rs` test extension, and the pre-check build and filtered test commands above.

## Worked example: a Java/Spring service

A Spring Boot service built with Gradle, JUnit 5, Flyway migrations, Testcontainers for integration tests and Spotless plus Checkstyle in CI.

`.factory/agents/implementer.md`:

```markdown
### Stack

Java 21, Spring Boot, Gradle. One module per bounded context under `services/` (`services/billing`, `services/accounts`), each layered `web` → `application` → `domain` → `persistence`. `docs/adr/` records the decisions; read the ADRs of the module you touch.

### Conventions: which example to follow

| Concern | Follow |
| --- | --- |
| New endpoint | `services/billing/src/main/java/.../web/InvoiceController.java`: request and response records, `@Valid`, errors through `ProblemDetail` in `GlobalExceptionHandler` |
| Use case | `.../application/CreateInvoice.java`: one class per use case, `@Transactional` here and nowhere else |
| Domain logic | `.../domain/Invoice.java`: behaviour on the aggregate, no Spring annotations |
| Persistence | Spring Data repositories in `.../persistence`; schema changes are a new `V<n>__<name>.sql` in `src/main/resources/db/migration` (never edit an applied migration) |
| Events | `.../application/events`, published with `ApplicationEventPublisher` after commit |

### Rules

- Dependency versions go in `gradle/libs.versions.toml`, never in a module's `build.gradle.kts`.
- Inject `java.time.Clock`; never call `Instant.now()` or `LocalDate.now()` without it.
- Constructor injection only; no field `@Autowired`.
- `build/generated/` (OpenAPI client) is produced by `./gradlew openApiGenerate`; do not edit it.

### Checks before you commit

- Build: `./gradlew assemble`
- Unit tests of a module you touched: `./gradlew :services:<module>:test`
- Lint and format: `./gradlew spotlessCheck checkstyleMain` (`./gradlew spotlessApply` fixes formatting)
- Do not run `integrationTest`; it starts Testcontainers and belongs to feature verification.
```

`.factory/agents/test-automation.md`:

```markdown
### Test framework per layer

- `functional`: JUnit 5 with `@SpringBootTest` and Testcontainers in `services/<module>/src/integrationTest/java`, extending `AbstractIntegrationTest`.
- `unit`: JUnit 5 in `services/<module>/src/test/java`, no Spring context.
- `e2e`: Playwright specs in `e2e/`, loading the scenario with `loadScenario('<scenario>')`.

### Story tag

Every test class for a story has `@Tag("SHOP-3")`; every test method has `@Tag("TC-SHOP-3-07")` and a name containing the case id with underscores: `TC_SHOP_3_07_expiredCouponIsRejected`.

### Commands

- Build: `./gradlew :services:<module>:integrationTestClasses`
- A story's tests: `./gradlew :services:<module>:integrationTest -PincludeTags=SHOP-3` (the `includeTags` property is wired to `useJUnitPlatform { includeTags(...) }` in `build.gradle.kts`)
```

In both examples `pair-implementer.md` and `pr-check-fixer.md` are three lines: a pointer to `.factory/agents/implementer.md` and the build and unit test commands.

**Architecture reviewer.** Tell it to check, for every project a change adds, that its derived class (type and layer, from the policy's conventions) matches what the project is and does, and that a declared new service really is new. Its task lists those classes ("New projects and their derived classes", from the policy's CLASSIFY-001 items), and `factory arch classes --policy-dir .factory/policy --workspace .` prints every project's class with the facts it was derived from. Never tell it the factory makes this check unnecessary: the factory derives the class from the project, but it cannot know whether the project was put in the right place.
