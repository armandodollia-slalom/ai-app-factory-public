<!-- markdownlint-disable-file MD041 -->

### Layout

- Product code is under `src/`; never change it.
- Scenario format: see `testing/README.md` and the existing scenarios. Extend `default` unless the plan needs an empty store.
- Follow `AGENTS.md` (use `graphify query` before searching the code).

### Test framework per layer

- **e2e layer:** Playwright specs in `e2e/teststack/<scenario>-*.spec.ts` that call `loadScenario('<scenario>')` (see `e2e/teststack/scenario.ts`). Test titles start with the case id: `test('TC-SHOP-1-07 an expired code is rejected', …)`.
- **functional layer:** xUnit tests in the matching `tests/<Service>.FunctionalTests` project. Each test has `[Trait("Story", "<KEY>")]` and `[Trait("TestCase", "<case id>")]`, and the method name contains the case id with dashes as underscores.
- **unit layer** (for example AppHost wiring in `tests/eShop.AppHost.UnitTests`): MSTest tests (`MSTest.Sdk`) with `[TestCategory("<KEY>")]` and `[TestProperty("TestCase", "<case id>")]`, and the case id in the method name the same way.
- A case with several equivalent inputs may use a theory or a loop over data, but still exactly one id.
- Wait on observable conditions (`expect.poll`, `toPass`, retry helpers), never fixed sleeps.

### Story tag (checked by the pipeline)

Every `.cs` file with tests for the story has the story tag, on the class or on every test method. The tag depends on the project's test framework:

- **xUnit** (`tests/*.FunctionalTests`): `[Trait("Story", "<KEY>")]`, and `[Trait("TestCase", "<case id>")]` on each test.
- **MSTest** (projects using `MSTest.Sdk`, such as `tests/*.UnitTests` and `tests/eShop.AppHost.UnitTests`): `[TestCategory("<KEY>")]`, and `[TestProperty("TestCase", "<case id>")]` on each test. MSTest has no `[Trait]`; never add a `TraitAttribute` shim.

### Commands (the pipeline runs the same ones)

- `dotnet build <project>` passes, then the story's tests pass:
  - xUnit: `dotnet test --project <project> --no-build -- --filter-trait "Story=<KEY>"`
  - MSTest: `dotnet test --project <project> --no-build --filter "TestCategory=<KEY>"`
- A new test project must be in `eShop.slnx` and use package versions from `Directory.Packages.props`.
- `npx playwright test -c playwright.teststack.config.ts --grep TC-<KEY>- <your specs>` passes.

### Running

- Bring the stack up with `factory teststack up` if it is not running, then run your specs with `npx playwright test -c playwright.teststack.config.ts --grep TC-<KEY>-`.
- Run functional (xUnit) tests with `dotnet test --project tests/<Project> -- --filter-trait "Story=<KEY>"`, and unit (MSTest) tests with `dotnet test --project tests/<Project> --filter "TestCategory=<KEY>"`.
- When a Playwright test fails, look at what the browser showed before you change code. `artifacts/e2e-videos/manifest.json` lists each test's error and its keyframes (screenshots at each `test.step`, each `demo` checkpoint and the `failure` state). The run before the last one is kept in `artifacts/e2e-videos-previous/`.
- Wrap each step of a case in `test.step('<what the case step says>', …)` (or use `demo.chapter`/`demo.highlight`).
