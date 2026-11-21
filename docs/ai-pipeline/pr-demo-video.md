# PR demo videos

Part of the [AI development pipeline](README.md). Pull requests that change the frontend get a **Demo video** section in their description: the videos of the e2e specs they add or change, recorded on the [test stack](../test-stack.md), slowed down to a pace a person can follow, with a drawn mouse, a subtitle for every step and spoken narration. Reviewers see the feature working without checking out the branch, and the [PR check](pr-check.md#videos)'s video critic reads the same videos. Pull requests that change only the backend get an [API changes](#api-changes-backend-only-prs) section instead.

**Videos are produced on the machine that runs the pipeline, never in CI.** Recording, narration and rendering are local; the harness then uploads the finished files through the code host and writes the section into the PR body when the PR opens. The CI demo-video workflow of earlier versions is gone: `factory render` removes `factory-pr-demo-video.yml` (and the demo-video jobs of single-file CI systems) from repositories that had it.

## Turning it on

1. Run `factory init --with demoVideo` (or set `"demoVideo": true` under `features` in `.factory/factory.json`) and `factory render`. Render writes and keeps in step the shared Playwright pieces: `e2e/fixtures.ts`, `e2e/demo.ts` and `e2e/video-reporter.ts` (another folder: `e2e.dir` in `.factory/config.json`). A copy the repository edited itself is kept: render and `factory check` show its difference from the factory's version instead of overwriting it.
2. Run `factory video install` once on every machine that runs the pipeline. It creates a Python virtualenv in the factory's machine cache with the narration packages at pinned versions and downloads the Kokoro model files, checked against their pinned size and SHA-256 ([toolchain](#toolchain-and-licences)). `factory video status` shows what is installed, which ffmpeg is used, whether narration is on, and the licence of each item. Without it the video is still produced when an ffmpeg is on `PATH` (or set in `video.ffmpeg`): silent, with subtitles, and the PR says so.
3. Set `prVideo` in `.factory/config.json`:

   | Key | Default | Meaning |
   | --- | --- | --- |
   | `specPatterns` | `[]` | globs of the e2e specs whose recordings demo a PR, for example `["e2e/teststack/*.spec.ts"]`. Empty: no spec is ever picked |
   | `videosDir` | `artifacts/e2e-videos` | where the Playwright reporter writes the raw videos, the step logs and `manifest.json` |
   | `storageBranch` | `pr-videos` | the branch the published videos are stored on |
   | `recordCmd` | `npx playwright test -c playwright.teststack.config.ts --project scenarios --no-deps --timeout 900000 {specs}` | how the specs are run in demo mode (`{specs}`: the changed spec files) |
   | `slotWaitSec`, `localTimeoutSec` | `3600`, `5400` | how long to wait for a free test-stack slot, and for the whole local step |
   | `testTimeoutSec` | `900` | the shortest timeout a test gets in demo mode: a spec's own `test.setTimeout` or `describe.configure({ timeout })` cannot cut a recording short |
   | `backendPaths` | `[]` | globs of backend code. Empty: the paths of every service in `project.services` whose `kind` is not `frontend` |
   | `neutralPaths` | `[]` | globs that count as neither frontend nor backend (application wiring, shared defaults) |
   | `api.extractor`, `api.sources`, `api.exclude`, `api.openapi` | `null`, `[]`, `[]`, `[]` | where the [API changes](#api-changes-backend-only-prs) section reads endpoints from |

4. Optional: `video` in `.factory/config.json`:

   | Key | Default | Meaning |
   | --- | --- | --- |
   | `narration.enabled` | `true` | speak each step; `false`: silent videos with subtitles |
   | `narration.voice`, `narration.speed`, `narration.lang` | `af_heart`, `1.0`, `en-us` | the Kokoro voice, speaking speed and language |
   | `narration.model` | `int8` | `int8` (quantized, about 90 MB); the full model is not pinned yet |
   | `pacing.stepDelayMs`, `pacing.holdMs`, `pacing.typeDelayMs`, `pacing.cursorMs` | `700`, `1500`, `90`, `600` | while recording: the pause before each step, the hold after each visible change, the delay between typed characters, and how long the cursor takes to reach its target |
   | `pacing.pauseMs` | `600` | in the rendered video: the pause after each narrated line. A step lasts as long as its line is spoken plus this pause (its reading time when silent); a longer recorded stretch (a slow load, a long hold) is cut down to that, keeping its start and its end |
   | `size.width`, `size.height` | `1280`, `720` | the recording size and viewport in demo mode |
   | `ffmpeg` | the pinned one | a path to the team's own ffmpeg build |
   | `licenceReview` | `default` | `strict` turns narration off while any of its licence items is pending review |
   | `critic.framesPerStep`, `critic.maxFrames` | `1`, `24` | how the PR check's video critic samples a rendered video |
   | `script.scope` | `headline` | which videos the `demo-narrator` agent writes a script for: `headline` (the [headline demos](#headline-demos-and-evidence)), `all`, or `none` (every video keeps the automatic lines) |
   | `script.model` | `null` | the narrator's model; `null`: `agent.models.narrator`, else the test-automation model (`agent.models.automation`) |
   | `script.timeoutSec`, `script.maxSegments`, `script.maxSegmentChars`, `script.maxOpeningChars`, `script.maxCloseChars`, `script.maxTotalChars`, `script.minWordsPerAction` | `600`, `16`, `280`, `240`, `200`, `2400`, `5` | the narrator's time limit and the script's length limits ([validation](#narration-scripts)) |
   | `script.speakEvidence` | `false` | evidence videos are subtitled with the automatic lines and silent; `true` narrates them aloud too |
   | `bugPair.enabled` | `true` | a UI bug gets a [before and after pair](#bugs-before-and-after-the-fix) |
   | `apiEvidence.enabled` | `true` | a backend bug gets its [requests before and after the fix](#backend-bugs-the-requests-before-and-after-the-fix) |
   | `apiEvidence.headers` | `["content-type", "location", "allow", "retry-after", "accept"]` | the request and response headers shown; credentials are masked by name whatever this lists, other headers are left out |
   | `apiEvidence.maxBodyBytes`, `apiEvidence.maxPairs` | `1500`, `3` | a body is cut at this size (the cut says how many bytes were not shown); request pairs shown per bug in the PR, the rest collapsed |
   | `bugPair.requireBefore` | `false` | `true`: a UI bug whose reproduction cannot be shown before the fix opens no PR (the delivery escalates with the reason) instead of a note and a finding |

## Writing a demo spec

Write the spec as a normal Playwright test with `test` and `expect` from `../demo` (`import { test, expect } from '../demo'`) that takes the `demo` fixture (`async ({ page, demo }) => ...`), driving the page with user actions on accessible locators. Nobody writes narration in the spec: the headline demos are narrated from the [narrator's script](#narration-scripts), written from the recorded steps; the other videos get automatic lines. In demo mode (`E2E_DEMO=1`, set by the local step) the `demo` fixture records the step log the script is bound to and writes the automatic lines:

- **An opening line** on what the video demonstrates, from the test's title and its ticket ("This video shows selecting the Daybird card opens the catalog filtered to Daybird. Ticket BRAND-2: From a brand card to that brand's products."; the ticket titles come from the ticket cache), and **a closing line** with the outcome.
- **Every user action**: navigation ("Open the Brands page", "Reload the Brands page, with sort count"), clicks ("Click the Daybird card", "Click the Brands link"), typing ("Type “Daybird” into the Search field"; "Type the Password (hidden)" for a secret field), choices ("Choose “Most products” in the Sort list"), ticks and key presses. Raw `page.goto` and `locator.click/fill/selectOption/check/press` calls are narrated, paced, drawn with the cursor and masked like the fixture's own `demo.click` and `demo.fill`.
- **The assertions a viewer can see**, said with the next step: `toHaveCount` ("13 cards are shown"), `toHaveText`/`toContainText` ("“11 products” is shown"), `toBeVisible`/`toBeHidden`, `toHaveURL` ("Now on the home page, with brand 1"), `toHaveValue`, `toBeChecked`, `toBeDisabled`, and `toHaveClass` with a state word ("is marked active").

The words come from accessible names, labels, headings and roles, never from selectors or raw URLs; a path in a caption reads as a page name. One step gets one line: a caption the spec writes that says what a waiting assertion line says ("Now at the home page, with brand 1" after `toHaveURL`) replaces it. A caption the spec writes takes precedence for its step: `demo.caption(text)` right before an action narrates that action instead of the automatic line, right after it replaces that action's automatic line; `demo.click(locator, caption)` and `demo.fill(locator, value, { caption })` set the line of their own action; a `demo.highlight(locator, label)` label narrates the check it shows. Add one only where the automatic line would not explain the step to a viewer. `demo.chapter` and `demo.absent` work as before. At test speed (feature verification, CI) nothing is narrated and the calls run without pauses. Use the repository's allow-listed placeholder values for passwords and tokens; never a real one.

Only a passing test is a demo: the recording of a test that failed in demo mode stays on the machine as evidence for agents (its raw video and keyframes under `videosDir`) and is never narrated, rendered or published; the section lists it as not published. The one exception is a UI bug's [before-the-fix recording](#bugs-before-and-after-the-fix), which must fail, at exactly its reproduction check.

The step log (`<video>.steps.json`) holds, for every user action, its target's accessible name and role, the page and main heading before and after, and three times: when the cursor set off, when the action happened, and when its result had settled; every visible assertion that passed, in viewer words; and, when the test failed, where (an assertion, with the line it expected and what the screen showed instead, or an action or navigation). In demo mode the fixture draws no narration caption into the recording: the renderer draws the subtitles, timed to the voice.

## Headline demos and evidence

The **headline demos** are what a reader of the PR watches: the main happy-path case of each story in the PR and an epic's journey case, plus a UI bug's before/after pair. A plan's headline is a case marked `demo: headline` in its front matter, else its main happy-path case: the `e2e` case of type `happy` with the highest priority, then the one covering the earliest acceptance criterion (the story's core: AC1 before AC3), then the one covering most criteria, then the lowest id (an epic's plan is a plan like any other, so its main journey case is its headline). With `video.script.scope: "all"` every video is narrated from a script.

The other test-case videos are **evidence**: recorded and rendered the same way, subtitled with the automatic lines, silent by default (`video.script.speakEvidence`), and listed in a collapsed *Evidence* block under the headline demos.

## Narration scripts

Before the PR opens, the local step gives the `demo-narrator` agent (one run for every headline video of the PR, on `video.script.model`) the ticket (title and acceptance criteria from the ticket cache), each case's title, what it covers and why it matters, and each recording's step list (every user action with its target and what changed on screen, every highlight and passed check, with times). Everything it is given went through the redaction boundary. It answers with a script per video: an **opening** that sets the scene from the ticket, a **walk** of segments of whole sentences, each bound to a range of recorded steps, and a one-sentence **close** on the outcome, written as prose for a product manager in the product's own words. It is counted and costed like any other stage (`stage: "demo-narration"` in the usage records).

**Validation**, before anything is rendered: every user action is inside a segment, segments follow the step order and never share a step, every step id exists, every quoted phrase and every capitalised name comes from the ticket, the case or the recorded steps, the length limits hold, the text is whole sentences, and nothing banned appears: selectors, raw URLs, paths or query strings, test-case ids or ticket keys, testing vocabulary (assert, expect, verify, test, spec), counts read out as bare facts ("13 cards are shown."), markup or redaction markers, or anything the secret detector or the generic credential pattern flags. A script that fails goes back once with the errors (only the failing videos); a second failure, an unavailable agent (no CLI, an outage, a time-out) or `scope: "none"` leaves the video on the automatic lines, and the section lists under *Automatic narration* which headline videos used them and why.

**Timing.** The video follows the script, re-timed from the one recording rather than recorded a second time, script-paced: one recording keeps the stack time and the risk of a run that differs from the first out of the step, and the step log already marks, for every action, when the cursor set off, when it acted and when the result settled. For each segment, its line is spoken from the segment's start; the recorded moments it narrates (cursor set-off to settled result, highlights) play at recorded speed, spread across the sentence: after each one its settled frame is held for an equal share of the remaining time, so the action happens as it is described and its result is on screen while the sentence ends. Waits and checks with nothing to see are cut. A moment longer than 4.5 s (a slow load) keeps its start and its end. A segment lasts its spoken line plus `pacing.pauseMs` (or longer, when its moments need it), so there is no dead air between thoughts and no line is cut off. The opening, when it names no step, plays the first page's load and holds it.

**Subtitles.** The cues come from the same timeline as the voice: one cue per segment, from its start to its end, so every cue lasts until its line has been spoken plus the pause. The renderer draws them into the video (libass, the `ass` filter of the pinned ffmpeg) from the same cues it writes to the `.vtt`. In 0.2.88 the fixture drew each caption into the recording at the recorded time, and the renderer held the step's *last* frame for its audio: the opening line was drawn for 1.5 s while its 12.9 s line was spoken, and the held frame already showed the next page. The quality gate reads the `.vtt` back and checks, for every cue, that it ends at least 0.25 s after its line's audio ends, that it does not overlap the next cue, and that the next cue does not start before the line has been spoken.

## Bugs: before and after the fix

A **UI bug** (a bug ticket, by its cached type, whose verified plan has a browser case that a changed spec runs, in a change that touches the frontend) gets two headline videos of the case that reproduces it, made by the same recorder, narrator, pacing, subtitles and gates. Which case that is, is found by running the bug's browser cases on the base: the first, in order (a `demo: headline` case, then by priority, sad paths before happy paths, most criteria covered, lowest id), that fails there at its check and passes on the fix; a bug's happy-path case usually passes on the base too, so it is never assumed. When none does, the section lists each case's reason.

- **Before the fix**: the bug's regression flow recorded against the application built from the merge base of the fix branch. The base is checked out once per commit (`.factory/state/demo-base/<sha>`, a git worktree), and its stack images are tagged with that commit, so a re-run on the same slot does not rebuild and the fixed branch's images are never replaced. Its stack comes up on the step's own slot first, the specs of the bugs run with `--grep` on their cases, and the stack goes down before the fixed branch's comes up. Its recording time is a `demo-recording` row (`side: "before"`) in `run-conditions.jsonl`, next to the branch's own (`side: "after"`).
- **After the fix**: the same case's recording on the fixed branch.

The before recording is the one failed test that may be published, and only when the harness has verified that it failed **at the reproduction check**: at an assertion (not an action, a navigation, a time-out or setup), after the same actions as the after run took, at a check the after run passes at the same point, on a stack that answered its readiness check after the run. Otherwise there is no before video: the section says exactly why ("the bug does not reproduce on the base: the reproduction check passed before the fix", "the before run failed at an earlier step (the click action after 1 action(s))", ...), and the local step's result carries a finding (`DEMO-NO-REPRO-<KEY>`) for the run. It does not hold the delivery unless `video.bugPair.requireBefore` is `true`, in which case no PR opens and the reason goes on the ticket.

One narrator run writes both scripts as a pair: the before video says what the user tried, what they did and what went wrong, as the problem the customer saw (it is given what the screen actually showed at the failing check, never the expected value, and a script that states the expected value as what happened fails validation); the after video walks the same steps with the same words, now working. Without a script the before video's automatic lines open with "Before the fix", say what the screen showed instead at the failing step, and close on "That is the problem this change fixes."

In the section each UI bug comes first, under its ticket (`### FIX-7: ...`), with **Before the fix** and **After the fix** (or why the before video could not be shown), then the other headline demos, then the evidence. A group or epic PR of several UI bugs gets one such pair per bug, each under its ticket. A backend-only bug gets no demo video, and the section says so.

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

After every agent stage of a story (or an epic or bug-epic group) is done and CI has proven the head, and before the PR opens, the delivery runs `factory pr-video local --base <base> --key <branch> --head-sha <head>` in the story's worktree:

1. `changedSpecs` and the change's scope decide whether there is a video, a note ("no spec changed") or nothing.
2. A test-stack slot of its own is leased (never slot 0, which may run another checkout's code), the stack comes up, and the changed specs run in demo mode with the factory's secret detector (`E2E_REDACT_MODULE`), then the stack goes down and the slot is released.
3. The headline demos' scripts are written by the `demo-narrator` agent and validated ([Narration scripts](#narration-scripts)). Each passing test's video (and each verified [before-the-fix](#bugs-before-and-after-the-fix) recording) is rendered (`scripts/pr-video/lib/render.mjs`) from its script, or from the automatic lines: each segment is narrated (headline demos) or only subtitled (evidence), the video is re-timed to the script, the regions the fixture covered are drawn over the recorded frames for their whole time window, the subtitles are drawn into the video and written as a `.vtt` from the same cues, and the [secret gate](#secrets-never-show) runs. ffmpeg muxes the audio (Opus) and the video (VP8) into a WebM; an animated GIF preview is made when it stays under 9 MB. Then the **quality gate**: the video opens with its opening line, every user action in the step log is narrated, there is an audio stream when narration is on, the subtitles are drawn into the video, every cue in the written `.vtt` lasts until its line has been spoken (plus 0.25 s) and never overlaps or cuts off the next, no line repeats the one before it, the cues add up to the video's length, and the secret gate passed. A video that fails it is not published, and its entry in the section says why. The report (`<name>.report.json`) lists every line with its role, start, end, audio length and the steps it narrates, who wrote it (`narrator.by`: `agent` or `automatic`, and why) and the gate's result.
4. The rendered videos, their subtitles and `section.md` (stamped with the head) are pushed to the storage branch under the branch's folder (`branch-<branch>`), through the code host's git remote; the links come from the host adapter (`fileUrl`). The delivery reads the section back by head and writes it into the PR body once, at the open. Nothing here runs an agent or opens a PR, and a failure never holds the delivery: the PR opens without the section and the run log and `<state>/pr-check/<id>-demo-video.json` say why. The step writes its outcome, or the error that stopped it, to a result file the delivery names (`--result`); the record keeps that error and the tails of the step's stderr and stdout, never a line another tool printed.
5. The [API changes](#api-changes-backend-only-prs) section of a backend-only change is stored the same way (`pr-video api --key`).

The rendered files also stay on the machine, in `.factory/state/demo-videos/<folder>/` (never committed), with a `<name>.report.json` per video: duration, number of steps and covered regions, narration voice or why it was off, and the secret check.

Uploading uses the storage branch for every host rather than a host's attachment upload (`pr.uploadAttachment`, which GitHub and Bitbucket do not offer and which needs a PR): the body must already carry the links when the PR opens.

### Secrets never show

No secret may be visible or audible in a video:

- **Captions, subtitles and narration** go through the redaction boundary (`scripts/pipeline/lib/redact.mjs`) before they are drawn, written or spoken: by the fixture when it logs them, again by the renderer before narrating and writing the `.vtt`.
- **The narrator** is given only redacted text (the step list is built from the redacted step log and redacted again; the ticket and the case too), and its script must pass the secret detector and the generic credential pattern; a script that holds a secret anyway is refused, sent back once (the errors name the rule, never the value) and replaced by the automatic lines. The canary proof below covers the step list, the script, the subtitles and the spoken text.
- **Automatic narration**: every automatic line (actions, page names, assertion lines) is made from text the detector has already redacted, and redacted again before it is drawn, written or spoken; a query value or path segment that could be a credential is read as "a hidden value" or left out; a typed secret is "(hidden)". The canary proof below covers it.
- **Typed values**: a value typed into a password, token, key or secret field (input type, name, id, label, placeholder, autocomplete, or `{ secret: true }`) is covered on screen from before the first character, and shown as dots in its caption.
- **On screen**: at every step (and after every navigation) the fixture reads the page's visible text (text runs, input values, the URL with its query string, toasts, error pages), runs the same detector, and covers every matching element for as long as it is visible; the URL caption is redacted. The renderer draws the same boxes over the recorded frames for their whole window (plus half a second each side).
- **Fail closed**: after rendering, the gate re-checks the subtitles, the narration text, every caption and the per-step visible-text log, with the detector and the generic `<credential word>[:=]<value>` pattern. A match, or a match the fixture saw but could not cover (no box: canvas, image, a closed shadow root), and the video is not published: its entry in the section says "Not published" and why (the rules, never the value).
- **Proof**: `scripts/pr-video/test/demo-secrets.test.mjs` records a fixture app that shows a canary token in a field, in page text, in the URL and on an error page, and asserts that the canary is in none of the subtitles, the narration text or the visible-text log, and that the covered regions hide the canary's boxes in the rendered frames.

Keyframes (the screenshots feature verification keeps for agents) are evidence for the pipeline, not published, and are not masked.

### Narration

Narration is spoken locally with [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) (Kokoro-82M on ONNX Runtime, CPU; a sentence takes about a second) and written with soundfile (`scripts/pr-video/narrate.py`). With narration off, the toolchain missing, or `video.licenceReview: "strict"` while an item is pending, the video is still produced, silent with subtitles, and the section says so ("silent with subtitles: …").

### The PR check reads frames per step

The [PR check](pr-check.md#videos)'s video critic reads frames, and slower videos must not multiply its cost: when a video has subtitles next to it (`<name>.vtt`, downloaded with a linked video) or a step log (`<name>.steps.json`, a local recording), it samples one frame from the middle of each step (`video.critic.framesPerStep`), capped (`video.critic.maxFrames` and the check's own `maxFrames`). Other videos keep the interval sampling.

## Toolchain and licences

`packs/video/tools.json` pins everything; `factory video status` prints each item with its licence, using the same allowlist as static analysis (`scripts/pipeline/lib/analysis/licences.mjs`). Decisions taken when this was built (final round, 2026-11-20):

| Item | Version or source | Licence | Decision |
| --- | --- | --- | --- |
| kokoro-onnx | 0.6.1 (pip, exact version) | MIT | allowed |
| Kokoro-82M weights, `kokoro-v1.0.int8.onnx` | release `model-files-v1.0`, SHA-256 pinned | Apache-2.0 | allowed |
| `voices-v1.0.bin` | release `model-files-v1.0`, SHA-256 pinned | not stated separately on the kokoro-onnx release (Kokoro-82M is Apache-2.0) | `licenceReview: "pending"` |
| soundfile | 0.14.0 (pip) | BSD-3-Clause | allowed |
| libsndfile (bundled in the soundfile wheel) | as shipped | LGPL-2.1-or-later | `pending`; loaded unmodified, never redistributed by the factory |
| imageio-ffmpeg | 0.8.1 (pip) | BSD-2-Clause | allowed |
| ffmpeg (bundled in the imageio-ffmpeg wheel) | 9.0 as shipped | GPL-3.0-or-later (built with `--enable-gpl`) | `pending`; run as a separate unmodified program, never linked or redistributed; a team may set `video.ffmpeg` to its own (for example LGPL) build |
| phonemizer, espeak-ng (dependencies of kokoro-onnx) | as resolved by pip | GPL-3.0 | `pending`; used in the narration process only |
| onnxruntime | as resolved by pip | MIT | allowed |

Why these choices:

- **ffmpeg from a pinned pip wheel**: one pinned source for every platform the factory runs on, installed by the same command as the narration, with no package manager. The factory does not ship ffmpeg; pip fetches the upstream wheel on the user's machine. The wheel's binary is a GPL build, so it is marked for review like the other lawyer items; a team with an LGPL build points `video.ffmpeg` at it.
- **Python runtime**: the factory already needs Python 3 for the architecture policy pack. Narration gets its own virtualenv in the machine cache (`<cache>/tools/video-1/venv`, the first Python 3.10 to 3.13 found, or `FACTORY_PYTHON`), so its packages never touch the policy pack's environment or the app's. Packages are pinned by exact version (their transitive dependencies are resolved by pip and recorded in `installed.txt` for an audit); the model files, the large downloads, by size and SHA-256.
- **The licence allowlist** gets no new licence: the pending items run by default with a warning (the owner's rule for lawyer items), and `video.licenceReview: "strict"` turns narration off.
- **Pacing in the fixture, timing in the renderer**: the recording is slowed by the fixture (so the drawn cursor and typing are visible), and the renderer re-times it to the script, so the voice and the picture never drift apart, whatever the TTS speed.
- **Subtitles drawn by the renderer** (libass, in the pinned ffmpeg build), from the cues it also writes to the `.vtt`: text drawn into the recording follows the recording's timing, which the re-timing changes. The drawn cursor, highlights and covers stay in the recording (Playwright's screencast overlays, which never touch the page's DOM or the test's locators). A team's own ffmpeg needs libass; without it the gate keeps the video unpublished and says why.

## Backend bugs: the requests before and after the fix

A **backend bug** (a bug ticket whose reproduction case, an `e2e` case of its verified plan in a changed spec, drives the service through its public interface) gets its evidence captured on the test stack, never written from memory. A bug whose defect is also visible in a browser gets this and its [video pair](#bugs-before-and-after-the-fix).

- **Recording.** The spec wraps the requests that show the bug, and the assertion of the fixed behaviour, in `reproduction(label, fn)` from the shared `e2e/fixtures.ts` (the `request` fixture records each exchange with `E2E_API_LOG=1`: method, path and query, request headers and body, status, response headers and body, duration, and the reproduction's label; an assertion that fails inside the block is recorded as the failed reproduction check). This builds on the API log the [API changes](#api-changes-backend-only-prs) section already uses; there is no second mechanism.
- **Before and after**, sharing the video pair's base build, slot and checks: the bug's cases run against the application built from the merge base, where one must fail **inside its reproduction**, after calls the fixed run makes too, on a healthy stack, and against the fixed branch, where it passes. The first case, in order (priority, sad paths first, most criteria covered, lowest id), that does so is the reproduction. A backend-only change runs only these cases (nothing is filmed). Otherwise there is no before evidence: the section says why for each case, the step's result carries a finding (`API-NO-REPRO-<KEY>`), and it holds the delivery only with `video.bugPair.requireBefore`.
- **On the ticket**, before the PR opens: one **Reproduction** comment, posted through the tracker contract and edited in place on every delivery (found by a hidden marker): the preconditions in words, then numbered steps, each request as a copyable block (method, path, the headers that matter, body), the response it got on the base (status, the headers that matter, body) and one line on what is wrong with it. The requests and responses are inserted verbatim by the harness from the recording. The wording (preconditions, steps, what is wrong, what changed) comes from the `demo-narrator` agent, in the same run's records (`step: "reproduction steps"`); prose that quotes a status, body text or value the recording does not hold, a host, a ticket key or anything the secret detector flags is refused, sent back once, then replaced by plain wording made from the recording alone.
- **In the PR**, in the demo section after any videos: **Before the fix / After the fix**, under each bug's ticket: each request, then its response before the fix and after the fix, and one line on the difference that matters; the reproduction's failing call first, at most `apiEvidence.maxPairs`, the rest collapsed.
- **Records**: the exchanges (cleaned) are kept in `.factory/state/demo-videos/<folder>/<KEY>.api-evidence.json` with the comment's text (`<KEY>.reproduction.md`), and an `api-reproduction` row (requests and statuses) in `run-conditions.jsonl`; the before run's time is its `demo-recording` row.
- **Safety and size**: every exchange passes the redaction boundary before it is stored, posted or committed; `Authorization`, cookies and any header or JSON field whose name says token, key, secret, password, session or credential are masked by name (`(masked)`), whatever the value; bodies are redacted by the detector and cut at `apiEvidence.maxBodyBytes` with the byte count stated; only allow-listed headers are kept; a URL keeps its path and query, never its host. The comment and the section are scanned again before they are posted (a hit: not posted, and the PR says why). Both go through the code host's and tracker's refusal handling, and no field name such as token or password is ever placed before a hash-like value (masked values are words).

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
- **Examples**: real calls the changed specs made through Playwright's `request` fixture. The local step runs the specs with `E2E_API_LOG=1`, so the factory's `e2e/fixtures.ts` attaches each call (method, URL, request headers and body, status, response body) and `e2e/video-reporter.ts` adds them to `manifest.json`. The section shows up to three examples per endpoint. `Authorization`, cookie and API-key headers and JSON keys that look like secrets (password, token, secret, API key) are redacted, and bodies are truncated.

Endpoints the specs called but the PR did not change are listed as *Exercised*, which covers changes inside services the route diff can't see. For a backend-only change the local step does not start the stack: the section is built from the route extractor and the OpenAPI files in the repository, without example calls. The section is removed when there is nothing to show.

## Storage

Videos live on the storage branch (`pr-videos`), which is rewritten as a single parentless commit on every publish, so replaced videos don't build up in history. Links come from the code host's adapter (GitHub: `github.com/<repo>/blob/pr-videos/...`, which works for private repositories too; previews use `?raw=true`, and the PR check downloads the files with its token). A branch's folder stays after its PR is merged, as a record of the feature; `factory pr-video cleanup --key <branch>` removes it (there is no CI job left to do it when a PR closes unmerged).

## Running it by hand

```bash
factory video install                      # once per machine
factory video status
factory pr-video specs --base origin/main
factory pr-video scope --base origin/main  # frontend/backend/video/api
factory pr-video local --base origin/main --key feat/my-branch --head-sha "$(git rev-parse HEAD)"
factory video render artifacts/e2e-videos/scenarios/<spec>--<test>.webm   # one recording, as the delivery renders it
factory pr-video embed --key feat/my-branch --pr 123 --head-sha "$(git rev-parse HEAD)"   # write the stored sections into an already-open PR
factory pr-video cleanup --key feat/my-branch
```

`local` and `cleanup` need push access to the repository.
