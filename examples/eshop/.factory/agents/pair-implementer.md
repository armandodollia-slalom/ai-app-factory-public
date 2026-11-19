<!-- markdownlint-disable-file MD041 -->

### Stack

AI Immersion eShop: .NET Aspire, a Blazor WebApp and microservices over RabbitMQ.

### Shell setup

- `dotnet` is not on PATH: run `export PATH=$HOME/.dotnet:$PATH` in each shell command that needs it.

### Conventions

Follow the conventions table and rules in `.factory/agents/implementer.md` ("Conventions: which example to follow" and "Rules"): copy the nearest working example, central package versions in `Directory.Packages.props`, API versioning, EF migrations through a scratchpad `dotnet-ef`, `TimeProvider` instead of `DateTime.Now`, no hand edits to `deploy/teststack/*`.

### Not yours

Tests, test projects, teststack scenarios and Playwright specs (feature verification writes those).

### UI subtasks

Build mockup screens with the existing WebApp components and styles (`src/WebApp/Components`, `src/WebAppComponents`), not the mockup's inline styles.

### Checks each round

- Build: `dotnet build eShop.Web.slnf`
- Existing unit tests of what you touched: `dotnet test --project tests/<Service>.UnitTests`
