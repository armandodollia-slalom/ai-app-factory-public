# Contributing to the factory

## Run the tests

```bash
npm ci
npm test                                                  # every stage and tool, with a fake agent (no LLM calls)
node --test packs/*/*/test/*.test.mjs                     # helper modules of the language packs
python3 -m unittest discover architecture-policy/tests    # the policy engine
```

The stage tests copy `scripts/` into a temporary repository and run the pipeline there with `scripts/pipeline/test/fixtures/fake-agent.mjs`. A new top-level folder under `scripts/` that a stage imports must be added to the copy list of those fixtures (`scripts/pipeline/test/e2e.test.mjs`, `scripts/implement/test/implement.test.mjs`, `orchestrate-e2e.test.mjs`, `lsp.test.mjs`).

## Layout

| Path | Holds |
| --- | --- |
| `bin/factory.mjs` | the one entry point: routes to the stages, the tools and the generator |
| `scripts/pipeline/` | the dispatcher, shared libraries (config, agents, state, metrics sink, guards) and `stages.json` |
| `scripts/<stage>/` | one stage or tool each, with its tests and its default `config.json` |
| `scripts/factory/` | `detect`, `init`, `render`, `check`, `uninstall`, `upgrade`, `doctor`, `sink` |
| `agents/` | base agent definitions |
| `packs/<language>/` | what the factory knows about one language |
| `templates/` | what `init` and `render` copy into a repository |
| `skills/` | setup skills an agent follows to configure a codebase |
| `architecture-policy/` | the policy engine (Python) |
| `examples/eshop/` | a complete `.factory/` folder |

## Rules

1. **No stack knowledge in the engine.** Code under `scripts/`, `bin/`, `agents/` and `templates/` names no language, framework, service, port or path of a particular application. That knowledge goes into a pack (`packs/<id>/`), a repository's `.factory/config.json`, or an agent addendum. Check before a commit:

   ```bash
   grep -rnE "eShop|\.csproj|\.razor|dotnet |Aspire" scripts bin agents templates --exclude-dir=test
   ```

   The expected hits are comments that list several languages as examples, and the registry of built-in API summarizers in `scripts/pr-video/lib/api-summary.mjs`.
2. **Defaults must be safe for an unknown codebase.** A default in `scripts/<stage>/config.json` is either neutral or `null`; a stage that needs a `null` setting says which key to set and skips or stops.
3. **Everything written into a repository goes through `render`.** A file outside `.factory/` must be an output in `scripts/factory/lib/render.mjs`, so it lands in the manifest and `factory uninstall` removes it.
4. **Agents are stack-neutral.** A base definition says what the role does and how; what the codebase looks like comes from the addendum.
5. **Windows, macOS and Linux.** New tooling is Node, not shell. Do not spawn extensionless scripts or rely on `sh`.

## Add a language pack

Create `packs/<id>/`:

| File | Content |
| --- | --- |
| `pack.json` | detection: `extensions`, `unitFiles` (the file that marks a buildable unit, such as `Cargo.toml` or `pom.xml`), `rootFiles`, `toolPaths`, `testHints`, `frontendHints`, `ignore` |
| `commands.json` | default `prepare`, `checks`, `unitTests`, `lint`, `format` commands, which `factory init` turns into the draft config |
| `lsp.json` | `config.lsp.servers`: the language server entries |
| `tests.json` | `config.precheck.testRunners`: how tests are run and discovered |
| `stack.json` (optional) | how a service of this language is built into the test stack |
| `lsp/`, `stack/`, `pr-video/` (optional) | helper modules, with tests under `<helper>/test/` |

Then add a fixture repository to `scripts/factory/test/factory.test.mjs` and check `factory detect` and `factory init` on a real project of that language. Say in the pack's `$comment` what you ran and what you only took from documentation.

Verified by running: the LSP entries of `dotnet`, `typescript`, `python` and `go`, and the test runners for `cargo`, `go` and `node`. The `rust` and `java` LSP entries and the other runners were written from documentation.

## Change an agent, a template or a skill

- After editing `agents/*.agent.md`, run the tests: prompt versions are hashes and some tests pin structure, not text.
- After editing `templates/`, run `factory render` in a test repository and `factory check`.
- The retro stage of repositories that use the factory pushes proposal branches that change `agents/`, `docs/`, `templates/` and `skills/` here; a person opens the pull request. Review them like any other change: they quote the evidence from the repository that proposed them.
- After changing a page with a Mermaid diagram, check that it still renders (GitHub's preview, or the Mermaid live editor); keep node text short and quote labels that contain punctuation.
- After changing `templates/e2e/`, add the new file's hash to `templates/e2e/history.json` (a test checks it).

## Releases

The version is in `package.json`. Repositories pin it in `.factory/factory.json` and fetch it by tag (`v<version>`), so tag every release.
