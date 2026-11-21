## Feature videos (definition of done)

Every e2e test is recorded on video (`video` in the Playwright config). By default only failed tests keep theirs (`artifacts/e2e-videos/<project>/<spec>--<test>.failed.webm`, plus keyframes for agents); set `E2E_KEEP_VIDEOS=1` to keep passing tests' videos too. When you implement or change anything a user can see or do in the browser, you are not done until a passing e2e test covers the flow and you have its video. Follow the factory's `feature-demo-video` skill (`skills/feature-demo-video/SKILL.md` in the factory install; `factory version --path` prints where that is):

1. Add or extend an e2e spec for the flow on the test stack (`e2e/teststack/<feature>.spec.ts`), with `test` and `expect` from `e2e/demo.ts`: its `demo` fixture narrates every action and visible assertion by itself, from accessible names. Drive the page with user actions on accessible locators; add a caption only where the automatic line would not explain the step to a viewer. Specs import `test` from `e2e/fixtures.ts` (or `e2e/demo.ts`), never from `@playwright/test`, so contexts opened with `browser.newContext()` are recorded too.
2. Run it: `factory teststack up`, then `E2E_KEEP_VIDEOS=1 npx playwright test -c playwright.teststack.config.ts <feature>` (PowerShell: `$env:E2E_KEEP_VIDEOS=1` first). It must pass.
3. Embed the resulting `artifacts/e2e-videos/**/*.webm` (absolute path) in your final summary, and describe what it shows in the PR description. Never commit the videos.

Skip this only for backend-only, docs-only or no-behavior-change work, and say so in your summary.
