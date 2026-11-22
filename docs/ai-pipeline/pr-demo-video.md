# PR demo videos

**Who reads this:** B (turning it on) and C (reading what a PR got and why). Pull requests that change the
frontend get a **Demo video** section: the videos of the e2e specs they add or change, recorded on the
[test stack](../test-stack.md), paced for a person, with a drawn mouse, subtitles and spoken narration.
Pull requests that change the backend get an **API changes** section. Bug fixes also get evidence that the bug
existed: a before and after video for a UI bug, the requests before and after the fix for a backend bug.
Reviewers see the change working without checking it out, and the [PR check](pr-check.md#videos)'s video critic
reads the same videos.

Everything is produced on the machine that runs the pipeline, after CI has proven the head and before the PR
opens; no CI job records videos. `factory render` removes the demo-video job older releases generated.

## Which PRs get what

`factory pr-video scope --base <ref>` sorts the PR's changed files with the project model:

- **Frontend**: a file matching `project.frontendPaths`, or in the paths of a service with `"kind": "frontend"`.
- **Backend**: any other file under `prVideo.backendPaths`, or, when that is empty, in a service of another kind;
  never a file matching `prVideo.neutralPaths`.
- Files in neither (tests, e2e specs, docs, CI) count as neither.

| PR changes | Demo video | API changes |
| --- | --- | --- |
| Frontend only | ✅ | ❌ |
| Frontend and backend | ✅ | ✅ |
| Backend only | ❌ (the section says so) | ✅ |
| Neither | ❌ | ❌ |

On top of that, a **UI bug** gets its [before and after videos](#bugs-before-and-after-the-fix) and a
**backend bug** its [requests before and after the fix](#backend-bugs-the-requests-before-and-after-the-fix).
A bug whose defect is visible in a browser and through the API gets both. Sections that no longer apply (after a
later push) are removed, along with their stored videos.

## Turning it on

1. `factory init --with demoVideo` (or `"demoVideo": true` under `features` in `.factory/factory.json`), then
   `factory render`. It writes the shared Playwright pieces: `e2e/fixtures.ts`, `e2e/demo.ts` and
   `e2e/video-reporter.ts` (another folder: `e2e.dir`). A copy the repository edited is kept, and `factory
   check` shows its difference.
2. `factory video install` once on every machine that runs the pipeline: the narration packages and the Kokoro
   model files, pinned ([toolchain](#toolchain-and-licences)). `factory video status` shows what is installed.
   Without it the video is still produced when an ffmpeg is found, silent with subtitles, and the PR says so.
3. Set `prVideo.specPatterns` in `.factory/config.json` to the specs whose recordings demo a PR, for example
   `["e2e/teststack/*.spec.ts"]`. The other settings are in [Settings](#settings).

Write specs with the `demo` fixture ([Writing a demo spec](#writing-a-demo-spec)); the
[`feature-demo-video`](../../skills/feature-demo-video/SKILL.md) skill walks an agent through it.

## How it works

After every agent stage of a story (or an epic or bug-epic group) is done and CI has proven the head, and before the PR opens, the delivery runs `factory pr-video local --base <base> --key <branch> --head-sha <head>` in the story's worktree:

1. `changedSpecs` and the change's scope decide whether there is a video, a note ("no spec changed") or nothing.
2. A test-stack slot of its own is leased (never slot 0, which may run another checkout's code). A bug's reproduction cases run first against the application built from the merge base ([bugs](#bugs-before-and-after-the-fix)); then the fixed branch's stack comes up and the changed specs run in demo mode with the factory's secret detector (`E2E_REDACT_MODULE`). A change with no browser-visible part runs only its backend bugs' reproduction cases, and a backend-only change with no such bug starts no stack. Then the stack goes down and the slot is released.
3. The scripts are written by the `demo-narrator` agent and validated ([Narration scripts](#narration-scripts)). Each passing test's video (and each verified [before-the-fix](#bugs-before-and-after-the-fix) recording) is rendered (`scripts/pr-video/lib/render.mjs`) from its script, or from the automatic lines: each segment is narrated (headline demos) or only subtitled (evidence), the video is re-timed to the script, the regions the fixture covered are drawn over the recorded frames for their whole time window, the subtitles are drawn into the video and written as a `.vtt` from the same cues, and the [secret check](#secrets-never-show) runs before anything is encoded. ffmpeg muxes the audio (Opus) and the video (VP8) into a WebM; an animated GIF preview is made when it stays under 9 MB. Then the **quality gate**: the video opens with its opening line, every user action in the step log is narrated, there is an audio stream when narration is on, the subtitles are drawn into the video, every cue in the written `.vtt` lasts until its line has been spoken (plus 0.25 s) and never overlaps or cuts off the next, no line repeats the one before it, the cues add up to the video's length, and the secret check passed. A video that fails it is not published, and its entry in the section says why. The report (`<name>.report.json`) lists every line with its role, start, end, audio length and the steps it narrates, who wrote it (`narrator.by`: `agent` or `automatic`, and why) and the gate's result.
4. The rendered videos, their subtitles and `section.md` (stamped with the head) are pushed to the storage branch under the branch's folder (`branch-<branch>`), through the code host's git remote; the links come from the host adapter (`fileUrl`). The delivery reads the section back by head and writes it into the PR body once, at the open. A re-delivery writes it into the refreshed body of the PR that is already open and held instead, and never opens a second one; that PR is found by the skip, resume and reopen routing or, as a fallback, by [one read of the ticket's last PR at plan time](implement.md#resume-and-interrupted-runs). Nothing here opens a PR, and a failure never holds the delivery (the one exception is `video.bugPair.requireBefore`): the PR opens without the section and the run log and `<state>/pr-check/<id>-demo-video.json` say why. The step writes its outcome, or the error that stopped it, to a result file the delivery names (`--result`); the record keeps that error and the tails of the step's stderr and stdout, never a line another tool printed.
5. The [API changes](#api-changes) section is stored the same way (`pr-video api --key`).

The rendered files also stay on the machine, in `.factory/state/demo-videos/<folder>/` (never committed), with a `<name>.report.json` per video: duration, number of steps and covered regions, narration voice or why it was off, and the secret check.

Uploading uses the storage branch for every host rather than a host's attachment upload (`pr.uploadAttachment`, which GitHub and Bitbucket do not offer and which needs a PR): the body must already carry the links when the PR opens.

### Secrets never show

What each check covers, exactly. These checks keep secrets out of the video; the gates that block a write are the record and adapter gates of [analysis.md](analysis.md#secrets-in-records-and-posts-redaction).

- **Captions, subtitles and narration** go through the redaction boundary (`scripts/pipeline/lib/redact.mjs`) before they are drawn, written or spoken: by the fixture when it logs them, again by the renderer before narrating and writing the `.vtt`.
- **The narrator** is given only redacted text (the step list is built from the redacted step log and redacted again; the ticket and the case too), and its script must pass the secret detector and the generic credential pattern; a script that holds a secret anyway is refused, sent back once (the errors name the rule, never the value) and replaced by the automatic lines.
- **Automatic narration**: every automatic line (actions, page names, assertion lines) is made from text the detector has already redacted, and redacted again before it is drawn, written or spoken; a query value or path segment that could be a credential is read as "a hidden value" or left out; a typed secret is "(hidden)".
- **Typed values**: a value typed into a password, token, key or secret field (input type, name, id, label, placeholder, autocomplete, or `{ secret: true }`) is covered on screen from before the first character, and shown as dots in its caption.
- **On screen**: at every step and after every navigation, the fixture samples the page's visible text (text runs by element, input values, the URL with its query string), runs the same detector, and covers every matching element for as long as it is visible; the URL caption is redacted. The renderer draws the same boxes over the recorded frames for their whole window (plus half a second each side). Only page text and input values are read, at those moments: text that appears and disappears between two samples is not seen, and pixels are never read.
- **Fail closed**: before the video is encoded, the check reads the subtitles, the narration text, every caption and the per-step visible-text log, with the detector and the generic `<credential word>[:=]<value>` pattern. A match, or a match the fixture saw but could not cover (no box: canvas, image, a closed shadow root), and the video is not published: its entry in the section says "Not published" and why (the rules, never the value). The finished frames are not scanned.
- **Proof**: `scripts/pr-video/test/demo-secrets.test.mjs` records a fixture app that shows a canary token in a field, in page text, in the URL and on an error page, and asserts that the canary is in none of the subtitles, the narration text or the visible-text log, and that the covered regions hide the canary's boxes in that test's rendered frames.

Keyframes (the screenshots feature verification keeps for agents) are evidence for the pipeline, not published, and are not masked.

### Narration

Narration is spoken locally with [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) (Kokoro-82M on ONNX Runtime, CPU; a sentence takes about a second) and written with soundfile (`scripts/pr-video/narrate.py`). With narration off, the toolchain missing, or `video.licenceReview: "strict"` while an item is pending, the video is still produced, silent with subtitles, and the section says so ("silent with subtitles: …").

### The PR check reads frames per step

The [PR check](pr-check.md#videos)'s video critic reads frames, and slower videos must not multiply its cost: when a video has subtitles next to it (`<name>.vtt`, downloaded with a linked video) or a step log (`<name>.steps.json`, a local recording), it samples one frame from the middle of each step (`video.critic.framesPerStep`), capped (`video.critic.maxFrames` and the check's own `maxFrames`). Other videos keep the interval sampling.

## Headline demos and evidence

The **headline demos** are what a reader of the PR watches: the main happy-path case of each story in the PR and an epic's journey case, plus a UI bug's before/after pair. A plan's headline is a case marked `demo: headline` in its front matter, else its main happy-path case: the `e2e` case of type `happy` with the highest priority, then the one covering the earliest acceptance criterion (the story's core: AC1 before AC3), then the one covering most criteria, then the lowest id (an epic's plan is a plan like any other, so its main journey case is its headline). With `video.script.scope: "all"` every video is narrated from a script.

The other test-case videos are **evidence**: recorded and rendered the same way, subtitled with the automatic lines, silent by default (`video.script.speakEvidence`), and listed in a collapsed *Evidence* block under the headline demos.

## Narration scripts

Before the PR opens, the local step makes one `demo-narrator` run (model `video.script.model`) for all the videos
`video.script.scope` selects, the headline demos by default. It gets the ticket's title and acceptance criteria,
each case's title and purpose, and each recording's step list, all redacted first. It answers with a script per
video: an **opening** from the ticket, a **walk** of whole sentences each bound to a range of recorded steps, and a
one-sentence **close**, written for a product manager.

**Validation**, before anything is rendered: every user action is inside a segment, in order; every quoted phrase
and name comes from the ticket, the case or the recording; the length limits hold; and nothing banned appears
(selectors, URLs, test ids, ticket keys, testing words, bare counts, markup, or anything the secret detector flags).
The videos whose script fails go back together, once, with the errors. A second failure, an unavailable agent or
`scope: "none"` leaves the video on the automatic lines, and the section says which videos used them and why. A PR
therefore costs at most two narrator runs for its scripts, plus at most two for its backend bugs' reproduction steps
([below](#backend-bugs-the-requests-before-and-after-the-fix)), recorded under `stage: "demo-narration"`
([costs.md](costs.md)).

**Timing and subtitles.** The video is re-timed to the script from the one recording: each segment's line is spoken
from its start while the moments it narrates play at recorded speed, each settled result held until the sentence
ends; waits with nothing to see are cut, and a segment lasts its line plus `pacing.pauseMs`. The subtitles come from
the same timeline, one cue per segment, drawn into the video and written to the `.vtt`; the quality gate checks that
every cue lasts until its line has been spoken and never overlaps the next.

## Bugs: before and after the fix

A **UI bug** (a bug ticket, by its cached type, whose verified plan has a browser case that a changed spec runs, in a change that touches the frontend) gets two headline videos of the case that reproduces it, made by the same recorder, narrator, pacing, subtitles and gates. Which case that is, is found by running the bug's browser cases on the base: the first, in order (a `demo: headline` case, then by priority, sad paths before happy paths, most criteria covered, lowest id), that fails there at its check and passes on the fix; a bug's happy-path case usually passes on the base too, so it is never assumed. When none does, the section lists each case's reason.

- **Before the fix**: the bug's regression flow recorded against the application built from the merge base of the fix branch. The base is checked out per commit (`.factory/state/demo-base/<sha>`, a git worktree), and its stack images are tagged with that commit, so the fixed branch's images are never replaced. Its stack comes up on the step's own slot first, the specs of the bugs run with `--grep` on their cases, and the stack goes down before the fixed branch's comes up; then, with `prune.afterDelivery` on (alpha, off by default), the base checkout it added is removed, also after a failure, when nothing but the exact files it wrote is in it ([disk.md](disk.md#after-a-delivery); its `-base-<sha>` images stay; `--keep` or `prune.keepLocal` keeps the checkout). Its recording time is a `demo-recording` row (`side: "before"`) in `run-conditions.jsonl`, next to the branch's own (`side: "after"`).
- **After the fix**: the same case's recording on the fixed branch.

The before recording is the one failed test that may be published, and only when the harness has verified that it failed **at the reproduction check**: at an assertion (not an action, a navigation, a time-out or setup), after the same actions as the after run took, at a check the after run passes at the same point, on a stack that answered its readiness check after the run. Otherwise there is no before video: the section says exactly why ("the bug does not reproduce on the base: the reproduction check passed before the fix", "the before run failed at an earlier step (the click action after 1 action(s))", ...), and the local step's result carries a finding (`DEMO-NO-REPRO-<KEY>`) for the run. It does not hold the delivery unless `video.bugPair.requireBefore` is `true`: then no PR opens (outcome `demo-video-blocked`) and the reason goes on the ticket. A recording step that fails for another reason (the stack, ffmpeg) is only a note.

One narrator run writes both scripts as a pair: the before video says what the user tried, what they did and what went wrong, as the problem the customer saw (it is given what the screen actually showed at the failing check, never the expected value, and a script that states the expected value as what happened fails validation); the after video walks the same steps with the same words, now working. Without a script the before video's automatic lines open with "Before the fix", say what the screen showed instead at the failing step, and close on "That is the problem this change fixes."

In the section each UI bug comes first, under its ticket (`### FIX-7: ...`), with **Before the fix** and **After the fix** (or why the before video could not be shown), then the other headline demos, then the evidence. A group or epic PR of several UI bugs gets one such pair per bug, each under its ticket. A backend-only bug gets no demo video, and the section says so.

## Backend bugs: the requests before and after the fix

A **backend bug** (a bug ticket whose reproduction case, an `e2e` case of its verified plan in a changed spec, drives the service through its public interface) gets its evidence captured on the test stack, never written from memory. A bug whose defect is also visible in a browser gets this and its [video pair](#bugs-before-and-after-the-fix).

- **Recording.** The spec wraps the requests that show the bug, and the assertion of the fixed behaviour, in `reproduction(label, fn)` from the shared `e2e/fixtures.ts` (the `request` fixture records each exchange with `E2E_API_LOG=1`: method, path and query, request headers and body, status, response headers and body, duration, and the reproduction's label). A Playwright `expect` failure, a soft one included, after the block's first recorded response is recorded as the failed reproduction check; any other error inside the block is recorded as an error and gives no evidence. This builds on the API log the [API changes](#api-changes) section already uses.
- **Before and after**, sharing the video pair's base build and slot: the bug's cases run against the application built from the merge base (its own checkout; the specs' own stack calls, such as loading a scenario, go to that checkout's stack through `TESTSTACK_ROOT`, with the fixed branch's specs and scenarios), then against the fixed branch. The first case, in order (priority, sad paths first, most criteria covered, lowest id), that passes the check below is the reproduction. A change with no browser-visible part runs only these cases (nothing is filmed). Otherwise there is no before evidence: the section says why for each case, the step's result carries a finding (`API-NO-REPRO-<KEY>`), and it holds the delivery only with `video.bugPair.requireBefore`.
- **On the ticket**, before the PR opens: one **Reproduction** comment, posted through the tracker contract and edited in place on every delivery (found by a hidden marker). A comment that is not posted (the scan flags the text, the ticket has no issue in the cache, the tracker call fails) gives the minor finding `API-REPRO-COMMENT-<KEY>` and a note in the PR's Before / After section (kept when the section is "Not shown"); one the tracker shortened gives `API-REPRO-COMMENT-REDUCED-<KEY>` and a note. Neither holds the delivery, even with `requireBefore`. The comment holds the preconditions in words, then numbered steps, each request as a copyable block (method, path, the headers that matter, body), the response it got on the base (status, the headers that matter, body) and one line on what is wrong with it. The requests and responses are inserted verbatim by the harness from the recording. The wording (preconditions, steps, what is wrong, what changed) comes from one `demo-narrator` run for all the PR's backend bugs (`step: "reproduction steps"`); prose that quotes a status, body text or value the recording does not hold, a host, a ticket key or anything the secret detector flags is refused, sent back once, then replaced by plain wording made from the recording alone.
- **In the PR**, in the demo section after any videos: **Before the fix / After the fix**, under each bug's ticket: each request, then its response before the fix and after the fix, and one line on the difference that matters; the reproduction's failing call first, at most `apiEvidence.maxPairs`, the rest collapsed.
- **Records**: the exchanges (cleaned) are kept in `.factory/state/demo-videos/<folder>/<KEY>.api-evidence.json` with the comment's text (`<KEY>.reproduction.md`), and an `api-reproduction` row (requests and statuses, `commentPosted`, and `commentWhy`, `commentReduced` and `commentDropped` when they apply) in `run-conditions.jsonl`; the evidence file's `comment` says the same. The before run's time is its `demo-recording` row.
- **Safety and size**: every exchange passes the redaction boundary before it is stored, posted or committed; `Authorization`, cookies and any header or JSON field whose name says token, key (API, access, subscription, functions, master, host, client, app and similar keys), secret, password, session, credential or client principal are masked by name (`(masked)`), whatever the value (a paging or continuation token, and `pass` inside a longer word, are not); bodies are redacted by the detector and cut at `apiEvidence.maxBodyBytes` with the byte count stated; only allow-listed headers are kept; a URL keeps its path and query, never its host. The comment and the section are scanned again before they are posted (a hit: not posted, and the PR says why). Both go through the code host's and tracker's refusal handling, and no field name such as token or password is ever placed before a hash-like value (masked values are words).
- **Payment exchanges are withheld (the guarantee).** A payment exchange is any recorded exchange whose request or response, read on the normalised copy, has a card-number-shaped value anywhere (the URL, a header value, a body), or a key, element, attribute, form or query name that names a card field without doubt: the card key table below (`pan`, `cardNumber`, `ccNumber`, `primaryAccountNumber`, `cardExpiry`, `cardHolderName`, `nameOnCard`, `card[cvc]`, …) or a security code name (`cvv`, `cvc`, `cvn`, `csc`, `ccv`, `cardCode`, `securityCode`, `cardVerification…`); an expiry or holder name counts only beside one of those. None of these makes an exchange a payment exchange by itself: an HTTP header name (`Expires`, `Set-Cookie`, `Cache-Control`), a cookie attribute, `expires_in`, `expiresAt`, a token claim (`exp`, `iat`, `nbf`), the words card or pan in a value or in prose or inside another word (`company`, `expand`), or a key named `card` or `cards` that holds no such name and no card number (a board's cards). The test reads names, not structure, so a card number split over neutral names, an expiry or holder alone, or card fields under names it does not know are not found (the limits under "outside the guarantee"). With `apiEvidence.paymentBodies: "withhold"` (the default) such an exchange shows only its method, its path without the query string, its status and the line "bodies withheld: payment data": no header value and no body of the request or the response, and no masking code runs on it. Every other exchange is published as below. The reproduction check, the ticket comment and the PR section work the same: they show the calls and their statuses.
- **Card data, with `paymentBodies: "mask"`, is masked here and nowhere else (best effort: `withhold` is the guarantee; five review rounds each found a new form the masks missed).** The general [redaction boundary](analysis.md#secrets-in-records-and-posts-redaction) has no card rule, so a ticket, plan, decision or PR text that quotes a card number keeps it. In the recorded requests and responses:
  - **formats:** JSON and almost-JSON (single quotes, bare keys, trailing commas, a body the recorder cut short, JSON inside a string value), form-encoded and query keys (bracketed and URL-encoded forms included), `key: value` / `key=value` text (keys of several words included, such as `card security code:`), and XML (elements and attributes alike; a tag is read whole whatever its length, a `>` inside a quoted attribute included). The path, the allow-listed header values and both bodies are cleaned;
  - **the rule:** a value becomes `[redacted:payment-card-field]` when (a) its key (JSON or form key, XML element or attribute name, a key of several words in text) is a card field: a field word after `card` or `cc` (with an optional credit, debit, payment, billing or buyer before it: `cardNumber`, `card_cvc`, `card[exp_month]`, `cardHolderName`, `card security code`), or `pan`, `cvv`, `cvc`, `cvn`, `csc`, `ccv`, `primaryAccountNumber`, `nameOnCard` or `cardholder`; whatever the value's shape (a validation message or a short invalid input under such a key included), and everything beneath such a key (`"cardExpiry": { "month", "year" }`, a list of messages); (b) it sits beneath a card container: an object or element named as a card or payment-card object (`creditCard`, `debitCard`, `paymentCard`, `cardDetails`, `cardInfo`, `cardData`, `storedCard`, a list `cards` of them), or named `card` or as a payment method (`paymentMethod`, `paymentInstrument`, `paymentSource`, `fundingSource`) and holding a card number, code or expiry at any depth, or named `payment` and holding one as its own field. Beneath a container every value is masked (attributes and nested objects too, and a bare `number`, `name`, `holder` or `expiry` is a card field there) except the plainly non-card fields: type, object, kind, method, card type, brand, network, scheme, funding, country, currency, last four and status; (c) it equals, as a whole word, a value masked under (a) or (b) (or a card number) in a request of the evidence (the URL first asked for, the URL answered, request headers, request body): in an exchange that looks like a payment in any position, a 3 or 4 digit code as a whole number; elsewhere a value of 4 digits or fewer only where an echo sits (quoted, or after `=`). Beside a card number (an object, element, form or key/value text that holds one, by its key or as a valid card number), a key that loosely reads as a security code, an expiry or a holder is a card field too, whatever its value: compared without case or separators, one containing `cvv`, `cvc`, `cvn`, `csc`, `ccv`, `cid`, `securitycode`, `cardcode` or `verification`; one with a word `exp` or starting with `expir` (`expMonth`, `exp_date`, `expirationDate`, `expires`) or reading valid-thru or valid-to; one containing `holder`, `nameoncard` or `cardname`. A self-closing element is a container by its own attributes as one with a closing tag is. An object that merely holds card fields beside other fields is not a container: in a flat order (`cardNumber` beside `city`, `items` and `total`) only the card fields are masked, and objects beside a container (a payment's `billingDetails`), and a `card` with no card value (a board's card), are shown as sent. Only values masked as card fields enter the echoes; a value a response alone holds is masked where it stands, not looked for elsewhere. In XML, each run of text inside a masked element is masked on its own, so inline tags and padding stay; an element the recording cut short is masked to the end. A validation error that names a card field (`propertyName`, `field` and similar) has its attempted value masked;
  - a run of 13 to 19 digits, plain or split by spaces, dashes or dots (groups of 3 to 6 digits), with the prefix and length of a known issuer (Visa, Mastercard, American Express, Discover, JCB, Diners Club, UnionPay, Mir, RuPay, Maestro, Dankort, Verve, InterPayment, InstaPayment, Troy, UATP, China T-Union, Hipercard, Laser) and a valid check digit becomes `[redacted:payment-card]`;
  - **the final check (the guarantee):** after the masks, a copy of each part (the path, every header value shown, each body) is normalised for checking only: `+` read as a space, runs of percent escapes decoded as UTF-8 (byte by byte where they are not UTF-8), JSON `\u` escapes resolved, Unicode compatibility forms folded (NFKC), every Unicode dash and hyphen, comma, dot and space-like or zero-width character read as its plain form, separators of one or two characters (spaces, `+`, `.`, `,`, `_`, `/`, `-`) between digits dropped, exponent numbers written out; every run of 16 or more base64 characters is decoded and checked the same way. Any 13 to 19 digits in it, alone or with digit groups before or after, with a known issuer and a valid check digit, means the exchange is **withheld**. So is any card key whose value is still data after the masks (in any exchange), a security code or expiry key by the loose reading whose value is still data in an exchange that holds a card number, echoes too many and overlapping to mask within a work limit proportional to the text, and, in an exchange that looks like a payment (a card word such as card, cvv, cvc, cvn, csc, ccv, pan, expiry, cardholder or primary account, or a card number, anywhere, in the normalised copy too), a body that could not be read with confidence: brackets or tags around card data that do not pair up, a body left open or cut short (the recorder's own cut included), or a JSON-like body JSON does not read cleanly. XML elements left open at the end are closed there, so what they hold still makes them containers, and a compound card field (an `<expiry>` holding `<month>` and `<year>`) makes its parent a container as a leaf does. A JSON document inside a string whose escapes are not JSON's own is withheld rather than written back. Withheld means all of it: the evidence keeps only the exchange's method, path (unless the path itself held the card data) and status, with a line saying why, and the step reports `API-EVIDENCE-WITHHELD-<KEY>`;
  - masks are spliced into the recorded text and nothing else changes: large numbers, number formats, duplicate keys, escapes and spacing are as recorded. Where the recording is not the bytes sent, the evidence says so under the block: an object or form the test passed (printed by the recorder as JSON). The path is the one the test asked for, not a redirect's. Every rule reads the text in one pass (XML with a stack and a map of open elements; a document or element nested deeper than 256 levels is withheld);
  - **outside the guarantee (the rule's limits):** card data under a name the rule does not know, in an object that is not a container (a bare `expiry`, `holder` or `name` beside a card number in a flat order, an object named `method` or `details` holding a card) is shown unless it is a card number; an echo of a value shorter than 3 characters (a one-digit expiry month quoted in a message), of a value only a response held, or of a value masked under neither (a) nor (b); a card number spelled out in words, split by separators of three characters or more, or encoded in a way the check does not decode (hex, encryption, base64 nested in base64); a number of digits separated by commas that happens to make a valid card number (a list of small numbers) withholds its exchange;
  - a ticket title or narrator line that quotes a valid card number or a security code as a key and value hides the section.

### What the reproduction check proves

`verifyApiBefore` (`scripts/pr-video/lib/api-evidence.mjs`) accepts a case as the reproduction when:

- the stack built from the base was healthy, and the base run of the case failed **inside** its `reproduction(...)`
  block at a Playwright `expect` assertion (an `ExpectError` or `JestAssertionError` carrying a matcher result, or
  a soft assertion), after the block had recorded at least one response. A soft assertion counts only when it
  fails after the block's first recorded response;
- the fixed run passed the whole case, and made the same requests in the block (method and path, without the
  query), at least as many as the base run.

Otherwise the section gives the reason: the failure came "before any response was recorded", was a
"non-assertion error inside reproduction", was "a soft assertion or failure after the reproduction block", or
"setup failed before the case ran". A record from an `e2e/fixtures.ts` older than the factory is refused with
"run `factory render` to update it" (an edited copy needs a hand merge). The check does not compare the responses;
the section shows them for a person to judge.

## API changes

PRs that change backend code (see [Which PRs get what](#which-prs-get-what)), with or without frontend code, get an **API changes** section, between `<!-- pr-api-summary:start -->` and `<!-- pr-api-summary:end -->`. The engine knows no web framework; where the endpoints come from is configuration (`prVideo.api`):

| Configured | The changed endpoints are |
| --- | --- |
| `extractor` and `sources` | read by a route extractor from the changed source files matching `sources` (minus `exclude`), compared between the merge base and the PR head. `extractor` is a built-in name (`aspnet-minimal-api`, in `packs/dotnet/pr-video/`) or the path of a module, in the repository or the factory install, that exports `parseEndpoints(source)` |
| no extractor, OpenAPI files in `openapi` | the difference between each OpenAPI file at the merge base and at the PR head |
| neither | not known: the section shows only the calls the specs recorded, and is skipped (with a note in the log) when there are none |

For each endpoint the section gives:

- **Method and endpoint**, with the service it belongs to (its name in `project.services`, else its folder).
- **Request and response**: parameters, request body type and fields, and response codes and types, read from the OpenAPI documents in `prVideo.api.openapi` (files in the repository, or URLs the running test stack serves; write a stack service's port as `{port:<name>}`, a port name of `stack.ports` in `.factory/app.json`, for example `http://localhost:{port:orders}/openapi/v1.json`, and it is resolved to the slot in use, `TESTSTACK_SLOT` or 0). Removed endpoints are only listed in the table.
- **Examples**: real calls the changed specs made through Playwright's `request` fixture. The local step runs the specs with `E2E_API_LOG=1`, so the factory's `e2e/fixtures.ts` attaches each call (method, URL, request headers and body, status, response body) and `e2e/video-reporter.ts` adds them to `manifest.json`. The section shows up to three examples per endpoint. `Authorization`, cookie and API-key headers and JSON keys that look like secrets (password, token, secret, API key) are redacted, and bodies are truncated.

Endpoints the specs called but the PR did not change are listed as *Exercised*, which covers changes inside services the route diff can't see. When the local step runs no spec (a backend-only change without a backend bug), it starts no stack: the section is built from the route extractor and the OpenAPI files in the repository, without example calls. The section is removed when there is nothing to show.

## Writing a demo spec

Write a normal Playwright test with `test` and `expect` from `../demo` that takes the `demo` fixture
(`async ({ page, demo }) => ...`) and drives the page with user actions on accessible locators. Nobody writes
narration in the spec. In demo mode (`E2E_DEMO=1`, set by the local step) the fixture records the step log the
narrator's script is bound to, and writes the automatic lines used when there is no script:

- an **opening line** from the test's title and its ticket, and a **closing line** with the outcome;
- **every user action**: navigation, clicks, typing ("Type the Password (hidden)" for a secret field), choices,
  ticks and key presses, including raw `page.goto` and `locator.click/fill/...` calls;
- **the assertions a viewer can see**, such as `toHaveCount` ("13 cards are shown") or `toHaveURL` ("Now on the
  home page").

The words come from accessible names, labels, headings and roles, never selectors or raw URLs. A caption the spec
writes wins for its step: `demo.caption(text)`, `demo.click(locator, caption)`, `demo.fill(locator, value, { caption })`
and `demo.highlight(locator, label)`; add one only where the automatic line would not explain the step. At test speed
(feature verification, CI) nothing is narrated and nothing is paced. Use the repository's allow-listed placeholder
values for passwords and tokens, never a real one.

Only a passing test is a demo: a test that failed in demo mode stays on the machine as evidence for agents and is
listed as not published. The one exception is a UI bug's [before-the-fix recording](#bugs-before-and-after-the-fix),
which must fail, at exactly its reproduction check.

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

## Toolchain and licences

`packs/video/tools.json` pins everything; `factory video status` prints each item with its licence, using the same allowlist as static analysis (`scripts/pipeline/lib/analysis/licences.mjs`):

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

Why these choices: ffmpeg comes from a pinned pip wheel, one source for every platform, fetched on the user's
machine and never shipped by the factory (its GPL build is marked for review; a team can point `video.ffmpeg` at
its own build, which needs libass). Narration gets its own virtualenv in the machine cache, packages pinned by exact
version and model files by size and SHA-256. No licence is added to the allowlist: pending items run with a warning,
and `video.licenceReview: "strict"` turns narration off.

## Settings

`prVideo` in `.factory/config.json`:

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
| `api.extractor`, `api.sources`, `api.exclude`, `api.openapi` | `null`, `[]`, `[]`, `[]` | where the [API changes](#api-changes) section reads endpoints from |

`video` in `.factory/config.json` (optional):

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
| `script.scope` | `headline` | which videos the `demo-narrator` agent writes a script for: `headline` (the [headline demos](#headline-demos-and-evidence)), `all`, or `none` (every video keeps the automatic lines, and a backend bug's reproduction steps use plain wording). Any other value stops every command that loads the pipeline config ("video.script.scope must be one of headline, all, none"), and `factory doctor` lists it as a failed row. `all` and `none` are proven by fixture tests only |
| `script.model` | `null` | the narrator's model; `null`: `agent.models.narrator`, else the test-automation model (`agent.models.automation`) |
| `script.timeoutSec`, `script.maxSegments`, `script.maxSegmentChars`, `script.maxOpeningChars`, `script.maxCloseChars`, `script.maxTotalChars`, `script.minWordsPerAction` | `600`, `16`, `280`, `240`, `200`, `2400`, `5` | the narrator's time limit and the script's length limits ([validation](#narration-scripts)) |
| `script.speakEvidence` | `false` | evidence videos are subtitled with the automatic lines and silent; `true` narrates them aloud too |
| `bugPair.enabled` | `true` | a UI bug gets a [before and after pair](#bugs-before-and-after-the-fix) |
| `apiEvidence.enabled` | `true` | a backend bug gets its [requests before and after the fix](#backend-bugs-the-requests-before-and-after-the-fix) |
| `apiEvidence.headers` | `content-type`, `location`, `allow`, `retry-after`, `accept`, `x-requestid`, `x-request-id`, `idempotency-key`, `x-idempotency-key`, `x-correlation-id`, `if-match`, `if-none-match` | the request and response headers shown; credentials are masked by name whatever this lists, other headers are left out |
| `apiEvidence.paymentBodies` | `withhold` | a [payment exchange](#backend-bugs-the-requests-before-and-after-the-fix) shows only its method, path without the query and status (`withhold`, the guarantee), or its headers and bodies with card data masked (`mask`, best effort); any other value stops the config from loading |
| `apiEvidence.maxBodyBytes`, `apiEvidence.maxPairs` | `1500`, `3` | a body is cut at this size (the cut says how many bytes were not shown); request pairs shown per bug in the PR, the rest collapsed |
| `bugPair.requireBefore` | `false` | `true`: when the demo video step runs (feature `demoVideo` on) and reports a bug's reproduction (UI or backend) as missing before the fix, no PR opens (outcome `demo-video-blocked`, the reason on the ticket) instead of a note and a finding. A step that fails outright does not block: the PR opens without its section. Proven by fixture tests only |
