# Architecture Policy Pack

**Who reads this:** B writing a policy for a codebase, C reading a policy block. The Architecture Policy Pack checks a change against a repository's architecture rules without an LLM: secrets in source, a service connecting to another service's database, a domain module depending on infrastructure, and whatever else the repository declares. The [review stage](ai-pipeline/review.md) runs it before the LLM reviewer; a Git pre-commit hook and CI can run the same rules.

It has two parts that live in different places.

| | Engine | Policy (content) |
| --- | --- | --- |
| What | The code that evaluates rules | The rules of one codebase |
| Where | `architecture-policy/` in the factory install | `.factory/policy/` in the app repository |
| Holds | `hooks/` (the `architecture` package, `arch.py`, adapters), `validators/*.py`, `agents/` (review agent, MCP server), `architecture-rule.schema.json`, default evidence types, tests | `policy.yaml`, the profile, `rules/`, `patterns/`, `validators/registry.yaml`, `exceptions/exceptions.yaml`, optional `architecture-rules.md` and `evidence/evidence-types.yaml` |
| Knows about a stack or an app | Nothing | Everything |
| Changes | With the factory | With the app, in the app's pull requests |

The engine holds no rule, path, project name or build-system knowledge. A validator such as "layer dependencies" is a generic implementation; the policy's registry tells it which files are build manifests and how they reference each other, and the profile tells it which project is in which layer.

## Where the engine finds things

Three locations, resolved separately:

| Location | Meaning | Resolution, first match wins |
| --- | --- | --- |
| Engine | The factory install | The folder that holds the script you ran |
| Workspace | The repository under review | `--workspace`, then `ARCH_WORKSPACE`, then the Git top level of the current directory, then the current directory |
| Policy directory | The policy content | `--policy-dir`, then `ARCH_POLICY_DIR`, then `<workspace>/.factory/policy` |

`--policy-dir` and `--workspace` are accepted by `arch.py` (before or after the command) and by `arch_review.py`. A relative value is relative to the current directory. In Python: `architecture.get_pack(policy_dir, workspace)` and `ArchReviewAgent(policy_dir=..., workspace=...)`.

What the engine writes goes to the app repository, never to the install:

| Output | Path | In Git |
| --- | --- | --- |
| Evidence bundle of each run | `<policy dir>/evidence/runs/` (`policy.yaml` `evidence.output_dir`) | No (`evidence/.gitignore`) |
| Local history store (SQLite) | `<policy dir>/evidence/history/` (`history.path`, or `ARCH_HISTORY_DB`) | No |
| Team ledger, one JSON file per agent run and review | `<workspace>/.factory/metrics/arch-history/` (`history.ledger.path`, or `ARCH_HISTORY_LEDGER`) | Yes, committed with the work |

### No policy

A repository without `<policy dir>/policy.yaml` has no architecture policy. This is a result, not an error: every entry point prints `no architecture policy configured`, returns `{"status": "not_configured", "decision": "NOT_CONFIGURED", "can_proceed": true}` where JSON is expected, and exits 0. The review stage then skips the policy step with a note and still runs the LLM review.

## Running it

`<factory>` is the factory install root (`$FACTORY_HOME` inside pipeline agents). Run from the app repository, or pass `--workspace`.

```bash
python3 -m pip install -r <factory>/architecture-policy/requirements.txt   # pyyaml, jsonschema

ARCH=<factory>/architecture-policy/hooks/arch.py
python3 $ARCH selfcheck                                   # is the policy valid? (schema, references, validator self-tests, profile vs. code)
python3 $ARCH selfcheck --skip-workspace                  # the policy on its own, without the code (a draft, a template)
python3 $ARCH validate --checkpoint code_review           # changed files against the merge base (--base <ref>)
python3 $ARCH validate --checkpoint ci --format sarif     # whole repository
python3 $ARCH validate --checkpoint code_review --files src/a.rs src/b.rs --no-evidence --no-history
python3 $ARCH rules --files src/a.rs                      # which rules apply to a file
python3 $ARCH rule SEC-001                                # one rule; also: pattern, examples, explain <finding-id>
python3 $ARCH history --since-days 30                     # recorded failures; lessons --agent implementer
python3 $ARCH docs                                        # render <policy dir>/architecture-rules.md (docs --check in CI)

python3 <factory>/architecture-policy/agents/arch_review.py review '{"requester": {"agent": "implementer"}, "base": "origin/main"}'
python3 <factory>/architecture-policy/agents/arch_review.py mcp     # the same operations as MCP tools (arch_review, arch_advise, ...)
```

Exit codes: 0 `PASS`, `WARN` or no policy; 1 `BLOCK`; 2 error; 3 `WARN` with `--strict`.

Checkpoints: `pre_commit` (staged files, deterministic rules only), `code_review` (changed files, plus review requests for semantic rules), `testing` (test results and coverage as evidence), `ci` (whole repository). Each rule says where it runs and whether it blocks, warns or only reports.

Adapters in `architecture-policy/hooks/adapters/` wrap these calls: `pre-commit.sh` for a Git hook, `ci.sh` and `ci.ps1` for a CI job (selfcheck, SARIF, exit code). They find the engine beside themselves; set `ARCH_ENGINE_DIR` if you copy one.

Engine tests: `python3 -m unittest discover architecture-policy/tests`. They run the engine on the eShop example policy and on the starter template.

## What a policy contains

```text
.factory/policy/
  policy.yaml               manifest: categories, checkpoints, exception limits, history, where the other files are
  profile.yaml              what the codebase looks like (or profiles/<id>/profile.yaml with default_profile: <id>)
  rules/<category>.yaml     the rules, one file per category
  patterns/<name>.yaml      approved patterns with examples, handed to agents with a finding
  validators/registry.yaml  the engine's validators configured for this codebase, each with self-tests
  exceptions/exceptions.yaml  time-boxed, approved waivers; the only way to waive a finding
  evidence/.gitignore       ignores runs/ and history/
  architecture-rules.md     optional rendered rule book (`arch.py docs`)
```

Every file is validated against `architecture-policy/architecture-rule.schema.json`. Rule categories, rule ID prefixes, project types, layers and service traits are the policy's own vocabulary; the schema fixes only their shape.

The profile is where the stack lives:

| Key | Purpose |
| --- | --- |
| `projects` | Each buildable unit: `name`, `path`, `type`, and optionally `service` and `layer` |
| `services` | Each independently owned part: `id`, `owns_datastores`, `traits` |
| `layer_dependencies` | Which layers a layer may reference (`same_service:<layer>`, `shared`, `*`) |
| `forbidden_packages_by_layer` | Third-party packages a layer must not use |
| `shared_datastore_names` | Datastores no single service owns |
| `test_mapping` | Which test trees cover which source tree |
| `project_manifests` | Globs of build manifests; selfcheck fails on one outside every project |
| `comment_prefixes` | Line prefixes that mark a comment; none declared means text validators skip nothing |
| `global_exclude` | Paths no rule looks at |

Validator implementations the registry can configure:

| Implementation | Checks | Main params |
| --- | --- | --- |
| `text_validators:forbidden_pattern` | A regex must not occur | `patterns[{regex, message, flags}]`, `file_globs`, `allow_files`, `ignore_comments`, `max_per_file` |
| `text_validators:required_pattern` | A regex must occur in the file or its project | `require[{regex, message}]`, `trigger`, `file_globs`, `search_scope`, `project_globs` |
| `project_validators:layer_dependencies` | `layer_dependencies` over manifests; every manifest is classified | `manifest_globs`, `reference_patterns` (named group `ref`; `kind: path` or `name`) |
| `project_validators:service_isolation` | No project reference across services | same |
| `project_validators:forbidden_packages` | `forbidden_packages_by_layer` | `manifest_globs`, `package_patterns` (named group `name`), `name_separators` |
| `data_validators:database_ownership` | A service names only datastores it owns | `connection_patterns` (named group `name`) |
| `data_validators:migration_immutability` | Existing migrations are not edited or deleted | `migration_globs`, `allow_globs` |
| `change_validators:tests_accompany_changes` | `test_mapping`: source changes come with test changes | `ignore_globs` |
| `evidence_validators:test_results` | Supplied JUnit XML or TRX results are green | none |
| `evidence_validators:coverage_threshold` | Cobertura line coverage | `min_line_rate`, `exclude_project_types` |
| `semantic_validators:semantic_review` | A rubric judged by an independent reviewer (LLM or human) | none; the rule carries the rubric |

A policy cannot ship Python. A check the implementations above cannot express is a semantic rule, or a new generic implementation added to the engine.

## Starting a policy

- `templates/policy/` is a language-neutral starter: the manifest, a commented profile skeleton and six rules that work on any stack (no secrets in source, service and layer boundaries, generated files not hand-edited, compatible and tested public API changes, datastore ownership, tests with source changes). The profile-driven rules stay silent until the profile is filled. Copy it to `.factory/policy/`.
- The [`author-architecture-policy`](../skills/author-architecture-policy/SKILL.md) skill is how an agent fills the profile and drafts rules for a codebase, measures false positives on merged pull requests and hands the draft to a person.
- `examples/eshop/.factory/policy/` is a complete policy for a .NET services codebase (38 rules, 17 patterns, 28 validators).

A policy change is a normal pull request in the app repository. `arch.py selfcheck` must pass, and CI should run it (`hooks/adapters/ci.sh` does).

## Who classifies a project

A design decision: **a new project's class is derived from the project itself; nothing an agent writes can choose it.** Each class, and what it may do, is governance.

A story that adds a service or a test project must be able to finish. The policy blocks an unclassified project (ARCH-001), and the profile lives under `.factory/policy/`, which the factory guard denies to agents. An earlier version let agents declare a new project's type and layer in `.factory/app.json`. Reviewers showed that a declaration could switch blocking rules off for the agent's own code:
- a web project declared as a test;
- a nested folder declared with a more permissive class;
- a host layer declared to escape ARCH-002;
- another service's database claimed under a different casing.

Patching the validator case by case would not end that. So there is nothing left for an agent to assert:

- **Derived.** The governed profile has `classification`: `conventions`, one per class (type and layer), saying what a project of it looks like, and `service_names`, which maps the first segment of a project's name to its service. A convention can match on:
  - path roots;
  - the project SDK;
  - whether it is a test project (`IsTestProject`, MSTest.Sdk, or a test-framework package);
  - output type, name patterns, and MSBuild properties.

  The engine reads a project the profile does not list from its manifest (`classify.py`), and exactly one convention must fit. A convention can also require a content trait: `content: { maps_endpoints: true }` (the project's code maps HTTP endpoints, such as `MapGet`, `MapGrpcService` or `[ApiController]`) or `content: { maps_api_routes: false }` (no `/api` routes). Routes are read from the mapping calls and route attributes, through simple string constants (`const string Prefix = "/api"; app.MapPost(Prefix + "/x", …)` is an `/api` route). A project whose code contradicts its convention needs a person, and so does a project under `maps_api_routes: false` with a route the classifier cannot read (a variable, a method call).

  Decision: a class with `maps_endpoints: true` accepts a project that maps no endpoint **yet** (a scaffolding ticket creates the project first). It gets the class with the note "it maps no endpoint yet", in the CLASSIFY-001 item and the PR body. The class's rules (API-001 and so on) apply as soon as it maps one. Mapping endpoints in a class that must not is still a contradiction.
- **Facts as MSBuild builds them.** The facts are what MSBuild would build, or the project goes to a person:
  - Project manifests are found without regard to case (`Up.API.CSPROJ` is a project, and a PR that adds one is floored at High).
  - The manifest is parsed as XML, so a commented-out element is not a fact. Property names compare without case (`<outputtype>` is `OutputType`), and the last value set wins.
  - The SDK comes from `Sdk="…"`, `<Sdk Name="…"/>` or `<Import Sdk="…"/>`. More than one SDK needs a person.
  - A property the conventions read (`OutputType`, `IsTestProject`, `UseMaui`, or any `properties` a convention names) set under a `Condition` takes every value it can end with. The class is derived for each combination. When all of them give the same class, the project gets it, and the facts list the property as conditional. Otherwise it needs a person. For example, `<OutputType Condition="…Debug">Library</OutputType>` in a plain library is still a library; `Exe` under a condition is not.
  - The `Directory.Build.props`, `Directory.Build.targets` and `Directory.Packages.props` files above the project are read, and so are the files they import. An import of the next file up (`GetPathOfFileAbove`) is part of that chain. These need a person, because the parse cannot know what MSBuild evaluates:
    - a property the conventions read set the same value twice with different values;
    - a conditional test-framework reference;
    - an explicit `<Import>` of a file in the manifest itself;
    - a Directory.* file (or a file it imports) that sets a read property or adds a test reference;
    - a Directory.* file that imports a file under a `Condition` other than `Exists(…)`, or a path the classifier cannot resolve;
    - a manifest that is not well-formed XML;
    - a folder holding more than one manifest.
  - **The MSBuild cross-check.** The engine asks MSBuild itself (`dotnet msbuild -getProperty:`) for the SDK flags, `OutputType`, `UseMaui`, `IsTestProject` and the convention properties, in both Debug and Release. It compares them with the parse whether or not the manifest sets them. A disagreement in either configuration needs a person, so an import that makes only a Release build a web host is caught.
  - The facts record what was evaluated ("evaluated by MSBuild in Debug and Release: SDK, OutputType, …"). If the cross-check cannot run on a checkout (no .NET SDK, or the evaluation fails), a new .NET project needs a person. Selfcheck says so on its `msbuild_cross_check` line, and the factory's CI `policy` job installs the toolchain (`.github/actions/factory-toolchain`) so it runs there. `ARCH_MSBUILD_EVAL=0` turns the cross-check off deliberately: the facts then say "not evaluated by MSBuild", and the parse alone still refuses everything above.

  The cases are in `architecture-policy/tests/classify_cases.json`, run by the Python tests and end to end through `arch.py`.
- **For a person.** The project stays unclassified, and blocks with a finding that says a person must extend the profile, when:
  - no convention fits, or several do;
  - its facts are ambiguous, or MSBuild disagrees with them (above);
  - its code contradicts the convention's content trait;
  - the project is nested in another project, or contains one;
  - its name and a declared service disagree.

  The review stage escalates such a finding as an explained escalation instead of sending the agent around a fix loop.
- **Declared.** Agents declare only facts that cannot be derived, all of them new, in `.factory/app.json` → `policy.services`:
  - a new service's id;
  - the root folders of its projects;
  - the datastores it owns.

  ```json
  "policy": { "services": [{ "id": "reviews", "roots": ["src/Reviews.API"], "owns_datastores": ["reviewsdb"] }] }
  ```

  The whole set is validated together. Names are plain ASCII (letters, digits, and `-` in ids, or `.`, `_` and `-` in datastores), compared lower-cased, so no Unicode case folding, whitespace or invisible character can make two names differ in one place and match in another. Paths are normalised. These are refused:
  - an id or datastore that is not a plain ASCII name;
  - an id that exists under any casing, or is declared twice;
  - a root that holds no project manifest, is (or is inside) a symbolic link, is listed twice, or overlaps a profiled project or another declared root;
  - a datastore that is owned or shared under any casing, or claimed twice;
  - any other key, `projects` included.

  A refused declaration declares nothing. The rules are implemented twice: in JavaScript for the guard (`scripts/pipeline/lib/policy-topology.mjs`) and in Python for the engine (`topology.py`). They run in four places:
  - the guard, when the agent writes `app.json` with the edit tools; a shell command that writes `app.json` is refused, since its result cannot be checked;
  - the post-run check, which reverts a refused `app.json`;
  - the engine at every checkpoint, as a BLOCK (TOPOLOGY-001), so the review stage refuses it (loading the factory's settings ignores the `policy` section, so a bad declaration is reported, not a crash);
  - the factory's CI gate (`factory arch selfcheck`).

  The agreement is tested, not assumed. Both implementations run every row of one table, `architecture-policy/tests/topology_cases.json`: the reviewers' rows, Unicode names, whitespace, symbolic links and duplicate roots. They must return the same errors word for word (`scripts/factory/test/policy-library.test.mjs`). A case the table does not cover is not proven to agree.
- **Tested against reality.** `selfcheck` fails when:
  - a profiled project gets a different class from the conventions than from its entry (`classification_conventions`);
  - a folder compiled into projects from outside them (linked source, such as `<Compile Include="..\Shared\...">`, also when a `Directory.Build.*` file adds the items, wildcards included) is not profiled (`linked_sources`). A compile item whose path is computed from properties (`$(Shared)/X.cs`) needs a person, because only MSBuild can resolve it. `validate` blocks it at every checkpoint too (LINKED-001, for a person), so the review stage and CI agree;
  - a project manifest is classified neither by the profile nor by the conventions.

**Every derived class is visible.**
- **Engine:** emits a CLASSIFY-001 INFO item for each derived project a change touches, with the convention it matched and the facts it was derived from, and returns them as `derived_classes`.
- **Review stage:** puts them in the architecture reviewer's task.
- **Pipeline pull requests:** get a "New projects and their classes" section (`arch.py classes --base --format markdown`).
- **`factory arch classes`:** prints the class of every project, listed, derived or unclassified.
- **Review gate:** floors a pull request that adds a project manifest at High (`floor.newProjects`), so a person sees the classification as they would see a profile line.

The reviewer still checks that a new project's derived class matches what the project is. The factory makes the class follow from the project; it cannot judge whether the project was put in the right place.

## Rule libraries in the language packs

A pack may ship `packs/<id>/policy/` (rules, validators, patterns written against the profile vocabulary). `factory policy-library list [<pack>]` shows them; `factory policy-library add <pack> [--rules ID,...]` merges them into `.factory/policy` as text (existing rules and the repository's comments are kept; a missing category is added to `policy.yaml`; the starter's validators the library replaces are replaced only while unmodified). The `author-architecture-policy` skill then tunes and dry-runs them. The .NET library is described in `packs/dotnet/policy/README.md`.
