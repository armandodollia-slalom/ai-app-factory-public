# Python

## CC-1

```python
# Before: the default is written again where it is read.
timeout = config.get("timeout_sec", 900)

# After: the settings module is the one home; code reads the merged value.
from app.settings import settings
timeout = settings.timeout_sec
```

## CC-2

```python
# Before: the same price rule in two views.
total = sum(i.price * i.qty for i in items) * (1 - discount)

# After: one function, both views call it.
def order_total(items, discount):
    return sum(i.price * i.qty for i in items) * (1 - discount)
```

## CC-7

```python
# Before: a flag picks one of two behaviours.
def export(report, as_csv=False): ...

# After: two functions.
def export_json(report): ...
def export_csv(report): ...
```

## CC-14

```python
# Useless: it asserts what the dataclass already guarantees.
def test_order_has_id():
    assert Order(id=1).id == 1
```
