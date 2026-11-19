<!-- markdownlint-disable-file MD041 -->

### Convention files

- `AGENTS.md`, `CONTRIBUTING.md` and `.editorconfig` (naming, `var`, braces, file-scoped namespaces, usings).
- `docs/architecture/*.md` and the conventions table in `.factory/agents/implementer.md`: minimal API endpoint groups with versioning, `Apis/` + `Model/` + `Infrastructure/` layout, EF Core migrations, integration events through the outbox, options for configuration, `TimeProvider` instead of `DateTime.Now`, central package versions in `Directory.Packages.props`, no hand edits to generated `deploy/teststack/*`.
- The nearest existing code: logging style, error responses, DI registration, Razor component structure and scoped CSS, test naming.
- Markdown in the PR follows the `.markdownlint` rules.

### Rules that matter most

- Async usage: `CancellationToken` passed, no `.Result`; nullability and disposal follow the existing patterns.
- No package versions in `.csproj`.
