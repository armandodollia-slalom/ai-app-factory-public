# Code intelligence for agents (LSP over MCP)

Agents get compiler-grade facts about the code (definitions, references, types, diagnostics, safe renames) from
language servers, exposed as tools of one MCP server named **`lsp`**. It works the same in Claude Code (interactive
and `claude -p`), GitHub Copilot CLI and Codex, and in every git worktree.

The engine knows no language. Which servers run, how they start and what they need comes from the `lsp` section of
the app repository's `.factory/config.json`; ready-made entries for .NET, TypeScript, Rust, Java, Python and Go are
in the language packs (`packs/<id>/lsp.json`). To set it up in a repository, use the `setup-lsp` skill
(`skills/setup-lsp/SKILL.md`).

**graphify comes first.** Use graphify (`graphify query/explain/path`) to decide where to look and to investigate
architecture and relationships. Use the `lsp` tools for precise work at code graphify or a read already located:
confirm the definition, signature and callers before changing existing code, check diagnostics after every edit,
preview renames.

## How it fits together

```text
agent CLI ──stdio──> factory lsp mcp ──unix socket──> lspd (one per checkout) ──stdio──> lsp-mcp-server
 (.mcp.json, .codex/config.toml)   (logs calls)        (leases, prepare, scope, gates calls)   └─> language servers
```

- **`factory lsp mcp`** (`scripts/lsp/mcp.mjs`): the MCP server the CLIs start. It finds the checkout from the
  current directory (`git rev-parse --show-toplevel`), starts that checkout's daemon if none runs, relays MCP
  messages and appends each tool call to the call log. It never connects to another checkout's daemon.
- **`factory lsp lspd`** (`scripts/lsp/lspd.mjs`): the per-checkout daemon. All sessions in a checkout (the main
  agent, subagents, the pipeline's headless runs, the edit hook) share its language servers. It runs
  [lsp-mcp-server](https://github.com/ProfessioneIT/lsp-mcp-server) as the LSP client, starts language servers on
  first use, stops idle ones and exits when idle with no sessions. It listens on a unix socket on macOS and Linux and
  on a named pipe (`\\.\pipe\ai-app-factory-lsp-…`) on Windows.
- **Leased servers.** A server marked `"leased": true` is heavy, so each daemon needs a machine-wide **lease** before
  it starts one (default cap 6, shared by every project on the machine). Without a lease, or while the server is
  preparing or loading, calls for its files answer at once with
  `<server id> language server unavailable (<reason>); use graphify and grep` instead of hanging.

The engine's files are always taken from its install root; the app repository holds only `.factory/`. Language
server binaries are looked up in the app repository's `node_modules/.bin` (a worktree falls back to the main
checkout's), then the engine's `node_modules/.bin`, then `PATH` (extended by `project.toolPaths`).

All commands below are `factory lsp <mcp|lspd|hook|check|setup|scope> ...`; each is also a script that runs
directly: `node <install root>/scripts/lsp/<name>.mjs ...`.

## Configuration

Engine defaults (`scripts/lsp/config.json`) merged with the `lsp` section of `<repo>/.factory/config.json`:

```jsonc
{
  "lsp": {
    "maxLanguageServers": 6,     // cap of leased servers running at once, machine-wide (env LSP_MAX_SERVERS); 0 disables them
    "idleSec": 900,              // idle servers stop; the daemon exits when idle with no sessions (env LSP_IDLE_SEC)
    "callTimeoutSec": 60,        // one tool call
    "diagnosticsTimeoutSec": 20, // one file in `lspd diagnostics` and the edit hook
    "loadTimeoutSec": 900,       // default for servers[].loadTimeoutSec
    "prepareTimeoutSec": 900,    // default for servers[].prepare.timeoutSec
    "servers": [ /* server entries, below */ ],
    "check": [["rust", "src/lib.rs", 12, 8], ["yaml", ".github/dependabot.yml"]]
  }
}
```

`servers` is merged **by id** with the engine defaults: an entry overrides the fields it names of the default with
the same id, a new id is added, and `{ "id": "yaml", "disabled": true }` removes one. The defaults are the
language-neutral servers only: `bash`, `json` and `yaml` (from the engine's own `node_modules`).

A server entry:

| Field | Required | Meaning |
| :- | :- | :- |
| `id` | yes | Name used in tool arguments (`server_id`), status output, leases and the "unavailable" message. |
| `extensions` | yes | File extensions it answers for, with the dot (`[".rs"]`). The first server listing an extension wins. |
| `languageIds` | yes | LSP language ids sent when a file is opened (`["rust"]`). |
| `command` | yes | What to run. `node` is the node running the daemon; a bare name is looked up in `node_modules/.bin` (app, then engine), then `PATH`; a path is relative to the checkout. |
| `args` | no | Arguments. The server must speak LSP over stdio. |
| `env` | no | Extra environment variables for the server and its `prepare` command. |
| `leased` | no | `true`: heavy server. It takes one machine-wide lease slot, the daemon starts it at once (after `prepare`) instead of on first use, and calls are answered "unavailable" while it is not ready. |
| `reportsState` | no | `true`: the command writes its own load state to `$LSPD_STATE_FILE` as `{"state":"starting"\|"loading"\|"ready"\|"exited"}` (a pack's proxy does this). Without it a leased server runs under `scripts/lsp/launch.mjs`, which only records `running` and `exited`. |
| `loadTimeoutSec` | no | With `reportsState`: after this long in `starting`/`loading`, calls go through anyway. |
| `prepare` | no | `{ "command", "args", "label"?, "timeoutSec"? }`: run in the checkout before a **leased** server starts (restore packages, fetch dependencies). It must be quick when there is nothing to do. Output goes to `<git-dir>/lsp/prepare-<id>.log`; a failure is logged and the server starts anyway. |
| `scope` | no | `{ "module", "options"? }`: a module that narrows what the server loads to the part of the checkout owning a set of globs (below). |
| `hook` | no | `false`: the edit hook does not report this server's diagnostics (default `true`). |
| `rootPatterns` | no | Files marking the workspace root (default `[".git"]`). |
| `disabled` | no | `true` removes the entry (to drop an engine default). |

In `command`, `args`, `env` values and `scope.module`: `${worktree}` is the checkout, `${factory}` the engine's
install root, `${stateDir}` the checkout's `<git-dir>/lsp`, and a leading `pack:<id>/...` is a file of a language
pack (`<install root>/packs/<id>/...`).

Every server process gets `LSPD_SERVER_ID` and `LSPD_STATE_FILE` in its environment, plus what its scope module
answered.

Files of a type with no entry here fall through to lsp-mcp-server's own built-in server list (it tries the usual
command for that language on `PATH`); the daemon gives those no lease, state tracking or edit-hook diagnostics.

### Scope modules

A story or subtask usually owns a few folders. `lspd start --owns <glob>...` (the implement stage passes each
subtask's globs) asks every server that has a `scope` module what to load for them:

```js
// <module>.mjs
export function scope({ worktree, owns, stateDir, options, server }) {
  // owns: globs relative to the checkout; [] = the whole checkout
  return { ok: true, env: { MY_SERVER_WORKSPACE: '...' }, description: '3 project(s) of app.sln' };
  // or { ok: false, error: 'why' }: with globs, the daemon falls back to scope({ owns: [] })
}
```

`env` is added to the server's and its `prepare` command's environment; `description` shows in the status and in
"still loading ..." messages. The module may write files under `stateDir`. `factory lsp scope --owns <glob>...`
prints what the configured modules answer without starting anything. The .NET pack's module
(`packs/dotnet/lsp/scope.mjs`) writes a solution filter with the owning projects and their references.

### `check`

`factory lsp check` asks each server about a real file: hover, definition and references when a symbol position is
given, document symbols otherwise, and diagnostics either way. `lsp.check` lists the probes as
`[serverId, file, line, column]` (1-based position of a symbol; leave the position out for symbols only). With no
`check` configured it picks one tracked file per configured server by extension.

```bash
factory lsp check [--root <checkout>] [--only <id>,<id>] [--wait <seconds>]   # exit 0 when every probe answered
```

`--wait` retries a leased server that is still preparing or loading.

## Language packs

| Pack | Server (`id`) | Leased | Verified by running it through the factory |
| :- | :- | :- | :- |
| `packs/dotnet/lsp.json` | Roslyn `roslyn-language-server` (`csharp`), with `packs/dotnet/lsp/`: `roslyn-proxy.mjs` (opens the solution, reports load state), `prepare.mjs` (`dotnet tool restore`, `dotnet restore` when needed), `scope.mjs` (solution filter) | yes | yes (macOS) |
| `packs/typescript/lsp.json` | `typescript-language-server` (`typescript`); optional `css`, `html` | no | yes (macOS) |
| `packs/python/lsp.json` | `pyright-langserver` (`python`); optional basedpyright | no | pyright yes (macOS); basedpyright no |
| `packs/go/lsp.json` | `gopls` (`go`) | no | yes (macOS) |
| `packs/rust/lsp.json` | `rust-analyzer` (`rust`) | yes | no, written from documentation |
| `packs/java/lsp.json` | Eclipse `jdtls` (`java`) | yes | no, written from documentation |

Each pack file holds `config` (the `lsp.servers` entries `factory init` merges into `.factory/config.json`),
`optional` (further fragments to merge by hand), `install` (commands per OS, with a pinned version where the
ecosystem has no lockfile of its own), `leased` (why or why not), `requires`, `notes` and `verified`.
The `lsp` section of `examples/eshop/.factory/config.json` is a complete one: the one that reproduces eShop's setup.

The MCP bridge `lsp-mcp-server` (1.1.27) and the default servers (`bash-language-server` 5.8.1,
`vscode-langservers-extracted` 4.10.0 for JSON, `yaml-language-server` 1.25.0) are devDependencies of the engine:
`npm ci` in the install root. `LSP_MCP_SERVER` names another bridge entry file. `bash-language-server` reports lint
diagnostics only when `shellcheck` is on `PATH`.

## Install and verify

```bash
factory lsp setup            # is the bridge installed, can every configured server be found? prints the pack's install lines for a missing one
factory lsp setup --check    # also start this checkout's daemon and run the smoke test
factory lsp lspd status      # every daemon on the machine and the leases
```

`setup` installs nothing itself and exits 1 when something is missing. A fresh git worktree needs no setup of its
own: node servers fall back to the main checkout's `node_modules`, and a leased server's `prepare` command brings
the worktree's dependencies in before the server starts.

In a CLI: Claude Code `/mcp` (or `claude mcp get lsp`), Copilot `copilot mcp get lsp`, Codex `codex mcp get lsp`.

## How each agent CLI gets it

| CLI | Config | Notes |
| :- | :- | :- |
| Claude Code (interactive) | `.mcp.json`, approved by `enabledMcpjsonServers: ["lsp"]` in `.claude/settings.json` | Project approvals apply once the folder is trusted; trust covers all worktrees of the repo. |
| `claude -p` | same `.mcp.json` | Connects without approval. MCP tools still need permission: list them in `--allowedTools`. |
| GitHub Copilot CLI | reads the same `.mcp.json` (workspace config) | Workspace MCP servers load only in a trusted folder; `-p` in an untrusted worktree needs `--trust-folder`. |
| Codex | `.codex/config.toml` `[mcp_servers.lsp]` | Project config loads only for trusted projects; otherwise pass the server with `-c` (below). |

Claude Code also runs `factory lsp hook` after `Edit`, `Write` and `MultiEdit`: when the edited file's type has a
configured server (without `"hook": false`), the checkout's daemon runs and it reports errors in the file, they are
shown to the agent next to the tool result. It never starts a daemon and stays silent when the server is
unavailable.

## Tools

All take absolute paths inside the checkout and 1-indexed line/column.

- **Read-only**: `lsp_goto_definition`, `lsp_goto_type_definition`, `lsp_find_references`,
  `lsp_find_implementations`, `lsp_hover`, `lsp_signature_help`, `lsp_document_symbols`, `lsp_workspace_symbols`,
  `lsp_find_symbol`, `lsp_smart_search`, `lsp_call_hierarchy`, `lsp_type_hierarchy`, `lsp_diagnostics`,
  `lsp_workspace_diagnostics`, `lsp_index_files`, `lsp_completions`, `lsp_document_highlights`, `lsp_inlay_hints`,
  `lsp_selection_range`, `lsp_folding_ranges`, `lsp_file_imports`, `lsp_file_exports`, `lsp_related_files`,
  `lsp_server_status`.
- **Mutating** (edit files when asked to apply): `lsp_rename` (`dry_run` defaults to true), `lsp_code_actions`
  (`apply` defaults to false), `lsp_format_document` (`apply` defaults to false).
- `lsp_start_server` / `lsp_stop_server` are hidden: lspd manages server lifecycles shared by several sessions.

Allowing them in headless runs:

| CLI | All tools (implement/write) | Read-only (verifiers, reviewers) |
| :- | :- | :- |
| `claude -p --allowedTools` | `mcp__lsp` | each read-only tool as `mcp__lsp__<tool>`, e.g. `mcp__lsp__lsp_find_references` |
| `copilot -p` | `--allow-tool lsp` | `--allow-tool lsp --deny-tool 'lsp(lsp_rename)' --deny-tool 'lsp(lsp_code_actions)' --deny-tool 'lsp(lsp_format_document)'` |
| `codex exec` | nothing (`default_tools_approval_mode = "approve"`) | `-c 'mcp_servers.lsp.disabled_tools=["lsp_rename","lsp_code_actions","lsp_format_document"]'` |

Codex in a project it does not trust ignores `.codex/config.toml`; define the server on the command line instead:
`-c 'mcp_servers.lsp.command="node"' -c 'mcp_servers.lsp.args=["<install root>/scripts/lsp/mcp.mjs"]' -c 'mcp_servers.lsp.env_vars=["PIPELINE_AGENT_NAME"]' -c 'mcp_servers.lsp.default_tools_approval_mode="approve"'`.

## Daemon commands (for the pipeline and humans)

Every command prints one JSON line. `--worktree` defaults to the checkout containing the current directory.

```bash
factory lsp lspd start --worktree <path> [--owns <glob>...]
#  {"ok":true,"pid":n,"socket":"...","leased":"none|running|unavailable","reason":"<id>: <why>"|null,
#   "servers":{"<id>":{"status":"running|unavailable","state":"preparing|starting|loading|ready|running"|null,
#                      "reason":...,"leaseSlot":n|null,"scope":"<description>"|null}},"stateDir":"..."}
#  `servers` lists the leased servers. Idempotent: a running daemon answers with the same pid and socket
#  (its scope is not changed; stop it first to start with other globs).
factory lsp lspd stop --worktree <path>
factory lsp stop [--worktree <path>] | --all | --orphans   # the same, every daemon, or those whose run died or whose worktree is gone
factory lsp lspd status [--worktree <path>]     # without --worktree: all daemons and leases
factory lsp lspd stop-all
factory lsp lspd diagnostics --worktree <path> --files <f1> [<f2>...] [--no-start]
#  {"ok":true,"files":{"<f1>":[{"severity":"error","line":5,"col":35,"code":"E0308","message":"..."}],
#                      "<f2>":{"unavailable":"rust language server unavailable (still loading (12s so far)); use graphify and grep"}}}
factory lsp scope --owns <glob>... [--worktree <path>] [--server <id>]
#  {"ok":true,"scopes":{"<id>":{"ok":true,"env":{...},"description":"..."}}}
```

Files:

| What | Where |
| :- | :- |
| Socket, pid file, start lock | `$TMPDIR/ai-app-factory-lsp/<sha256(realpath(worktree))[:12]>.{sock,json,lock}` (env `LSP_RUNTIME_DIR` moves the folder) |
| Leases (machine-wide, all projects) | `$TMPDIR/ai-app-factory-lsp/leases/slot-<n>.json` (`{slot,pid,owner,server,since}`: `owner` is the checkout, `server` the server id; a dead pid's slot is reclaimed) |
| Daemon log, prepare log, load state | `<git-dir>/lsp/lspd.log`, `prepare-<id>.log`, `server-<id>.json` |
| Call log (metrics) | `<git-dir>/lsp/calls.jsonl`: `{ts, agent, tool, file, symbol}` per tool call; `agent` is `$PIPELINE_AGENT_NAME`, `symbol` the query, new name or `line:column` |

`<git-dir>` is `git rev-parse --git-dir`: `.git` in the main checkout, `.git/worktrees/<name>` in a worktree. The
pid file and `status` carry the project name (`project.name`), so daemons of several repositories on one machine
can be told apart; socket names come from the checkout's path, so they never collide.

`LSP_OWNS` (comma-separated globs) makes `factory lsp mcp` start a missing daemon with that scope.

The implement stage reaches all of this through `scripts/implement/lib/lsp.mjs` (`implement.lsp.lspdCmd` and
`setupCmd` in the config, looked up in the install root first).

## Memory

Measured on macOS (Apple silicon) in a services-based .NET repository (a solution of about 25 projects plus a TypeScript
e2e suite), resident memory after loading and a few queries. Measure your own repository before choosing
`maxLanguageServers`:

| Process | RSS |
| :- | :- |
| Roslyn, full solution | ~730 MB (590 MB right after load) |
| Roslyn, scoped with `--owns 'src/<one service>/**'` (5 projects) | ~500 MB |
| Roslyn wrappers (`roslyn-proxy.mjs`, `dotnet tool run`, tool relay) | ~105 MB |
| TypeScript (`typescript-language-server` + 2 `tsserver`) | ~560 MB |
| bash-language-server | ~130 MB |
| lspd + lsp-mcp-server | ~100 MB |

So a worktree there costs roughly 0.7 to 1.6 GB while agents use it; the lease cap bounds the leased part
machine-wide. A leased server without `reportsState` adds one small node process (`launch.mjs`).

## Troubleshooting

- `<id> language server unavailable (all 6 leased language server slots are in use ...)`: other checkouts hold the
  leases. See `factory lsp lspd status`; `factory lsp lspd stop --worktree <path>` frees one. A crashed daemon's
  slot is reclaimed automatically.
- A leased server stays `preparing` or `loading`: see `<git-dir>/lsp/lspd.log` and `prepare-<id>.log`; after
  `loadTimeoutSec` calls go through anyway.
- `<id> language server unavailable (failed to start: ...)`: the command was not found or exited. Run
  `factory lsp setup`; for a tool installed per user, add its folder to `project.toolPaths` (hooks and background
  runs do not load the shell profile).
- Errors that the compiler does not report (unresolved imports, "type not found"): the checkout's dependencies are
  not installed or restored. Install them (or give the server a `prepare` command), then `lspd stop` and start
  again.
- MCP server fails to start: `factory lsp mcp < /dev/null` prints the reason; usually `npm ci` is missing in the
  install root, or `.factory/config.json` is not valid JSON or has a server entry without `command`.
- YAML server exits during initialization with `Cannot find module 'ajv/dist/core'`: another package's `ajv@6` got
  hoisted over the `ajv@8` the YAML server needs. The engine's `package.json` pins `ajv@^8` for this.
- Everything at once: `factory lsp lspd stop-all`.
- Tests: `node --test scripts/lsp/test/*.test.mjs scripts/implement/test/lsp.test.mjs packs/dotnet/lsp/test/*.test.mjs`.
  They need no language server and no npm install (fake servers and a fake bridge under `scripts/lsp/test/fixtures/`);
  set `LSP_MCP_SERVER` to a real `lsp-mcp-server/dist/index.js` to run the daemon tests against the real bridge.

## Leases after a crash

Each leased server's lease records the pipeline run that asked for it (`PIPELINE_RUN_PID`, set by every `implement` story process). When a run dies (a crash, `kill -9`), its daemons can outlive it and keep their slots. The next lease request reclaims a slot whose run is dead, stopping that daemon; `implement resume` stops a dead run's daemons before it resumes; `factory lsp stop --orphans` does the same by hand. Daemons of interactive sessions record no run and are never reaped; they still stop after `idleSec` with no sessions.

Every `implement run` and `implement resume` sets `PIPELINE_RUN_PID` for everything it starts, including the daemons an agent's MCP bridge starts, and stops the daemons leased under it when it ends, whatever the outcome (`lspd stop-run --run <pid>`). A run that finds every slot in use waits for one up to `implement.lsp.leaseWaitSec` (default 300 s, polling every `leaseWaitPollSec`); if it still has to go without, that is recorded with the story (`run-conditions.jsonl`), and every PR body that carries the story, a single ticket's or a bug-epic group's, says which server it went without. A bug epic's planner works in the main checkout; the daemon it started there is released when planning ends (`lspd stop-run --run <pid> --worktree <main checkout>`), not when the whole run ends.
