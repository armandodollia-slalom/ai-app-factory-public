<!-- markdownlint-disable-file MD041 -->

### Conventions

Follow the conventions table and rules in `.factory/agents/implementer.md` ("Conventions: which example to follow" and "Rules").

### Checks

- `dotnet build eShop.Web.slnf` and `dotnet test --project tests/<Service>.UnitTests` for each service you touched (on Linux/macOS `dotnet` may need `export PATH=$HOME/.dotnet:$PATH`).
- `npm run lint` (ESLint, dotnet format, markdownlint).
- `graphify update .` after code changes.
