---
name: setup-teststack
description: "Set up the factory's test stack for a codebase in any language: a Docker Compose deployment of the whole application that `factory teststack` builds, starts and seeds from scenario files. Use when a repository has no `.factory/stack/` yet, when `factory teststack up` fails because the `stack` or `teststack` config sections are missing, or when asked to make an app runnable for end-to-end tests, agents or parallel stack slots. Covers repositories that already have a compose file and repositories that have none."
---

# Set up the test stack

The goal is a stack that `factory teststack up` builds and starts from a clean checkout, and that `factory teststack load <scenario>` puts into a known state within seconds. You produce four things in the app repository:

| Path | Content |
| --- | --- |
| `.factory/stack/docker-compose.yaml` | Every service of the application and every datastore it needs |
| `.factory/stack/scenarios/_base/` and `default/` | Seed data as scenario files |
| `.factory/config.json`, sections `stack` and `teststack` | Ports, URLs, build commands, datastores, readiness |
| A switch in the application | Turns the application's own seeding off |

Read `docs/test-stack.md` in the factory install for every config key and the scenario format. `examples/eshop/` is a complete setup to compare with. Work through the steps in order; each ends with a check.

The engine needs only Node and Docker. Do not add a script, a client library or an SDK to the repository for the stack itself.

## 1. Survey the codebase

Find and write down before you change anything:

- **Deployable services**: every process the running product consists of (web frontends, APIs, workers, gateways). Look for `Dockerfile*`, `docker-compose*.y*ml`, `compose*.y*ml`, Helm charts and Kubernetes manifests, `Procfile`, CI deploy jobs, and entry points (`main.go`, `src/main.rs`, `*Application.java`, `manage.py`, `Program.cs`, `package.json` scripts).
- **Datastores**: for each service, which databases, caches and brokers it connects to, and through which environment variables. Search the config files and the code for connection strings.
- **Migrations**: the tool (Flyway, Liquibase, Alembic, Django, Rails, Prisma, sqlx, golang-migrate, EF Core, ...), when it runs (at service startup, or as a separate command) and the name of its history table.
- **Seeders**: code or scripts that insert data at startup or on demand (`seed`, `fixtures`, `bootstrap`, `DataInitializer`, `loaddata`, `db:seed`, `CommandLineRunner`).
- **Entry URLs**: where a browser or a client starts, and any URL that services and the browser must agree on (an OAuth issuer, a callback URL).
- **Health endpoints** per service.

## 2. The compose file

**When an orchestrator composes the application (.NET: an Aspire AppHost), publish the stack from it; never write the compose file by hand.** A hand-written copy drifts from the code, and no parser of the orchestrator's source can see everything it does (conditional wiring, extension methods, callbacks, image tags). For .NET:

1. Add the AppHost's test-stack hook (`packs/dotnet/stack/teststack-hook.md`): `Aspire.Hosting.Docker`, a Docker Compose environment when `TestStack=true`, and HTTP endpoints in that case. It changes application code, so it is a repository decision: show the person the diff and say why.
2. Set `stack.publish` to `node {packs}/dotnet/stack/aspire-publish.mjs --out {out}` (`factory init` drafts it when it finds the AppHost), and give each built service `project` and `image: { env, name }`. The published file already uses `${<NAME>_IMAGE}`.
3. Run `factory teststack publish`. Read the generated file, then declare in `.factory/app.json` → `stack.publishOverrides` only what the test stack must do differently, each with its reason:
   - `parameters`: container ports the AppHost leaves to the deployment (`*_PORT`);
   - `ports`: the slot host port of each service the browser, the scenario loader or a test reaches;
   - `services[]`: `env` to replace browser-facing URLs (an OIDC issuer, callback URLs), `addEnv` for test-only switches (seeding off), and `set` for `restart` and `extra_hosts`.

   Publish again until it succeeds. An override that no longer applies, or a parameter left without a value, fails the publish. Never declare an override to hide wiring the AppHost has; change the AppHost instead.
4. Steps 3 to 5 below still apply. Their compose-file edits become `publishOverrides` entries.

Write `.factory/stack/docker-compose.yaml`. The stack must contain the whole application, not mocks.

**When the repository has a compose file.** Do not edit it if developers use it. Copy it and adapt the copy, or generate the stack file from it when the repository already generates compose files (then record the generator as `stack.publish`). In the copy:

- Remove bind mounts of source folders, file watchers, debug ports and dev servers. Services must run the built image, as in production.
- Remove named volumes for data unless a datastore requires one. `down -v` must leave nothing behind.
- Keep `build:` sections, with `context` paths corrected for the new location (paths are relative to the compose file: the repository root is `../..`).
- Remove `container_name`. Fixed names break parallel slots.
- Remove `profiles` that would keep a needed service from starting.

**When the repository has none.** Write one service per deployable, plus the datastores:

- Reuse a service's Dockerfile when it exists. When the language pack has an image builder, prefer it to writing Dockerfiles: for .NET, `packs/dotnet/stack/publish-container.mjs` builds every service with `dotnet publish -t:PublishContainer` (set `stack.build.all` to `node {packs}/dotnet/stack/publish-container.mjs --all`, `stack.build.service` to `node {packs}/dotnet/stack/publish-container.mjs {service}`, and give each service `project` and `image: { env, name }`; the compose file then takes `image: "${<NAME>_IMAGE}"`). Otherwise write a multi-stage Dockerfile next to the service that follows the repository's documented build (the build command in its README or CI), and builds from lock files first so layers cache.
- Use the same datastore images and major versions as production. Take them from deployment manifests or CI service containers, not from memory.
- Give datastores fixed, test-only passwords through variables (`"${DB_PASSWORD}"`); you list the values in `stack.env` later.
- Start order: use `depends_on` with `condition: service_healthy` only where a service crashes without its dependency. The loader waits for readiness itself.

**In both cases:**

- Publish every host port through a variable with a default: `"${WEB_HOST_PORT:-18080}:8080"`. Never hard-code a host port. Slots shift ports through these variables.
- Any URL that a browser receives from a service (redirects, issuer, callback, public base URL) must also come from those variables, for example `PUBLIC_URL: "http://localhost:${WEB_HOST_PORT:-18080}"`. Service-to-service URLs use compose service names and container ports and never change.
- Pick slot 0 host ports in one free block, away from the defaults developers use, for example 18000-18999: `18080`, `18081`, ... for services, and `18000 + the datastore's usual port modulo 1000` for datastores (`18432` for PostgreSQL, `18379` for Redis, `18306` for MySQL, `18017` for MongoDB, `18672` for RabbitMQ). With the default `slotStride` of 1000, keep every base inside one block of 1000: slot n then uses the block 1000 × n higher and no two slots collide.
- Datastore ports need not be published at all. The loader works inside the containers. Publish them only if tests or people connect directly.

Check: `docker compose -f .factory/stack/docker-compose.yaml config -q` passes with the variables unset except the passwords.

## 3. Turn the application's seeders off

Scenario files own the data. A seeder that runs at startup would refill tables after every reset and make scenarios unpredictable.

- Add one switch that skips seeding and keeps migrations: an environment variable such as `SEED_DISABLED=true`, read where the seeder is invoked. Keep the default behavior unchanged, so development and production are not affected.
- Set the switch in the stack's compose file for every service that seeds.
- If seeding and migrating are one step, split them. Migrations must still run, because the application owns the schema.
- If seeding is a separate command that nothing runs at startup, do nothing.

This is the only change to application code the test stack needs. Keep it minimal and say so in your summary.

## 4. The `stack` section

Ports, URLs, `env` and each service's `project`/`image`/`inputs` go in `.factory/app.json` (the application's topology, which the agents keep in step when a story adds a service); build commands, the resolver and `composeFile` stay in `.factory/config.json`. `publishOverrides` and `publishAppHost` are topology too (app.json); the `publish` command stays in config.json. The same split holds for `teststack`: `services`, `stores`, `infrastructureServices` and `restartAfterLoad` go in app.json, and the rest in config.json.

Add to `.factory/config.json` (create the file with `{}` if it does not exist; keep the other sections):

```json
{
  "stack": {
    "ports": {
      "web": { "base": 18080, "env": "WEB_HOST_PORT" },
      "api": { "base": 18081, "env": "API_HOST_PORT" }
    },
    "urls": { "web": "http://localhost:{port:web}", "api": "http://localhost:{port:api}" },
    "baseUrl": "web",
    "env": { "DB_PASSWORD": "teststack-db" },
    "services": {
      "web": { "inputs": ["web/**", "packages/ui/**"] },
      "api": { "inputs": ["services/api/**", "libs/**", "go.mod", "go.sum"] }
    },
    "rebuildAll": ["docker/", ".dockerignore"]
  }
}
```

- `ports`: one entry per variable you used in the compose file. The `base` must equal the default in the compose file.
- `urls`: what a person or a test opens. `baseUrl` is where browser tests start.
- `env`: the test-only passwords the compose file expects.
- `services`: every compose service with a `build:` section, with the files its image is built from. Include shared libraries, lock files and the Dockerfile. Too wide only costs rebuild time; too narrow leaves stale images. If the repository's language pack has a resolver (`packs/<id>/stack/`), set `stack.resolver` and give each service what the resolver needs instead of listing shared code by hand.
- `rebuildAll`: files that affect every image.
- Leave `build` out when `docker compose build` builds the images. Set `build.all` and `build.service` only when another tool builds them (Jib, Buildpacks, Bazel, ko, Nix, a framework's publish command); then name each image variable with `services.<name>.image.env`.
- `.factory/state/` must be git-ignored.
- Set `implement.ui.teststackCmd` to `["node", ".factory/bin/factory.mjs", "teststack"]` (`factory init` drafts it once the compose file exists). The implement harness runs it from each UI subtask's worktree on the pair's leased slot (`rebuild-changed`, `up`, `load`, `down`), so the UI verifier tests the subtask's code. Without it the verifier tests whatever already runs on the slot; `factory doctor` flags that.

Check: `factory stack info --slot 1` prints the ports shifted by 1000 and the URLs. `factory teststack services-for <a source file>` names the right service.

## 5. The `teststack` section

```json
{
  "teststack": {
    "stores": {
      "db": {
        "type": "postgres",
        "service": "postgres",
        "passwordEnv": "DB_PASSWORD",
        "databases": ["appdb"],
        "preserveTables": ["schema_migrations"],
        "migrationsReady": { "table": "schema_migrations", "column": "version" }
      },
      "cache": { "type": "redis", "service": "redis" }
    },
    "infrastructureServices": ["postgres", "redis"],
    "services": [
      { "name": "api", "url": "http://localhost:{port:api}/healthz", "databases": ["appdb"] },
      { "name": "web", "url": "http://localhost:{port:web}/" }
    ]
  }
}
```

- One store per datastore. The key (`db`, `cache`) is the name scenarios use. Types: `postgres`, `mysql`, `mongodb`, `redis`, `rabbitmq`. For another datastore write an adapter module (interface in `scripts/teststack/lib/stores/index.mjs`) and name its path as the type.
- `service` is the datastore's compose service. `username` must be a user allowed to truncate tables.
- `preserveTables`: the migration tool's history table, and any table that migrations fill and the application never changes. Everything else is truncated on every reset.

  | Tool | History table |
  | --- | --- |
  | Flyway | `flyway_schema_history` |
  | Liquibase | `databasechangelog`, `databasechangeloglock` |
  | Alembic | `alembic_version` |
  | Django | `django_migrations`, `django_content_type`, `auth_permission` |
  | Rails, golang-migrate | `schema_migrations`, `ar_internal_metadata` |
  | Prisma | `_prisma_migrations` |
  | sqlx | `_sqlx_migrations` |
  | Diesel | `__diesel_schema_migrations` |
  | EF Core | `__EFMigrationsHistory` |
  | Knex | `knex_migrations`, `knex_migrations_lock` |
  | TypeORM | `migrations` |

- `migrationsReady`: a table (and column) of that tool, or a query, that has rows once migrations ran.
- `services`: every application service. `url` must answer below 500 only when the service is up: prefer a health endpoint; any cheap GET works. List under `databases` the databases a service migrates, and under `queues` the queues it consumes.
- `restartAfterLoad`: add a service only when it keeps state in memory that a reset invalidates (an in-process cache of reference data, pre-allocated id blocks). Start without it; add it when a test shows stale data after `load`.
- If migrations run as a separate command and not at service startup, add a one-shot compose service that runs them and that the application services depend on (`condition: service_completed_successfully`). Do not list a one-shot service in `infrastructureServices` or `services`: its container exits.

## 6. Scenarios from the existing seed data

Write `.factory/stack/scenarios/_base/scenario.yaml` and `.factory/stack/scenarios/default/scenario.yaml`. Start from `templates/stack/scenarios/_base/scenario.yaml` in the factory install.

- `_base`: lookup data every test needs and that migrations do not insert (types, statuses, countries, a default tenant). It is loaded before every scenario and alone by `reset`.
- `default`: what the application's seeders produced, so the product looks as developers know it: the demo catalog, a few users with known passwords.

Get the data from the real seeders, never invent it:

1. Preferred: start the stack once with seeding still on, let the application seed, then export. For PostgreSQL: `factory teststack compose exec -T postgres pg_dump -U <user> -d <db> --data-only --column-inserts --exclude-table=<history table>` and save the output as `default/<db>.sql` (step `- sql: <db>.sql`). For small tables write `table` and `rows` instead; they are easier to review and to extend.
2. Otherwise translate the seeder's source (fixture files, SQL scripts, code) into rows.

Rules that keep scenarios loadable:

- Use explicit ids. The loader moves sequences past them afterwards.
- Order steps so that referenced rows come first. All steps of one database run in one transaction.
- Store passwords the way the application stores them (hashed). Generate a hash with the application's own hasher and document the clear text in a comment. Give users fixed ids so that other stores can reference them.
- Remove volatile columns that have defaults (`created_at`).
- Put a scenario's larger data in files next to `scenario.yaml` (`sql:`, `rowsFile:`).
- Later scenarios `extends: default` and add only what a test needs.

Then turn the seeder switch on in the compose file (step 3) if you had it off for the export.

Check: `factory teststack validate` lists every scenario with `ok: true`.

When the language pack has a drift command, run `factory teststack drift`. It must answer `"compared": true` and `"check": "clean"`. `factory init` makes it a check of every implementation, and the CI gate runs it, so a service a story adds to the application cannot miss the stack. For .NET it is `publish --check`: it publishes the AppHost again and fails on any difference.

## 7. Verify

Run each command and read its JSON line. Do not continue past a failure.

```bash
factory teststack validate            # scenarios parse; no stack needed
factory teststack up                  # builds, starts, waits, loads "default"
factory teststack status              # every check ok
factory teststack load default        # a second load works on a used stack
factory teststack reset               # base data only
factory teststack load default --hard # only if a store is postgres
factory teststack --slot 1 up && factory teststack --slot 1 down   # the stack runs twice side by side
factory teststack down
```

Then prove the data is right, not only that commands pass:

- Open the base URL and sign in as a seeded user.
- After `load default`, create something through the application (an order, a record), then `load default` again: the created data is gone, and creating it again does not fail with a duplicate key.
- `factory teststack up` a second time rebuilds nothing.

Common failures:

| Symptom | Cause and fix |
| --- | --- |
| `up` times out on `http:<service>` | Read `factory teststack logs <service>`. Usually a missing environment variable or a wrong service-to-service URL in the compose file. |
| `migrations:<db>` never ready | Wrong history table, or migrations do not run at startup (add the one-shot migration service). |
| `load` exits 3 naming a step | The scenario does not match the schema: a column name with the wrong case, a missing referenced row, a NOT NULL column without a value. |
| Data reappears after `reset` | A seeder still runs. Check the switch in every service. |
| Duplicate key after `load` | A standalone sequence or an in-memory id cache: configure `sequences` or `restartAfterLoad`. |
| Slot 1 collides with slot 0 | A host port or `container_name` is hard-coded in the compose file. |
| Sign-in redirects to the wrong port on slot 1 | A browser-facing URL in the compose file does not use the port variable. |
| `queue:<name>` not ready | The service connects to the broker before it is up and never retries. `wait` restarts it once after `healAfterSec`; a retry in the service is the real fix. |

## 8. Hand over

- If the repository has Playwright tests, copy `templates/e2e/teststack/ports.ts`, `templates/e2e/teststack/scenario.ts` and `templates/e2e/playwright.teststack.config.ts` from the factory install (to `e2e/teststack/` and the repository root), and write specs that build URLs with `port()`, `url()` and `BASE_URL`.
- Commit `.factory/stack/`, the config sections, the seeder switch and any new Dockerfile. Never commit `.factory/state/`.
- In your summary, list: the services and datastores in the stack, the seeder switch you added, the seeded users and their test passwords, the output of the final `status`, and anything you could not verify.
