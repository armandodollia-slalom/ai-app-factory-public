---
name: setup-lsp
description: "Set up code intelligence (language servers over the `lsp` MCP server) for the repository you are in, whatever its languages: detect them, pick the language packs, install the servers, write the `lsp` section of .factory/config.json and prove it with `factory lsp check`. USE FOR: \"set up LSP\", \"set up code intelligence\", \"lsp tools answer unavailable\", adding a language to a repository the factory is installed in, a language that has no pack. DO NOT USE FOR: using the lsp tools while coding (they need no skill), the test stack, the architecture policy."
---

# Set up code intelligence for a repository

Result: agents in this repository get `lsp_*` tools (definition, references, hover, diagnostics, rename) for
its languages, in every worktree. The engine knows no language; everything you decide here goes into the `lsp`
section of `.factory/config.json`. Reference: `docs/code-intelligence.md` in the factory's install root (every
config field, the daemon commands, troubleshooting).

`factory` below is the factory CLI (`node .factory/bin/factory.mjs` when it is not on PATH). `<factory>` is its
install root: `factory lsp setup` prints the bridge path under it, and the packs are in `<factory>/packs/`.

## 1. Detect the languages

1. Read `.factory/config.json` if it exists: `project.languages` and an existing `lsp.servers` (keep what works).
2. Count tracked source files by extension. Do not trust the README:

   ```bash
   git ls-files | sed -n 's/.*\(\.[A-Za-z0-9]*\)$/\1/p' | sort | uniq -c | sort -rn | head -25
   ```

3. Keep the languages agents will edit. A language with a handful of files (a build script, one config generator)
   does not need a server. JSON, YAML and bash are covered by the engine defaults already.

## 2. Choose the packs

For each language, open `<factory>/packs/<id>/lsp.json` (`dotnet`, `typescript`, `rust`, `java`, `python`, `go`):

- `config.lsp.servers`: the entries to put in `.factory/config.json`.
- `optional`: alternatives or extras (CSS and HTML in `typescript`, basedpyright in `python`).
- `install`: how to get the server, per OS. `requires` and `notes`: what else must be true.
- `verified.status`: `executed` (proven through the factory) or `documentation` (written from the server's docs,
  so expect to adjust the command line; step 5 tells you).
- `leased`: whether the pack marks the server heavy, and why.

No pack for a language: go to "A language with no pack".

## 3. Install the servers

Run the `install` lines for this OS. Rules:

- Prefer an install the repository pins and every checkout shares: a devDependency (`npm install --save-dev
  <server>@<version>`), a .NET local tool manifest, `rustup component add` following `rust-toolchain.toml`. Commit
  the manifest change. Ask the user before installing anything machine-wide (`brew install`, `go install`,
  `pip install` outside a virtualenv) and before adding a dependency to the repository.
- A server installed per user (`~/.cargo/bin`, `~/go/bin`, `~/.dotnet/tools`, a virtualenv's `bin`) is invisible to
  hooks and background runs, which do not load the shell profile. Add its folder to `project.toolPaths` in
  `.factory/config.json`.
- Install the repository's own dependencies too (`npm ci`, `cargo fetch`, `dotnet restore`, `go mod download`, a
  virtualenv). A server without them reports every import as an error.

## 4. Write the `lsp` section

Merge into `.factory/config.json` (create the file with `{}` if missing; keep every other key):

```jsonc
{
  "project": { "toolPaths": ["~/.cargo/bin"] },
  "lsp": {
    "servers": [
      { "id": "rust", "extensions": [".rs"], "languageIds": ["rust"], "command": "rust-analyzer", "args": [], "leased": true }
    ],
    "check": [["rust", "src/lib.rs", 12, 8]]
  }
}
```

- `servers`: the pack entries, copied whole. They merge by `id` with the engine defaults (`bash`, `json`, `yaml`);
  `{ "id": "yaml", "disabled": true }` drops a default you do not want.
- Adjust per repository what the pack's `notes` point at. Examples: for .NET set `scope.options.solution` when the
  root has several solutions or none; for Java add a `prepare` command for Maven or Gradle.
- `leased: true` for a server that loads the whole workspace into memory (hundreds of MB and more: Roslyn,
  rust-analyzer, jdtls, gopls or tsserver on a large monorepo). Leased servers share a machine-wide cap
  (`maxLanguageServers`, default 6) across all checkouts and projects, so parallel worktrees cannot exhaust the
  machine. Lower the cap on a small machine: one leased server per parallel story is the need.
- `prepare` (leased servers only): a command that brings a fresh worktree's dependencies in before the server
  starts. It runs on every start, so it must be quick when there is nothing to do.
- `check`: one probe per server, `[serverId, file, line, column]`, pointing at a symbol that is defined in one
  file and used in another (1-based line and column of the symbol's first character). That proves the server
  loaded the project, not just the file. Without `check`, one file per server is picked by extension and only
  document symbols and diagnostics are asked.

## 5. Run the check

```bash
factory lsp setup                 # every configured server found? prints install lines for a missing one
factory lsp check --wait 300      # hover, definition, references, diagnostics per probe; exit 0 = all answered
```

Read the output, do not only look at the exit code:

- `references: 1 result(s)` for a symbol you know is used elsewhere: the server opened the file without its
  project. Fix the workspace (scope options, a missing `tsconfig.json`/`go.work`/virtualenv setting), not the probe.
- `diagnostics` listing errors the compiler does not report: dependencies are not installed or restored (step 3,
  or a `prepare` command).
- `<id> language server unavailable (failed to start: ...)`: wrong command or not on PATH. `factory lsp setup`
  shows where each command was found; fix `command`/`args` or `project.toolPaths`.
- `... unavailable (still loading ...)` after the wait: read `<git-dir>/lsp/lspd.log` and `prepare-<id>.log`
  (`git rev-parse --git-dir`).

After any config change: `factory lsp lspd stop`, then check again (a running daemon keeps its configuration).
When it passes, also run it once in a fresh worktree (`git worktree add ../lsp-probe && cd ../lsp-probe &&
factory lsp check --wait 600`, then remove the worktree): that is where pipeline agents work.

Finish with `factory lsp lspd stop`, commit `.factory/config.json` and the manifest files you changed, and tell the
user: which servers are configured, which are leased, what was installed and where, the check output, and anything
that could not be verified.

## A language with no pack

Any server that speaks LSP over stdio works; a pack is only a ready-made entry.

1. Find the language's server (its official one, or the one its VS Code extension runs) and how to start it over
   stdio (often `--stdio`, sometimes `serve`, `start` or `lsp`). Pin a version.
2. Write the entry yourself:

   ```json
   { "id": "elixir", "extensions": [".ex", ".exs"], "languageIds": ["elixir"], "command": "elixir-ls", "args": [] }
   ```

   `languageIds` are the LSP language identifiers (the server's docs, or the VS Code language id). `command` is a
   name on PATH or in `node_modules/.bin`, or a path relative to the repository; `${worktree}` and `${stateDir}`
   (a per-checkout scratch folder, for servers that need a workspace or cache directory) expand in `args` and
   `env`.
3. Decide `leased` by measuring: start it, run the check, look at the server's resident memory
   (`ps -o rss,command -p <pid>`). Several hundred MB or a long load: lease it.
4. Run step 5. A leased server without `reportsState` cannot tell the daemon when it finished loading; calls made
   during loading wait up to `callTimeoutSec`. That is acceptable for most servers.
5. Only when the server needs more than a command line, write helper modules in the repository (for example
   `.factory/lsp/`) and reference them with `${worktree}/.factory/lsp/<file>`:
   - a `scope` module, when the server would otherwise load a huge workspace and can be pointed at a part of it
     (`export function scope({ worktree, owns, stateDir, options })` returning `{ ok, env, description }`);
   - a stdio proxy that reports load state (`reportsState`), when the server needs a custom notification to open
     its workspace or you need "still loading" answers. `<factory>/packs/dotnet/lsp/` is the worked example of both.
6. Tell the user the entry is a candidate for a new pack (`<factory>/packs/<id>/lsp.json`), with the versions and
   OS you ran it on.

If no stdio language server exists for the language, say so and leave it out: agents use graphify and grep for
those files, which is the same fallback as an unavailable server.
