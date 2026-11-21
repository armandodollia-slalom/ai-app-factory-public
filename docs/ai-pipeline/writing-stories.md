# Writing stories for the pipeline

**Who reads this:** B (adopters) and anyone writing tickets for the pipeline.

The pipeline only knows what the story says: the implementer builds from it, the test planner and the test-automation agent plan and test against it, and the PR check holds the pull request to it. This page is the contract between a story author and the agents.

## Where stories live

- Every story is a ticket on the [ticket board](board.md); the issue body holds the whole story in Markdown, between the `board-ticket:source` markers. Create one from a Markdown file (or stdin) with the board, not by adding a file to the repository:

  ```bash
  factory board new SHOP-10.md --epic epic-checkout-redesign [--mockups path/to/SHOP-10-cart] [--dry-run]
  ```

  Bugs work the same way (`**Type:** Bug`, or a `BUG-` key); `--type epic` and `--type spike` create epics and research spikes. Once a bug's fix PR is published, the [review gate](review-gate.md) adds a generated `## Triage` section to the issue body, outside the story's source; don't edit it (it is overwritten) and don't put requirements there. To send a fix back, request changes on the PR or move the card back to In Progress, and say why in a comment: the reason goes to the re-run as a binding decision.
- `<KEY>` is uppercase letters and digits, a dash and a number (`SHOP-10`). Put it in the heading (`# SHOP-10: [FE] Coupon entry in the cart`) or pass `--key`. The issue title is the heading; one issue per key.
- The **slug** (`SHOP-10-coupon-entry-in-the-cart`, kept in the issue metadata) names the branch (`feat/` plus the lowercased slug, first 60 characters) and the test plan folder (`.factory/plans/<slug>/`). It never changes after the issue is created, so renaming the title does not orphan a plan.
- The first level-1 heading is the story title. Put `[FE` in it (for example `# SHOP-10: [FE] Coupon entry`; text may follow inside the brackets, such as `[FE - Admin]`) for frontend stories, so the PR check runs its UI design critic.
- Edit a story on GitHub between the markers (or edit the cached `.factory/state/board/<KEY>/story.md` and run `factory board publish <KEY>`). The next `factory board fetch`, `factory start` or `factory implement run` picks the change up, and its test plan becomes stale.

## Sections the agents read

| Section | Required | Who uses it | Write it so that |
| --- | --- | --- | --- |
| `# <title>` | yes | everyone | it names the feature; add `[FE]` for UI work |
| `**Blocked by:**` line | when it has blockers | `factory implement run` (ordering, stacked branches), implementer | it lists story keys, for example `* **Blocked by:** SHOP-1, SHOP-2`. Leave it out, or write `None`, when there are none |
| User Story | yes | implementer, critics | the role, need and value are clear |
| Inputs | when there is an API or form | implementer, `test-planner`, acceptance critic | every field has its type, required or optional, limits and format |
| Outputs | yes | implementer, `test-planner`, acceptance and design critics | exact fields, status codes, copy and formats; the design critic uses it when there is no mockup |
| Acceptance Criteria | yes | everyone | each one is a testable **Given / When / Then**, including the error cases |
| Technical Notes | optional | implementer | file and line references are hints; the implementer checks them against the code and the code wins |
| Test scope | optional | `test-planner` | it says which layer tests what, and what is out of scope |
| Related Stories | optional | implementer | context only; agents can't open other stories unless they were handed to the pipeline |
| Open Questions | optional | implementer, `test-planner` | each question is answered, or clearly minor (see below) |
| `## Implementation Notes` | never by hand | written by the implementer | read by the reviewers as the implementer's account; it never marks a story done (a story is skipped as already implemented only when its issue is closed or this checkout's run record delivered it) |

## What makes a story go well

- **Make every rule testable.** `test-planner` writes a case for every requirement, field constraint, output field, status code and algorithm step, and a sad path only where the story states or implies the outcome. Anything left undefined (exact error bodies, concurrency, outages) becomes an open question instead of a test.
- **Answer design questions before you start.** If an Open Question changes the API shape, auth or data model, the implementer stops and the story ends `blocked`. Minor ones it decides conservatively and records under Implementation Notes.
- **Keep the story self-contained.** The [story guard](../internals.md#guards) denies agents every other ticket and its mockups unless you hand it to `factory implement run` (the story keys, or `--epic`, which also hands over the epic itself). Copy the parts of an epic or another story the story depends on into the story.
- **List blockers.** A story blocked by another in the same batch runs after it and stacks on its branch. A blocker outside the batch must already be merged, or the implementer reports the story `blocked`.
- **Name exact copy.** Labels, messages and formats in Outputs are checked word for word by the acceptance and design critics.
- **Stay in scope.** The implementer builds exactly the acceptance criteria and lists nice-to-haves in its report instead.

## What a bug ticket ends up containing

Write a bug as the symptom a user or client sees. Before its fix's PR opens, the pipeline adds the evidence, recorded on the test stack, never written from memory:

- **A bug a browser shows**: the PR's demo video section opens with its *Before the fix* video (the reproduction recorded on the code the fix starts from) and its *After the fix* video ([pr-demo-video.md](pr-demo-video.md#bugs-before-and-after-the-fix)).
- **A bug in a service's answer**: the ticket gets one **Reproduction** comment (edited in place on every delivery): the preconditions in words, then numbered steps, each request as a copyable block (method, path, the headers that matter, body) with the response the service gave before the fix and one line on what is wrong with it; the PR gets the same requests with the responses before and after the fix ([pr-demo-video.md](pr-demo-video.md#backend-bugs-the-requests-before-and-after-the-fix)).
- A bug with both gets both. When the reproduction does not fail on the code the fix starts from, the ticket gets no reproduction and the PR says why.

## Mockups (frontend stories)

Attach mockups to the story with `factory board new --mockups <folder>`: a folder named `<KEY>-<name>` with a `README.md` (the screens and any review changes) and the `.dc.html` design canvas files and images. They go on the `board-assets` branch, show in the issue's Mockups section, and land in `.factory/state/board/<KEY>/mockups/` when the story is fetched. When a mockup exists, the PR check's design critic treats it as the reference for layout, components, states and copy; otherwise it uses the story's Outputs and the application's existing design system (named in the design critic's addendum, `.factory/agents/pr-check-design.md`). A mockup folder for the key also marks the story as frontend.

## Changing a story after work started

The test plan records the story text it was written for (`story-sha`). When the story changes, the plan becomes stale: `factory fv plan <KEY>` (or `--stale`) updates the affected cases in place and keeps the other case ids, and `pre-push` fails until it does. See [feature-verification.md](feature-verification.md#workflow-1-story-to-test-plan).

## Template

```markdown
# [FE] <Feature title>

* **Blocked by:** <KEY-1>, <KEY-2>

## User Story

As a <role>, I want <capability> so that <value>.

## Inputs

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `code` | string | yes | 3-20 characters, letters and digits, case-insensitive |

## Outputs

* `200 OK` with `{ "total": number, "discount": number }`.
* Message shown under the field: "Coupon applied".

## Acceptance Criteria

1. **Given** <state> **When** <action> **Then** <observable result>.
2. **Given** an expired code **When** the shopper applies it **Then** the API returns `400` and the cart shows "This coupon has expired".

## Technical Notes

* <Services or modules, endpoints, events and files involved.>

## Test scope

* <What is tested at which layer; what is out of scope.>

## Related Stories

* <KEY>: <how it relates>

## Open Questions

* <Question> (answer: <decision>, or "open")
```
