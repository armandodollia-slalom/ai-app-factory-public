<!-- markdownlint-disable-file MD041 -->

### Test layers

- `unit`: in-process, no running services, for example the AppHost resource model in `tests/eShop.AppHost.UnitTests`.
- `functional`: API/service level against real dependencies (`tests/<Service>.FunctionalTests`).
- `e2e`: through the WebApp UI on the test stack.

### Seeded data

The `default` scenario (`.factory/stack/scenarios/default`) seeds the users alice and bob; use them where they fit.

### Plan files

The commit hook's markdownlint rejects `|----|` table delimiter rows; write `| --- | --- |`.
