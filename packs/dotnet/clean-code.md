# C\#

## CC-1

```csharp
// Before: the options default is written again where it is read.
var timeout = options.Value.TimeoutSec ?? 900;

// After: the options class is the one home (public int TimeoutSec { get; set; } = 900;).
var timeout = options.Value.TimeoutSec;
```

## CC-2

```csharp
// Before: the same price rule in two handlers.
var total = items.Sum(i => i.Price * i.Quantity) * (1 - discount);

// After: one method on the aggregate, both handlers call it.
public decimal Total(decimal discount) => Items.Sum(i => i.Price * i.Quantity) * (1 - discount);
```

## CC-7

```csharp
// Before: a flag picks one of two behaviours.
public Task Notify(Order order, bool sms) { /* ... */ }

// After: two methods.
public Task NotifyByEmail(Order order) { /* ... */ }
public Task NotifyBySms(Order order) { /* ... */ }
```

## CC-14

```csharp
// Useless: it tests a property getter.
[Fact]
public void Name_ReturnsName() => Assert.Equal("a", new Product("a").Name);
```
