// Council C8/C12: #154's PR body did not list that the existing Catalog functional tests were moved into a new shared
// collection; the flow critic never named it. The harness now lists shared test, build and CI changes from the diff.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { infraSideEffects } from '../lib/infra-changes.mjs';

test('#154: a new collection that existing tests join is listed; the PR\'s own new tests are not', () => {
  const pr154 = [
    { status: 'A', file: 'e2e/teststack/bug-40.spec.ts' },
    { status: 'M', file: 'src/Catalog.API/Apis/CatalogApi.cs' },
    { status: 'A', file: 'tests/Catalog.FunctionalTests/Bug40SortTests.cs' },
    { status: 'A', file: 'tests/Catalog.FunctionalTests/CatalogApiCollection.cs' },
    { status: 'M', file: 'tests/Catalog.FunctionalTests/CatalogApiTests.cs' },
    { status: 'A', file: '.factory/plans/BUG-40/TC-01.md' },
  ];
  assert.deepEqual(infraSideEffects(pr154), ['shared test setup: tests/Catalog.FunctionalTests/CatalogApiCollection.cs added and used by existing tests (it affects every test or build that uses it, not only this ticket\'s)']);
});

test('a fixture added only for the PR\'s own new tests is not listed; changed build, package and CI files are', () => {
  assert.deepEqual(infraSideEffects([{ status: 'A', file: 'tests/Ordering.FunctionalTests/IdempotencyFixture.cs' }, { status: 'A', file: 'tests/Ordering.FunctionalTests/IdempotencyTests.cs' }]), []);
  const lines = infraSideEffects([
    { status: 'M', file: 'src/Ordering.API/Ordering.API.csproj' },
    { status: 'M', file: 'package.json' },
    { status: 'M', file: '.github/workflows/ci.yml' },
    { status: 'M', file: 'playwright.teststack.config.ts' },
    { status: 'D', file: 'tests/Basket.UnitTests/xunit.runner.json' },
    { status: 'M', file: 'src/WebApp/Components/Pages/Checkout/Checkout.razor' },
  ]);
  assert.deepEqual(lines.map((l) => l.split(' (')[0]), [
    'build and dependencies: src/Ordering.API/Ordering.API.csproj changed',
    'build and dependencies: package.json changed',
    'CI: .github/workflows/ci.yml changed',
    'shared test setup: playwright.teststack.config.ts changed',
    'shared test setup: tests/Basket.UnitTests/xunit.runner.json deleted',
  ]);
});
