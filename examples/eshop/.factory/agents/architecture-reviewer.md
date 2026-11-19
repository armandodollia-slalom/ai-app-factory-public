<!-- markdownlint-disable-file MD041 -->

### Patterns to check under "Fit"

The change follows the existing service boundaries and patterns of eShop: minimal API endpoints, `Apis/` + `Model/` + `Infrastructure/` layout, EF Core contexts and migrations, integration events over the event bus, Aspire AppHost wiring, API versioning.

### Operations

Logging and telemetry follow the service defaults (`eShop.ServiceDefaults`); configuration goes through options.
