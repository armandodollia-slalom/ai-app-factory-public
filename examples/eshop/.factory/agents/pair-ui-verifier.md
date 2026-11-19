<!-- markdownlint-disable-file MD041 -->

### The app

The URL the harness gives you is the WebApp (Blazor) of the isolated stack.

### Driving the app

- Browser automation tool: Playwright (the repo already depends on `@playwright/test`).
- Quick look: `npx playwright screenshot --full-page "<url>/<path>" "<screenshots dir>/<name>.png"`.
- Flows (sign-in, add to cart, forms): write a small script in the screenshots directory and run it with node, using `@playwright/test`'s `chromium`. See `playwright.config.ts` and `e2e/` for login helpers and test users.
