# TypeScript / JavaScript

## CC-1

```ts
// Before: the default is written again where it is read.
const timeoutSec = config.timeoutSec ?? 900;

// After: the defaults module is the one home; code reads the merged value.
import { settings } from './settings';
const timeoutSec = settings(config).timeoutSec;
```

## CC-2

```ts
// Before: the same price rule in two handlers.
const total = items.reduce((s, i) => s + i.price * i.qty, 0) * (1 - discount);

// After: one function, both handlers call it.
export const orderTotal = (items: Item[], discount: number) =>
  items.reduce((s, i) => s + i.price * i.qty, 0) * (1 - discount);
```

## CC-7

```ts
// Before: a flag picks one of two behaviours.
function render(order: Order, asPdf: boolean) { /* ... */ }

// After: two functions.
function renderHtml(order: Order) { /* ... */ }
function renderPdf(order: Order) { /* ... */ }
```

## CC-14

```ts
// Useless: it only checks the mock it set up.
it('returns the mocked user', async () => {
  repo.find.mockResolvedValue(user);
  expect(await repo.find(1)).toBe(user);
});
```
