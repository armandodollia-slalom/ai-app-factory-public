<!-- markdownlint-disable-file MD041 -->

### Flow docs

`docs/architecture/event-flows.md` and `docs/architecture/services.md` describe the existing flows. A flow runs UI (WebApp), API, domain, integration events, persistence.

### Integration points

AppHost wiring (`src/eShop.AppHost`), service discovery names, auth scopes (`src/Identity.API`), API versions, integration event names and handlers registered, EF migrations for new data. A step that cannot run in the composed app is broken.
