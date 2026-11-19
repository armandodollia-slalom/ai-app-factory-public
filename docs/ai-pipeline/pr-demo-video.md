# PR demo videos

Part of the [AI development pipeline](README.md). Pull requests that change the frontend get a **Demo video** section in their description: the videos of the e2e specs they add or change, recorded on the [test stack](../test-stack.md), each with an animated preview that plays inline and a link to the full WebM. Reviewers see the feature working without checking out the branch, and the [PR check](pr-check.md#videos)'s video critic reads the same links. Pull requests that change only the backend get an [API changes](#api-changes-backend-only-prs) section instead.

The recording is Playwright-based by design: the workflow runs Playwright specs and reads the manifest the factory's Playwright reporter writes.

## Turning it on

The workflow is off by default. It needs a test stack ([test-stack.md](../test-stack.md)) and Playwright specs that run against it.

1. Run `factory init --with demoVideo` and commit the result. It sets `"demoVideo": true` under `features` in `.factory/factory.json`, generates `.github/workflows/factory-pr-demo-video.yml` and writes the toolchain action of step 2 (the `ci` feature must be on, which it is by default).
2. Fill in `.github/actions/factory-toolchain/action.yml`: the steps that install what the codebase needs to build and start its stack on a CI runner (SDKs, package restore). `factory init` writes it once and never touches it again; it is yours.
3. Set `prVideo` in `.factory/config.json`:

   | Key | Default | Meaning |
   | --- | --- | --- |
   | `specPatterns` | `[]` | globs of the e2e specs whose recordings demo a PR, for example `["e2e/teststack/*.spec.ts"]`. Empty: no spec is ever picked |
   | `videosDir` | `artifacts/e2e-videos` | where the Playwright reporter writes the videos and `manifest.json` |
   | `storageBranch` | `pr-videos` | the branch the videos are stored on |
   | `backendPaths` | `[]` | globs of backend code. Empty: the paths of every service in `project.services` whose `kind` is not `frontend` |
   | `neutralPaths` | `[]` | globs that count as neither frontend nor backend (application wiring, shared defaults) |
   | `api.extractor`, `api.sources`, `api.exclude`, `api.openapi` | `null`, `[]`, `[]`, `[]` | where the [API changes](#api-changes-backend-only-prs) section reads endpoints from |

4. Give the repository the Playwright pieces the workflow relies on. The factory ships them in `templates/e2e/` of its install (`"$(factory version --path)/templates/e2e"`); the `feature-demo-video` skill (`skills/feature-demo-video/SKILL.md` in the factory) lists them and where they go.

The generated workflow runs the specs with `npx playwright test -c playwright.teststack.config.ts --project scenarios --no-deps`, so the repository needs that config file at its root with a `scenarios` project (the template has one).

## Which PRs get what

`factory pr-video scope --base <ref>` sorts the PR's changed files with the project model in `.factory/config.json`:

- **Frontend**: a file matching `project.frontendPaths`, or in the paths of a service with `"kind": "frontend"`.
- **Backend**: any other file under `prVideo.backendPaths`, or, when that is empty, in a service of another kind; never a file matching `prVideo.neutralPaths`.
- Files in neither (tests, e2e specs, docs, CI) count as neither.

| PR changes | Demo video | API changes |
| --- | --- | --- |
| Frontend only | ✅ | ❌ |
| Frontend and backend | ✅ | ❌ |
| Backend only | ❌ | ✅ |
| Neither | ❌ | ❌ |

Sections that no longer apply (for example after a frontend change is pushed to a backend-only PR) are removed, along with any stored videos.

## How it works

`.github/workflows/factory-pr-demo-video.yml` runs when a PR is opened, reopened, marked ready for review or pushed to. It works the same for PRs that `factory implement run --pr` opens and for PRs people open. It installs the engine with the generated `setup-factory` action, then:

1. `factory pr-video specs --base origin/<base>` lists the specs matching `prVideo.specPatterns` that the PR adds or changes, and `scope` decides whether the PR gets a video, an API summary or neither.
2. If the PR changes the frontend but no spec, the section says so and nothing is recorded.
3. Otherwise it runs the toolchain action, installs `ffmpeg` and Playwright's Chromium, starts the test stack (`factory teststack up`) and runs those specs with `E2E_KEEP_VIDEOS=1` and `E2E_API_LOG=1`.
4. `factory pr-video publish` reads `<videosDir>/manifest.json`, makes a GIF preview of each video with `ffmpeg` (skipped if it would exceed 9 MB), pushes the files to `pr-<n>/` on the storage branch, and replaces the section between `<!-- pr-demo-video:start -->` and `<!-- pr-demo-video:end -->` in the PR description. Text outside the markers is left alone.
5. The videos are also uploaded as the `pr-demo-video-<n>` artifact. If a spec failed, its video is marked failed in the section and the job fails.
6. `factory pr-video api` adds or removes the API changes section, using the `api` and `frontend` values step 1 already worked out (`--api`, `--frontend`). It only edits the PR description, so it runs with `continue-on-error`: a failure there never fails the recording.

API-only specs have no browser, so they record no video. A user-facing change needs a UI spec; see the `feature-demo-video` skill.

## API changes (backend-only PRs)

PRs that change backend code (see [Which PRs get what](#which-prs-get-what)) and no frontend code get an **API changes** section, between `<!-- pr-api-summary:start -->` and `<!-- pr-api-summary:end -->`. The engine knows no web framework; where the endpoints come from is configuration (`prVideo.api`):

| Configured | The changed endpoints are |
| --- | --- |
| `extractor` and `sources` | read by a route extractor from the changed source files matching `sources` (minus `exclude`), compared between the merge base and the PR head. `extractor` is a built-in name (`aspnet-minimal-api`, in `packs/dotnet/pr-video/`) or the path of a module, in the repository or the factory install, that exports `parseEndpoints(source)` |
| no extractor, OpenAPI files in `openapi` | the difference between each OpenAPI file at the merge base and at the PR head |
| neither | not known: the section shows only the calls the specs recorded, and is skipped (with a note in the log) when there are none |

For each endpoint the section gives:

- **Method and endpoint**, with the service it belongs to (its name in `project.services`, else its folder).
- **Request and response**: parameters, request body type and fields, and response codes and types, read from the OpenAPI documents in `prVideo.api.openapi` (files in the repository, or URLs the running test stack serves; write a stack service's port as `{port:<name>}`, a port name of `stack.ports` in `.factory/app.json`, for example `http://localhost:{port:orders}/openapi/v1.json`, and it is resolved to the slot in use, `TESTSTACK_SLOT` or 0). Removed endpoints are only listed in the table.
- **Examples**: real calls the changed specs made through Playwright's `request` fixture. The workflow runs them with `E2E_API_LOG=1`, so the factory's `e2e/fixtures.ts` attaches each call (method, URL, request headers and body, status, response body) and `e2e/video-reporter.ts` adds them to `manifest.json`. The section shows up to three examples per endpoint. `Authorization`, cookie and API-key headers and JSON keys that look like secrets (password, token, secret, API key) are redacted, and bodies are truncated.

Endpoints the specs called but the PR did not change are listed as *Exercised*, which covers changes inside services the route diff can't see. The specs still run for backend-only PRs (to record the examples), but their videos are not published. The stack is started for backend-only PRs even when no spec changed, so OpenAPI documents served by the stack can still be read. The section is removed when there is nothing to show.

## Storage

Videos live on the storage branch (`pr-videos`), which is rewritten as a single parentless commit on every publish, so replaced videos don't build up in history. Links use `github.com/<repo>/blob/pr-videos/...`, which works for private repositories too: previews use `?raw=true`, and the PR check rewrites the links to `raw.githubusercontent.com` and downloads them with its token. When a PR is closed without merging, its folder is removed; merged PRs keep theirs as a record of the feature.

Fork and Dependabot PRs get a read-only token, so the workflow skips them.

## Running it by hand

```bash
factory pr-video specs --base origin/main
factory pr-video scope --base origin/main   # frontend/backend/video/api
factory teststack up
E2E_KEEP_VIDEOS=1 E2E_API_LOG=1 npx playwright test -c playwright.teststack.config.ts --project scenarios --no-deps <specs>
GH_TOKEN=... factory pr-video publish --pr 42 --specs <a,b>
factory pr-video api --base origin/main --dry-run   # print the API changes section
factory pr-video cleanup --pr 42
```

`publish` and `cleanup` need push access to the repository and the `gh` CLI.
