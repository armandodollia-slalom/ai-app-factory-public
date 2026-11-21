---
name: feature-demo-video
description: "**REQUIRED WORKFLOW SKILL** - After implementing a change a user can see or do in a browser, cover the flow with a passing (optionally narrated) Playwright e2e test on the test stack and hand over its video, so people can verify and demo it. USE FOR: finishing any feature, bug fix or UI change visible in the application's web frontend; \"record a demo\", \"prove it works\", \"demo video\", \"walkthrough video\", \"test videos\", \"e2e video\". DO NOT USE FOR: backend-only changes with no browser-visible effect, docs-only changes, refactors with no behavior change, repositories with no browser UI. INVOKES: factory teststack, playwright-cli (locator discovery), the Playwright test runner."
---

# Feature videos from e2e tests

This skill is Playwright-based by design: the videos, the keyframes and the manifest come from Playwright and from three files the factory ships. Everything else (where the specs live, how the application starts, which users exist) comes from the repository: read `.factory/config.json` and the implementer's addendum (`.factory/agents/implementer.md`) before you start. `factory` below is `.factory/bin/factory` when it is not on your PATH.

## What the repository needs (once)

Check these first. If one is missing, add it, or tell the user what is missing when the repository has no Playwright setup at all (do not invent one as a side effect of a feature).

| Piece | Where | From |
| --- | --- | --- |
| Playwright with video on | `playwright.config.ts`: `use.video` set (for example `'on'`), and `./e2e/video-reporter.ts` in `reporter` | the repository |
| Shared fixtures | `e2e/fixtures.ts`, `e2e/demo.ts`, `e2e/video-reporter.ts` | `templates/e2e/` in the factory install |
| Test stack helpers | `e2e/teststack/ports.ts`, `e2e/teststack/scenario.ts`, `playwright.teststack.config.ts` at the root | `templates/e2e/` (the `setup-teststack` skill copies these) |
| A test stack | the `stack` and `teststack` sections of `.factory/config.json`, scenarios in `.factory/stack/scenarios/` | the `setup-teststack` skill; see `docs/test-stack.md` in the factory |
| Ignored output | `artifacts/` in `.gitignore` | the repository |
| API documents for backend PRs | `prVideo.api.openapi` in `.factory/config.json`: the OpenAPI document URL of every HTTP service the test stack runs, with the slot's port as `{port:<name>}` (a port name of `stack.ports` in `.factory/app.json`), for example `http://localhost:{port:orders}/openapi/v1.json`, one entry per API version the service documents; checked-in OpenAPI files as repository paths | the services' source (where they map their OpenAPI documents) and the running stack: `factory teststack up`, then `curl -sf` each URL with the slot-0 port. A backend PR's API changes section reads request and response types from these; without them it says "Not in the OpenAPI documents" |

The factory install is `"$(factory version --path)"`; copy with `cp "$(factory version --path)/templates/e2e/fixtures.ts" e2e/` and so on. The reporter writes to `artifacts/e2e-videos/` next to the `e2e/` folder, so keep these files in `e2e/` at the repository root; if the repository keeps its specs elsewhere, adjust the reporter's output folder and set `evidence.manifest` and `prVideo.videosDir` in `.factory/config.json` to match. `examples/eshop/e2e/add-to-cart.spec.ts` in the factory is an example of a narrated spec from another application: copy its shape, not its steps.

## How recording works

Every Playwright test records video (`use.video`, inherited by `playwright.teststack.config.ts`). **By default only failed tests keep their video and keyframes.** Set `E2E_KEEP_VIDEOS=1` to keep them for passing tests too, which you need for a demo video (`$env:E2E_KEEP_VIDEOS=1` in PowerShell). After each run, `e2e/video-reporter.ts` copies them to:

```text
artifacts/e2e-videos/<project>/<spec>--<test>.webm          # passed (only with E2E_KEEP_VIDEOS=1)
artifacts/e2e-videos/<project>/<spec>--<test>.failed.webm   # failed: use it to debug, never as proof
```

The folder is moved to `artifacts/e2e-videos-previous/` at the start of each run, so the last run stays available for comparison.

## Keyframes for agents

Agents can't watch a video, so each recorded test also captures **keyframes**: labeled screenshots at the end of every `test.step` (`step failed: …` if it threw), at each `demo.highlight` and chapter end, and of every open page when the test ends (`final`, or `failure`). They are copied next to the video as `<spec>--<test>[.failed].keyframes/NN-<label>.png`, and `artifacts/e2e-videos/manifest.json` lists every test with its status, errors, videos and keyframes in order. The feature verification stage feeds them to the automation agent when a test fails and to the automation verifier, which checks that the screen matches each case. When you debug a failing test yourself, read the manifest and open the `failure` and `step failed` frames before changing code. Use `captureKeyframe(label)` from `e2e/fixtures.ts` for a moment that isn't a step.

## When this is required

Whenever your change affects anything a user can see or do in a browser: new pages, buttons or forms, or changed behavior in an existing flow. Skip it (and say why in your summary) for backend-only, docs-only or pure refactor changes.

## Workflow

1. **Start the application in a known state.** Use the test stack, so the data in the video is deterministic:

   ```bash
   factory teststack up --scenario <scenario>   # add a scenario under .factory/stack/scenarios/ if the flow needs new data
   ```

   `factory teststack --help` lists the other commands (`load`, `reset`, `validate`, `down`); `docs/test-stack.md` in the factory explains scenarios, slots and container runtimes.

2. **Walk the flow once with `playwright-cli`** (see the `playwright-cli` skill) to discover stable locators. Prefer roles, labels and text over CSS. The stack's URLs are printed by `factory stack info --slot 0`.

3. **Cover the flow with an e2e test.** For a new feature, add a spec where the repository keeps its test-stack specs (the globs in `prVideo.specPatterns`, usually `e2e/teststack/<feature>.spec.ts`); it loads its scenario in `beforeAll` with `loadScenario('<scenario>')` from `e2e/teststack/scenario.ts`. Extending an existing spec is fine too. Build URLs from `e2e/teststack/ports.ts` (`BASE_URL`, `url(name)`, `port(name)`), never from literal ports, so the spec runs on any stack slot. To make the video read like a demo, import `test` and `expect` from `e2e/demo.ts` and use the `demo` fixture:
   - One `demo.chapter(title, description)` per acceptance criterion or step of the flow.
   - No narration: in the pipeline the demo-narrator agent writes the headline demos' script from the recorded steps, and the other videos get automatic subtitles worded from accessible names and roles. Use accessible locators so the step list names things as a person would.
   - `demo.caption(text)` only for a video you hand over yourself outside the pipeline (it replaces that step's automatic line; `''` clears it). Plain words, never a raw URL or selector.
   - After each step, `expect(...)` the result, then `demo.highlight(locator, label)` the element that proves it worked.
   - Without the fixture, wrap steps in `test.step('...')`: each step ends with a keyframe.
   - Cover the happy path first, then important edge or error cases as separate tests; each test gets its own video. Keep each one under about 60 seconds.

4. **Run it:**

   ```bash
   E2E_KEEP_VIDEOS=1 npx playwright test -c playwright.teststack.config.ts <feature>
   ```

   Use the repository's own command when its addendum or `precheck.testRunners` names a different one. It must pass. If it fails, open the failing test's keyframes (listed in `artifacts/e2e-videos/manifest.json`) and, if needed, the `.failed.webm` and the trace. Fix the feature or the test, and run again.

5. **Report it.** In your final summary to the user:
   - Embed each relevant video with Markdown using its absolute path, for example `![Add to cart](/path/to/repo/artifacts/e2e-videos/scenarios/add-to-cart--a-shopper-adds-a-product.webm)`.
   - Say what each video demonstrates and the scenario or data used.
   - In a PR description, include the same list and the command to reproduce the videos. Commit the tests, never the videos. With the `demoVideo` feature, the pipeline records every changed spec that matches `prVideo.specPatterns` on this machine before the PR opens (never in CI) and adds the narrated videos to a **Demo video** section of the description, so a UI spec in the change is what puts a demo on it. Backend-only PRs get an **API changes** section instead.

## Demo API (`e2e/demo.ts`)

| Call | Effect |
| --- | --- |
| `demo.chapter(title, description?, ms = 2500)` | Full-screen title card. Blocks for `ms`. |
| `demo.caption(text)` | Sticky caption at the bottom; replaces the previous one. `''` clears. |
| `demo.highlight(locator, label?, ms = 2000)` | Scrolls the element into view, waits for its entrance animations, outlines and labels it, records a `highlight:` keyframe and holds for `ms`. |
| `demo.absent(anchor, label, ms = 2000)` | For a state where something must not be shown: scrolls to where it would be (`anchor`), marks it with a dashed red outline and the label, records an `absent:` keyframe and holds. |
| `demo.type(locator, text)` | Click and type with a visible per-key delay. |
| `demo.pause(ms = 1000)` | Give the viewer time on a busy screen. |

## Rules

- **Every UI test case shows the state it asserts.** Bring its distinguishing element into view and mark it with `demo.highlight(locator, label)` (it scrolls the element into view, waits for entrance animations such as scroll-reveal, outlines it and holds it on screen); for an absent state, mark where the element would be with `demo.absent(anchor, label)`. After a click or a navigation, highlight the result. A test that only asserts produces a one-second video of the top of a page. Feature verification refuses a UI case with no `highlight:` or `absent:` keyframe (`precheck.requireUiEvidence`), and its verifier reports what each case's keyframe shows.
- **The shared e2e files are kept in step by `factory render`.** `e2e/fixtures.ts`, `e2e/demo.ts` and `e2e/video-reporter.ts` are refreshed on every render while they match a version the factory shipped; a copy the repository edited is kept, and render and `factory check` show its difference from the factory's version. Do not edit them in a story: change the factory instead.

- Every spec imports `test` and `expect` from `e2e/fixtures.ts` (or from `e2e/demo.ts`, which extends it), never from `@playwright/test`. The base `page`/`context` fixtures are always recorded. The shared fixture also records contexts a test opens with `browser.newContext()`, such as one per user in multi-user flows, with one video per page. Contexts opened in `beforeAll`/`afterAll` are setup and are not recorded, so put the flow you want on video inside the test.
- API-only tests (only the `request` fixture) have no browser and produce no video. That is expected. For a user-facing feature, cover the flow in the UI as well.
- Sign in as users the scenario seeds; never create accounts in the test just to have someone to sign in as.
- Wait on `expect(...)`, not on `waitForTimeout`. Use `demo.pause` only for pacing.
- Don't commit anything under `artifacts/`.
