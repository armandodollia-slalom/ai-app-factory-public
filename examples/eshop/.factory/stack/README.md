# eShop test stack

The test stack of the eShop reference application (.NET, Aspire), as an example of a complete setup. The generic documentation is `docs/test-stack.md`; this page holds what is specific to eShop.

To use it, copy this folder to `.factory/stack/` of the eShop repository together with the `stack` and `teststack` sections of `../config.json`.

## How the stack is produced

| Piece | Source |
| --- | --- |
| Compose customizations (host port variables, HTTP only, seeder switch, identity URL) | C# in `src/eShop.AppHost/TestStack.cs`, enabled by `TestStack=true` |
| Service images | `stack.build.all`: `aspire do prepare-teststack`, the same `dotnet publish` container build as production. One image: `stack.build.service` (`aspire do build-<service>`). The build tags `<service>:latest`; the launcher retags `<service>:teststack` (slot n: `teststack-<n>`). |
| File-to-service mapping | `stack.resolver`: `pack:dotnet/stack/services.mjs` walks each service project's MSBuild references. `Directory.*.props`, `global.json`, `nuget.config` and the AppHost rebuild everything. |
| Host ports, URLs, passwords | `stack.ports`, `stack.urls`, `stack.env` |
| Datastores and readiness | `teststack.stores`, `teststack.services` |

What used to be code in the .NET loader is configuration here:

- `preserveTables: ["__EFMigrationsHistory"]` and `migrationsReady: { "table": "__EFMigrationsHistory", "column": "MigrationId" }`: EF Core migrations run at service startup, so the services own the schema.
- `sequences`: the four EF HiLo sequences of `orderingdb`, moved past the seeded ids after a load.
- `restartAfterLoad: [{ "service": "ordering-api", "when": "sequencesUsed" }]`: Ordering.API caches HiLo id blocks in memory, so it is restarted when one of those sequences was used since the last load.
- `onMissingTemplate: "drop"`: the services recreate their databases from migrations, so `--hard` snapshots a pristine schema.
- `commands.hash-password`: `factory teststack hash-password '<pw>'` prints an ASP.NET Core Identity V3 hash for `AspNetUsers.PasswordHash`.

The only test-only difference from production in the application is the seeder switch: `Seeding__Disabled=true` makes `MigrateDbContextExtensions` skip `CatalogContextSeed`, `UsersSeed` and `OrderingContextSeed`. The scenarios `_base` and `default` hold that data instead.

Readiness: the services run as Production, where `/health` is not mapped. Kestrel only starts listening once migrations finish, so any response below 500 means the service is up. Basket is gRPC only and is probed with HTTP/2 (`"http2": true`).

The build needs the .NET SDK and the Aspire CLI on `PATH` (`project.toolPaths`: `~/.dotnet`, `~/.aspire/bin`). Images are built for the host's Linux architecture; set `TestStackPlatform=linux-amd64` to override.

## Included scenarios

| Scenario | Contents |
| --- | --- |
| `_base` | Lookup data, always loaded first: `ordering.cardtypes` (1 Amex, 2 Visa, 3 MasterCard). |
| `empty` | Base only. |
| `default` | What the built-in seeders used to produce: 101 catalog items, 13 brands, 8 types, plus users `alice` and `bob` (password `Pass123$`). |

Fixed user IDs:

| User | ID |
| --- | --- |
| alice | `a11ce000-0000-4000-8000-000000000001` |
| bob | `b0b00000-0000-4000-8000-000000000002` |


The user ID is also the Redis basket key suffix (`/basket/<id>`) and `ordering.buyers.IdentityGuid`. Passwords are stored pre-hashed. Basket JSON matches `CustomerBasket` (`BuyerId`, `Items[]` with `Id`, `ProductId`, `ProductName`, `UnitPrice`, `OldUnitPrice`, `Quantity`, `PictureUrl`). AI features (embeddings, chat) are off in this stack, so `Catalog.Embedding` stays null.

## Ports and URLs (HTTP only)

These are slot 0's ports. Slot n adds 1000 × n to every one of them (slot 1: webapp 19080, identity 19081, ...).

| Service | Port |
| --- | --- |
| WebApp | 18080 |
| Identity | 18081 |
| Catalog | 18082 |
| Basket (gRPC) | 18083 |
| Ordering | 18084 |
| Webhooks API | 18085 |
| Webhooks client | 18086 |
| Mobile BFF | 18087 |
| Dashboard | 18888 |
| Postgres | 18432 |
| Redis | 18379 |
| RabbitMQ | 18672 |

The test credentials are in `stack.env` of the config fragment (`postgres` / `teststack-postgres`, and so on).

Identity is published as `http://host.docker.internal:18081` (slot n: `18081 + 1000n`), so the browser and the containers use the same issuer URL:

- `playwright.teststack.config.ts` maps that host to 127.0.0.1 for you.
- To log in from a normal browser, add `127.0.0.1 host.docker.internal` to `/etc/hosts`. Docker Desktop usually adds this already.

## Memory

A stack is 14 containers (Postgres, Redis, RabbitMQ, the dashboard, 9 .NET services and the YARP mobile BFF): about 0.95 GB right after `up` and about 1.55 GB after a few hours of tests on Apple silicon. Budget about 2 GB per slot (`stack.stackMemoryMb`).
