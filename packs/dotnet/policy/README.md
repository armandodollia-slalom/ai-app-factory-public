# .NET policy library

Rules, validators and patterns for .NET services (ASP.NET Core minimal APIs, EF Core, Aspire service
defaults, integration events), for the architecture policy engine. They were proven on a real
services-based .NET codebase (the eShop reference pipeline: 38 rules, 23 blocking) and rewritten against
the profile vocabulary instead of its paths. Nothing here names a service of any application.

Add them to a repository's policy, then tune:

```bash
factory policy-library list dotnet           # rules, severities, modes, enforcement per checkpoint
factory policy-library add dotnet            # all of them (or --rules ID,ID)
python3 "$FACTORY_HOME/architecture-policy/hooks/arch.py" selfcheck
```

`add` never overwrites a rule the policy already has, and replaces the starter's `VAL-SECRET-SCAN` and
`VAL-DB-OWNERSHIP` with their .NET forms only while the repository still has the starter's version.

## Profile vocabulary the rules select on

| Key | Values the rules use |
| --- | --- |
| `projects[].type` | `api` (an HTTP/gRPC service), `web` (a UI host), `worker` (a background host), `domain`, `infrastructure` (a service's inner layers), `library` (shared code), `host` (an orchestrator such as an Aspire AppHost), `client` (mobile/desktop), `test` |
| `projects[].layer` | `domain`, `infrastructure`, `presentation`, `shared` (plus any the repository adds to `layer_dependencies`) |
| `services[].traits` | `owns_database`, `publishes_events` (DATA-003 needs both), `consumes_events`, `exposes_http_api` |
| `forbidden_packages_by_layer.domain` | persistence, transport and hosting packages the domain must not use |

A service's own domain and infrastructure projects keep the service's `service` id; only cross-service
libraries have no service and `layer: shared`.

## What to tune (lines marked TUNE)

| Where | What |
| --- | --- |
| API-001, API-002, API-004, ERR-003 `include`; VAL-API-VERSIONED, VAL-API-WRITE-AUTH, VAL-PROBLEM-DETAILS `file_globs` | the files that map endpoints. `**/Apis/**/*.cs` is the default layout; find the real one with `grep -rl "\.Map\(Get\|Post\)" --include=*.cs` |
| ARCH-003 / VAL-SERVICE-DEFAULTS | the service-defaults call the hosts must make (`AddServiceDefaults()` for Aspire); remove the rule when the codebase has no shared defaults project |
| ARCH-006 `exclude` | projects that opt out of central package management (MAUI clients) |
| ARCH-007, DATA-003, RES-004, TEST-006 | the integration-event base type and outbox service names (`IntegrationEvent`, `*IntegrationEventService`); remove them when the codebase has no event bus |
| SEC-005 `include` | the folders that handle payment data, personal data, identity and authorization |
| TEST-004 `include` | the test roots |
| VAL-DB-OWNERSHIP `connection_patterns` | the forms the codebase names a datastore with |
| every pattern `exemplars` | one or two files of this codebase that do it well |

## Enforcement

The library keeps the levels the reference proved: deterministic rules block at `pre_commit`,
`code_review` and `ci`; semantic rules warn. Run the skill's dry run on merged history first; a rule with a
false positive there goes to `warn` until its globs or regex are fixed. A true violation already in the code
becomes an exception proposal for a person to approve (never fill in `approved_by` yourself).
