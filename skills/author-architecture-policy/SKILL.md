---
name: author-architecture-policy
description: "Draft or extend the architecture policy of a codebase (.factory/policy): fill the profile (projects, services, layers, datastores) from the architecture docs and the code layout, choose or write rules against the policy schema, validate them with the Architecture Policy Pack engine, measure false positives on recently merged pull requests, and hand the draft to a person for approval. Works for any stack (Rust, Java, Python, Go, TypeScript, .NET, ...). USE FOR: \"set up the architecture policy\", \"add an architecture rule\", \"the policy step says no architecture policy configured\", \"classify this new module in the profile\", a rule that blocks correct code. DO NOT USE FOR: fixing code a rule flagged (fix the code), waiving one finding (add an entry to exceptions/exceptions.yaml with a human approver), changing the engine (architecture-policy/ in the factory install)."
---

# Author an architecture policy

The Architecture Policy Pack engine (`$FACTORY_HOME/architecture-policy`) evaluates rules; it contains none. A repository's rules are its policy, in `.factory/policy/`. This skill produces that policy for a codebase you have not seen before, and proves it before anyone is blocked by it. Reference: `$FACTORY_HOME/docs/architecture-policy.md`.

You draft. A person approves. A policy blocks other agents' work, so never merge one, and never turn a rule to `block`, on your own judgment.

```bash
ARCH="$FACTORY_HOME/architecture-policy/hooks/arch.py"     # run from the repository root
factory python setup                                        # once: the engine's Python, in a virtualenv
PY="$(factory python | cut -d' ' -f1)"                       # the interpreter doctor and the review use
```

## 1. Start from the template

If `.factory/policy/policy.yaml` does not exist, copy the starter and rename it:

```bash
mkdir -p .factory && cp -R "$FACTORY_HOME/templates/policy" .factory/policy
# policy.yaml: set `name` and `owner`
"$PY" "$ARCH" selfcheck          # must print SELFCHECK PASSED before you change anything
```

The starter has six rules that need no stack knowledge. `SEC-001` (secrets), `ARCH-004` (boundaries, judged by the reviewer) and `ARCH-008` (generated files) are active at once. `DATA-002`, `TEST-001` and `API-003` stay silent until the profile names datastore owners, test trees and the projects that publish an API.

If a policy exists, read `policy.yaml`, the profile and `"$PY" "$ARCH" rules` first, and extend it.

### Add the language pack's rule library

A language pack may ship a library of rules proven on a real codebase of that stack (`factory policy-library list`). For a .NET codebase it covers API versioning and write authorization, layering and service isolation, parameterized SQL, migrations, the outbox, swallowed exceptions, ProblemDetails, `IHttpClientFactory`, sync-over-async, structured logging, token validation and sensitive logging. Add it before you write rules of your own:

```bash
factory policy-library add <pack>     # e.g. dotnet; --rules ID,ID for a subset
```

Then, in the next steps: classify every project with the library's vocabulary (its `README.md`: project types `api`, `web`, `worker`, `domain`, `infrastructure`, `library`, `host`, `client`, `test`), tune every line marked `TUNE` to this codebase (where endpoints are mapped, the outbox and event names, the sensitive folders, exemplars), and remove library rules whose subject the codebase does not have (no event bus, no service defaults). Library rules keep their enforcement levels (they were proven); step 6 decides which of them must drop to `warn` here.

## 2. Read the architecture before the code

In this order, and stop when you can answer the questions in step 3:

1. Architecture documents: `docs/architecture*`, ADRs, `README`, `CONTRIBUTING`, `AGENTS.md`. Write down every stated constraint ("the domain has no I/O", "services share no database"). Each is a rule candidate with its rationale already written.
2. The build layout: the workspace or root manifest (`Cargo.toml` `[workspace]`, root `pom.xml` `<modules>`, `settings.gradle`, `go.work`, `pnpm-workspace.yaml`, a solution file) lists the buildable units.
3. Who depends on whom: each unit's manifest. The dependency direction that already holds everywhere is the layer order.
4. Data: migrations, connection configuration, compose or deployment files. Which unit connects to which database.
5. Tests: where they live relative to the source they cover.

If the repository has a knowledge graph (`graphify query`), ask it instead of reading files one by one.

Write only what the code or a document supports. A rule nobody decided is an opinion; put it in the summary as a question for the approver.

## 3. Fill the profile

`.factory/policy/profile.yaml` is the only place that knows the stack. Rules refer to it instead of to paths. Projects the agents add later are classified from the project itself by the profile's `classification` conventions (docs/architecture-policy.md, "Who classifies a project"). Write them from the existing projects:
- one convention per class (type and layer), matching what those projects share: path roots, SDK, test-ness, output type, name patterns, MSBuild properties;
- `service_names`, mapping each name prefix to its service;
- each convention must fit exactly its own projects.

`selfcheck` (`classification_conventions`) fails until every listed project gets the same class from the conventions as from its entry.

Also profile every linked-source folder, a folder of source files compiled into projects from outside them (`<Compile Include="..\Shared\...">`, no project file of its own), usually as `library`/`shared`; `selfcheck` (`linked_sources`) lists the ones missing. In rule, pattern and validator texts, write `{profile_file}` and `{topology_file}`, never a literal path: the engine renders them from the resolved files.

| Key | Fill with | Find it in |
| --- | --- | --- |
| `projects` | One entry per buildable unit: `name` as the build system names it, `path`, `type`, `service`, `layer` | The workspace manifest |
| `services` | Each independently owned part, its `owns_datastores`, its `traits` | Deployables, bounded contexts, connection configuration |
| `layer_dependencies` | For each layer, the layers it may reference | The dependency direction that already holds |
| `forbidden_packages_by_layer` | Third-party packages a layer must not use | "No I/O in the domain" style constraints |
| `test_mapping` | Source tree to test trees | The test layout |
| `project_manifests` | Globs of the manifests that define a unit | The build system |
| `comment_prefixes` | Line prefixes of comments | The language |
| `global_exclude` | Build output, vendored and generated trees | `.gitignore` |

`type`, `layer` and `traits` are your vocabulary; keep it small and use the words the team uses. A layer used by a project must be a key of `layer_dependencies`. Shared libraries have no `service` and usually `layer: shared`.

Run `"$PY" "$ARCH" selfcheck` after the profile: it fails on a project path that does not exist and on a manifest that belongs to no project.

## 4. Choose rules

For each constraint from step 2, in this order of preference:

1. **A starter rule already covers it.** Adjust its `applicability` and enforcement.
2. **A generic validator can check it.** Add a validator to `validators/registry.yaml` and a rule that uses it:

   | Constraint | Implementation |
   | --- | --- |
   | "X must not appear in these files" (an import, a call, a literal) | `text_validators:forbidden_pattern` |
   | "Every file like this must contain X" (a registration, a header) | `text_validators:required_pattern` |
   | "Layer A must not depend on layer B" | `project_validators:layer_dependencies` |
   | "No dependency across services" | `project_validators:service_isolation` |
   | "This layer must not use these libraries" | `project_validators:forbidden_packages` |
   | "A service uses only its own database" | `data_validators:database_ownership` |
   | "Applied migrations are never edited" | `data_validators:migration_immutability` |
   | "Source changes come with tests" | `change_validators:tests_accompany_changes` |
   | "Tests are green", "coverage is at least N" | `evidence_validators:test_results`, `evidence_validators:coverage_threshold` |

   Their params are listed in `docs/architecture-policy.md` and in each function's docstring under `architecture-policy/validators/`.
3. **It needs judgment** ("handlers are idempotent", "errors are not swallowed"). Write a semantic rule: `mode: semantic`, `validators: [VAL-SEMANTIC-REVIEW]`, with a `rubric` that says what passes and what fails, concrete `questions`, and `pass_criteria`. Semantic rules never run at `pre_commit` and should `warn`.
4. **None of these.** Do not approximate it with a regex that will misfire. List it in the summary as not expressible; a new generic validator is an engine change.

For patterns (`patterns/*.yaml`): add one when a rule has a preferred way to comply. Give an approved example and an anti-pattern in the codebase's language, and `exemplars` pointing at real files that do it well. A pattern and its rules must list each other.

Writing a rule:

- Copy an existing rule and change it; every field is required by `architecture-policy/architecture-rule.schema.json`. The ID is `<category prefix>-<NNN>`, in that category's file. A new category is one line in `policy.yaml` `categories` plus its file.
- `applicability.include` globs decide which files the rule sees; `project_types` and `service_traits` narrow it through the profile. Prefer those to path lists.
- Every deterministic validator needs at least two `self_tests`, one that fails and one that passes, on file contents typical of this codebase. Give a test its own `profile:` block when it should not depend on the real project list.
- New rules you write start at `enforcement: warn`; `block` is the approver's decision, after step 6. Rules from a pack library keep the library's levels unless step 6 shows a false positive on this codebase's history (then `warn` until the rule is fixed).
- `critical` severity on a deterministic rule requires `block` at `ci` (selfcheck enforces it); use `high` while a rule is on trial.
- A regex param is YAML single-quoted; a `'` inside is written `''`. Group names are fixed: `ref` in `reference_patterns`, `name` in `package_patterns` and `connection_patterns`.

Existing violations of a rule you are adding are not a reason to weaken it. Record each as an entry in `exceptions/exceptions.yaml` with an expiry, and name the person who must approve it; never fill in `approved_by` yourself.

## 5. Validate

```bash
"$PY" "$ARCH" selfcheck                       # schema, IDs, cross-references, validator self-tests, profile against the code
"$PY" "$ARCH" validate --checkpoint ci        # the whole repository as it is today
"$PY" "$ARCH" rules --files path/to/a/file    # which rules a file gets
"$PY" "$ARCH" docs                            # optional: render architecture-rules.md for readers
```

Fix every selfcheck error. Read each finding of the `ci` run: a true violation becomes an exception candidate or a fix for the team; a false one means the rule's globs or regex are wrong, so fix the rule.

## 6. Dry-run on merged pull requests

Before anyone is gated, measure what the draft would have said about work that was reviewed and merged. Each of the last N commits on the main branch is checked out in a temporary worktree and evaluated with the draft policy:

```bash
ARCH="$FACTORY_HOME/architecture-policy/hooks/arch.py"
DRAFT="$PWD/.factory/policy"            # the draft policy (the working copy, not the one in each old commit)
N=20
for sha in $(git log --first-parent -n "$N" --format=%H origin/main); do
  git rev-parse -q --verify "$sha^1" >/dev/null || continue      # the root commit has no parent to diff against
  wt="$(mktemp -d)"; git worktree add -q --detach "$wt" "$sha"
  "$PY" "$ARCH" validate --checkpoint code_review --policy-dir "$DRAFT" --workspace "$wt" --base "$sha^1" \
    --format json --no-evidence --no-history > "$wt.json"
  python3 - "$sha" "$wt.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[2]))
for f in r["findings"]:
    if f["outcome"] in ("BLOCK", "WARN") and f["status"] != "needs_review":
        print(sys.argv[1][:9], f["outcome"], f["rule_id"], f"{f['file']}:{f['line']}", f["message"][:90], sep="\t")
PY
  git worktree remove --force "$wt"; rm -f "$wt.json"
done
```

Use `N=20` at least; more for a rule that fires rarely. Then classify every reported line:

- **True positive**: the merged change did break the constraint. Keep the rule; note the finding for the summary.
- **False positive**: the change was fine. Narrow the rule (`exclude`, `file_globs`, `allow_files`, a tighter regex), add the case as a passing self-test, and rerun.

Report per rule: findings, false positives, and the share of the N changes it would have blocked. A deterministic rule goes forward as `block` only with zero false positives in the sample. Library rules go through the same check; a true violation already in the code is an exception proposal (step 4), not a reason to lower the rule. A rule that still misfires stays `warn` or becomes semantic. A rule with no findings at all is unproven, not safe: say so.

## 7. Hand over for approval

Commit the policy on a branch and open a pull request; do not merge it. In the description give:

- The profile in one paragraph: services, layers, who owns which datastore, and anything you could not classify.
- A table of rules: ID, title, source of the constraint (document and section, or "observed in the code"), mode, enforcement per checkpoint.
- The dry-run numbers from step 6 per rule, with the false positives you fixed.
- Existing violations, each with a proposed exception and the approver role `policy.yaml` requires for its severity.
- Constraints you found but could not express, and questions only the team can answer.
- What you recommend to turn to `block`, and what should stay `warn` for now.

The approver decides enforcement levels, signs exceptions and merges.

## Worked example: Rust workspace

A Cargo workspace with `crates/orders-domain`, `crates/orders-store`, `crates/orders-api`, `crates/billing-domain`, `crates/billing-worker` and `crates/common`. The architecture document says the domain crates do no I/O and services share nothing but `common`.

`profile.yaml`:

```yaml
kind: Profile
schema_version: 1
id: default
language: rust
description: Cargo workspace. Two services (orders, billing), each a domain crate plus adapters; `common` is shared.
source_extensions: [".rs", ".toml"]
comment_prefixes: ["//", "/*", "*"]
project_manifests: ["crates/*/Cargo.toml"]
global_exclude: [".factory/**", "**/target/**"]
projects:
  - { name: orders-domain,  path: crates/orders-domain,  type: library, service: orders,  layer: domain }
  - { name: orders-store,   path: crates/orders-store,   type: library, service: orders,  layer: infrastructure }
  - { name: orders-api,     path: crates/orders-api,     type: api,     service: orders,  layer: presentation }
  - { name: billing-domain, path: crates/billing-domain, type: library, service: billing, layer: domain }
  - { name: billing-worker, path: crates/billing-worker, type: worker,  service: billing, layer: presentation }
  - { name: common,         path: crates/common,         type: library, layer: shared }
services:
  - { id: orders,  owns_datastores: [orders_db],  traits: [owns_database, exposes_http_api] }
  - { id: billing, owns_datastores: [billing_db], traits: [owns_database, consumes_events] }
shared_datastore_names: []
layer_dependencies:
  domain: ["shared"]
  infrastructure: ["same_service:domain", "shared"]
  presentation: ["same_service:domain", "same_service:infrastructure", "shared"]
  shared: ["shared"]
forbidden_packages_by_layer:
  domain: [sqlx, axum, reqwest, tokio-postgres]
# Unit tests sit in the source files, so only crates with a tests/ folder are mapped.
test_mapping:
  - { source: crates/orders-api/src, tests: ["crates/orders-api/tests/**"] }
```

Added to `validators/registry.yaml`. Cargo names a workspace dependency by path or by name, so both forms are declared; a `path` that points into the crate itself (`[lib] path = "src/lib.rs"`) resolves to the same project and is ignored:

```yaml
  - id: VAL-CRATE-LAYERS
    name: Crate layer dependencies
    type: deterministic
    implementation: project_validators:layer_dependencies
    description: Workspace crates depend only on the layers profile.layer_dependencies allows; every crate is classified.
    checkpoints: [pre_commit, code_review, ci]
    params: &cargo
      manifest_globs: ["crates/*/Cargo.toml"]
      reference_patterns:
        - 'path\s*=\s*"(?P<ref>[^"]+)"'                                                  # x = { path = "../x" }
        - { regex: '(?m)^(?P<ref>[\w-]+)\s*=\s*\{[^}\n]*workspace\s*=\s*true', kind: name }   # x = { workspace = true }
        - { regex: '(?m)^(?P<ref>[\w-]+)\.workspace\s*=\s*true', kind: name }                 # x.workspace = true
      package_patterns:
        - '(?m)^(?P<name>[\w-]+)(?:\.workspace)?\s*=\s*(?:"|\{|true)'
    self_tests:
      - name: domain depending on its store fails
        files:
          crates/orders-domain/Cargo.toml: "[dependencies]\norders-store = { path = \"../orders-store\" }\n"
        expect: fail
      - name: api depending on its domain and common passes
        files:
          crates/orders-api/Cargo.toml: "[dependencies]\norders-domain = { workspace = true }\ncommon.workspace = true\nserde = \"1\"\n"
        expect: pass
      - name: unclassified crate fails
        files:
          crates/new-thing/Cargo.toml: "[package]\nname = \"new-thing\"\n"
        expect: fail

  - id: VAL-CRATE-SERVICE-ISOLATION
    name: Crates do not reach into another service
    type: deterministic
    implementation: project_validators:service_isolation
    description: A crate of one service must not depend on a crate of another service.
    checkpoints: [pre_commit, code_review, ci]
    params: *cargo
    self_tests:
      - name: orders api depending on billing domain fails
        files:
          crates/orders-api/Cargo.toml: "[dependencies]\nbilling-domain = { path = \"../billing-domain\" }\n"
        expect: fail
      - name: orders api depending on orders domain passes
        files:
          crates/orders-api/Cargo.toml: "[dependencies]\norders-domain = { path = \"../orders-domain\" }\n"
        expect: pass

  - id: VAL-DOMAIN-CRATES
    name: Domain crates stay free of I/O frameworks
    type: deterministic
    implementation: project_validators:forbidden_packages
    description: Rejects the crates in profile.forbidden_packages_by_layer (database, HTTP) in domain crates.
    checkpoints: [pre_commit, code_review, ci]
    params: *cargo
    self_tests:
      - name: sqlx in a domain crate fails
        files:
          crates/orders-domain/Cargo.toml: "[dependencies]\nsqlx = { version = \"0.8\" }\n"
        expect: fail
      - name: serde in a domain crate passes
        files:
          crates/orders-domain/Cargo.toml: "[dependencies]\nserde = \"1\"\n"
        expect: pass
```

Added to `rules/architecture.yaml` (it starts at `block` here only because the dry-run found no false positive; otherwise `warn`):

```yaml
  - id: ARCH-010
    title: Crates follow the layer order and stay inside their service
    category: architecture
    severity: high
    status: active
    version: 1.0.0
    owner: architecture
    description: >
      A crate depends only on crates of the layers its own layer may use, never on a crate of another
      service, and a domain crate pulls in no database or HTTP framework.
    rationale: The domain crates are reused by the API and the workers; an I/O dependency there reaches all of them.
    applicability:
      include: ["crates/*/Cargo.toml"]
    checkpoints:
      pre_commit:  { enabled: true, enforcement: block, scope: changed }
      code_review: { enabled: true, enforcement: block, scope: changed }
      testing:     { enabled: false }
      ci:          { enabled: true, enforcement: block, scope: all }
    validation:
      mode: deterministic
      validators: [VAL-CRATE-LAYERS, VAL-CRATE-SERVICE-ISOLATION, VAL-DOMAIN-CRATES]
    patterns: []
    required_evidence:
      - { type: validator_output, checkpoints: [pre_commit, code_review, ci], on_missing: block }
    remediation:
      summary: Depend inward only; put the trait in the domain crate and its implementation in the adapter crate.
      steps:
        - Move the I/O code to the service's infrastructure crate behind a trait the domain crate defines.
        - Classify a new crate in .factory/policy/profile.yaml (type, service, layer).
    human_review_required: false
    tags: [layering]
```

The starter's `DATA-002` now has owners to check: add the forms this codebase uses to its `connection_patterns`, for example `'DATABASE_URL\w*\s*=\s*"[^"]*/(?P<name>\w+)"'`.

## Worked example: Java, Maven multi-module

A root `pom.xml` aggregates `orders-domain`, `orders-app`, `orders-web`, `billing-domain`, `billing-app` and `shared-kernel`. Dependencies between modules are declared by `artifactId`, so references are matched by name, and any other `artifactId` is a third-party library.

`profile.yaml`:

```yaml
kind: Profile
schema_version: 1
id: default
language: java
description: Maven multi-module build. One module per service and layer; shared-kernel is used by all.
source_extensions: [".java", ".xml"]
comment_prefixes: ["//", "/*", "*"]
# The root pom.xml only aggregates the modules, so it is not listed.
project_manifests: ["*/pom.xml"]
global_exclude: [".factory/**", "**/target/**"]
projects:
  - { name: orders-domain,  path: orders-domain,  type: library, service: orders,  layer: domain }
  - { name: orders-app,     path: orders-app,     type: library, service: orders,  layer: application }
  - { name: orders-web,     path: orders-web,     type: api,     service: orders,  layer: presentation }
  - { name: billing-domain, path: billing-domain, type: library, service: billing, layer: domain }
  - { name: billing-app,    path: billing-app,    type: worker,  service: billing, layer: application }
  - { name: shared-kernel,  path: shared-kernel,  type: library, layer: shared }
services:
  - { id: orders,  owns_datastores: [orders],  traits: [owns_database, exposes_http_api] }
  - { id: billing, owns_datastores: [billing], traits: [owns_database, consumes_events] }
shared_datastore_names: []
layer_dependencies:
  domain: ["shared"]
  application: ["same_service:domain", "shared"]
  presentation: ["same_service:application", "same_service:domain", "shared"]
  shared: ["shared"]
forbidden_packages_by_layer:
  domain: [spring-, hibernate-, jakarta.persistence-api]
test_mapping:
  - { source: orders-domain/src/main,  tests: ["orders-domain/src/test/**"] }
  - { source: orders-app/src/main,     tests: ["orders-app/src/test/**"] }
  - { source: orders-web/src/main,     tests: ["orders-web/src/test/**"] }
  - { source: billing-domain/src/main, tests: ["billing-domain/src/test/**"] }
  - { source: billing-app/src/main,    tests: ["billing-app/src/test/**"] }
```

Added to `validators/registry.yaml`. The last validator checks imports, which the module graph cannot see (a domain class importing Spring through a transitive dependency):

```yaml
  - id: VAL-MODULE-LAYERS
    name: Maven module layer dependencies
    type: deterministic
    implementation: project_validators:layer_dependencies
    description: A module depends only on modules of the layers profile.layer_dependencies allows; every module is classified.
    checkpoints: [pre_commit, code_review, ci]
    params: &maven
      manifest_globs: ["*/pom.xml"]
      # A dependency is matched to a profile project by artifactId; any other artifactId is a third-party library.
      reference_patterns:
        - { regex: '<dependency>.*?<artifactId>(?P<ref>[^<]+)</artifactId>', flags: [s], kind: name }
      package_patterns:
        - '(?s)<dependency>.*?<artifactId>(?P<name>[^<]+)</artifactId>'
    self_tests:
      - name: domain depending on the web module fails
        files:
          orders-domain/pom.xml: "<project><dependencies><dependency><groupId>com.acme</groupId><artifactId>orders-web</artifactId></dependency></dependencies></project>"
        expect: fail
      - name: web depending on app and shared kernel passes
        files:
          orders-web/pom.xml: "<project><dependencies><dependency><artifactId>orders-app</artifactId></dependency><dependency><artifactId>shared-kernel</artifactId></dependency><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>"
        expect: pass

  - id: VAL-MODULE-SERVICE-ISOLATION
    name: Modules do not reach into another service
    type: deterministic
    implementation: project_validators:service_isolation
    description: A module of one service must not depend on a module of another service.
    checkpoints: [pre_commit, code_review, ci]
    params: *maven
    self_tests:
      - name: orders app depending on billing domain fails
        files:
          orders-app/pom.xml: "<project><dependencies><dependency><artifactId>billing-domain</artifactId></dependency></dependencies></project>"
        expect: fail
      - name: orders app depending on orders domain passes
        files:
          orders-app/pom.xml: "<project><dependencies><dependency><artifactId>orders-domain</artifactId></dependency></dependencies></project>"
        expect: pass

  - id: VAL-DOMAIN-LIBRARIES
    name: Domain modules stay free of frameworks
    type: deterministic
    implementation: project_validators:forbidden_packages
    description: Rejects the libraries in profile.forbidden_packages_by_layer (Spring, Hibernate, JPA) in domain modules.
    checkpoints: [pre_commit, code_review, ci]
    params: *maven
    self_tests:
      - name: spring in a domain module fails
        files:
          orders-domain/pom.xml: "<project><dependencies><dependency><artifactId>spring-context</artifactId></dependency></dependencies></project>"
        expect: fail
      - name: a plain library in a domain module passes
        files:
          orders-domain/pom.xml: "<project><dependencies><dependency><artifactId>slf4j-api</artifactId></dependency></dependencies></project>"
        expect: pass

  - id: VAL-DOMAIN-IMPORTS
    name: Domain code imports no framework or outer layer
    type: deterministic
    implementation: text_validators:forbidden_pattern
    description: Domain sources must not import Spring, JPA or the web and persistence packages.
    checkpoints: [pre_commit, code_review, ci]
    params:
      file_globs: ["*-domain/src/main/java/**/*.java"]
      patterns:
        - regex: '^import\s+(?:org\.springframework|jakarta\.persistence|com\.acme\.\w+\.(?:web|persistence))\.'
          flags: [m]
          message: Domain code imports a framework or an outer layer. Define an interface in the domain and implement it outside.
    self_tests:
      - name: spring import in the domain fails
        files:
          orders-domain/src/main/java/com/acme/orders/domain/Order.java: "package com.acme.orders.domain;\nimport org.springframework.stereotype.Component;\n"
        expect: fail
      - name: plain domain class passes
        files:
          orders-domain/src/main/java/com/acme/orders/domain/Order.java: "package com.acme.orders.domain;\nimport java.util.List;\n"
        expect: pass
```

Rules: `ARCH-010` is the Rust example's rule with `include: ["*/pom.xml"]` and validators `[VAL-MODULE-LAYERS, VAL-MODULE-SERVICE-ISOLATION, VAL-DOMAIN-LIBRARIES]`. The import check is its own rule because it looks at different files:

```yaml
  - id: ARCH-011
    title: Domain code is free of frameworks and outer layers
    category: architecture
    severity: high
    status: active
    version: 1.0.0
    owner: architecture
    description: Classes in a *-domain module import neither Spring, JPA nor the web and persistence packages.
    rationale: The domain model must be testable without a container and reusable by every adapter.
    applicability:
      include: ["*-domain/src/main/java/**/*.java"]
    checkpoints:
      pre_commit:  { enabled: true, enforcement: block, scope: changed }
      code_review: { enabled: true, enforcement: block, scope: changed }
      testing:     { enabled: false }
      ci:          { enabled: true, enforcement: block, scope: all }
    validation:
      mode: deterministic
      validators: [VAL-DOMAIN-IMPORTS]
    patterns: []
    required_evidence:
      - { type: validator_output, checkpoints: [pre_commit, code_review, ci], on_missing: block }
    remediation:
      summary: Define an interface in the domain module and implement it in the application or web module.
      steps:
        - Remove the framework import; move the annotated class to the module that owns that concern.
    human_review_required: false
    tags: [layering]
```

Gradle is the same shape with other regexes: `manifest_globs: ["*/build.gradle*"]` and `reference_patterns: [{ regex: 'project\(["'']:(?P<ref>[\w-]+)["'']\)', kind: name }]`.

## Checklist

- [ ] `selfcheck` passes, with the workspace checks (no `--skip-workspace`).
- [ ] Every project in the build is in the profile; `project_manifests` is set so a new one cannot be missed.
- [ ] Every rule traces to a document or to a dependency direction that already holds.
- [ ] Every deterministic validator has a failing and a passing self-test written in this codebase's language.
- [ ] Dry-run on at least 20 merged changes, false positives fixed, numbers in the pull request.
- [ ] New rules are `warn` unless the approver said `block`; no exception carries an approval you invented.
- [ ] Nothing in the policy is Python, and nothing in `$FACTORY_HOME/architecture-policy` was edited.
