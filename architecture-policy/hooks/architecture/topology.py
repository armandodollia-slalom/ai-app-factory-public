"""What the application may declare for the architecture policy: NEW services (the factory's `.factory/app.json`,
`policy.services`).

Design decision (docs/architecture-policy.md, "Who classifies a project"): a project's class is DERIVED from the
project itself by the profile's conventions (classify.py), never declared. An agent declares only what cannot be
derived, all of it new:
- the id of a new service, and the root folders of its projects (each a folder that holds a project manifest);
- the datastores that new service owns.

The whole declaration set is validated together. Names are plain ASCII compared lower-cased (no Unicode folding,
whitespace or invisible characters), and paths are normalised:
- an id that exists under any casing, or is declared twice, is refused;
- a root must hold a project manifest, and may not overlap a profiled project or another declared root;
- a datastore that is owned or shared under any casing, or is declared twice, is refused;
- a root that is, or is inside, a symbolic link is refused (the engine checks on disk, the guard too);
- any other key (`projects`, `exceptions`, ...) is refused.
A refused declaration declares nothing, and the engine reports it as a BLOCK at every checkpoint (engine.py).

The same rules are implemented in JavaScript for the factory guard (scripts/pipeline/lib/policy-topology.mjs).
Both are tested against one table: architecture-policy/tests/topology_cases.json.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from .classify import norm

SERVICE_KEYS = {"id", "roots", "owns_datastores"}
# Names are plain ASCII, compared lower-cased: the same rule in both implementations (no Unicode case folding, no
# whitespace or invisible characters to tell two names apart).
ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9-]*$")
STORE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")


def _inside(child: str, parent: str) -> bool:
    return child == parent or child.startswith(parent + "/")


def symlinked(root: Path | None, rel: str) -> bool:
    """Whether `rel` or a folder above it (inside the repository) is a symbolic link."""
    if root is None:
        return False
    cur = Path(root)
    for part in [p for p in rel.split("/") if p]:
        cur = cur / part
        if cur.is_symlink():
            return True
    return False


def shown(v) -> str:
    """A name as the messages show it: printable ASCII as is, anything else escaped (the same in policy-topology.mjs)."""
    if not isinstance(v, str):
        return "?"
    return "".join(c if 0x20 <= ord(c) <= 0x7E else "".join(f"\\u{u:04x}" for u in _utf16(c)) for c in v)


def _utf16(c: str) -> list[int]:
    b = c.encode("utf-16-be")
    return [int.from_bytes(b[i:i + 2], "big") for i in range(0, len(b), 2)]


def read(topology_path: Path) -> tuple[dict | None, str | None]:
    """The `policy` section of the topology file: (section or None, read error or None)."""
    if not topology_path.is_file():
        return None, None
    try:
        doc = json.loads(topology_path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001 - reported, never fatal
        return None, f"{topology_path.name} is not valid JSON: {exc}"
    return (doc or {}).get("policy"), None


def validate(profile: dict, policy, manifest_dirs: set[str], root: Path | None = None, is_symlink=None) -> tuple[list[dict], list[str]]:
    """(declared services, errors). A service with any error is not declared. `root` (the checkout on disk) or
    `is_symlink` (a predicate, for tests) refuses roots that are symbolic links."""
    if policy is None:
        return [], []
    if not isinstance(policy, dict):
        return [], ["policy must be an object with services"]
    linked = is_symlink or (lambda rel: symlinked(root, rel))
    errors: list[str] = []
    for key in policy:
        if key.startswith("$"):
            continue
        if key == "projects":
            errors.append("policy.projects: a project's class is derived from the project itself (the profile's classification conventions); declare only new services (policy.services: id, roots, owns_datastores)")
        elif key != "services":
            errors.append(f"policy.{shown(key)} is not application topology (only policy.services may be declared)")
    # ASCII lower-casing only (str.lower() folds non-ASCII letters differently from JavaScript's toLowerCase()).
    lower = lambda x: re.sub(r"[A-Z]", lambda m: m.group(0).lower(), str(x))  # noqa: E731
    existing_ids = {lower(s.get("id", "")) for s in profile.get("services", []) or []}
    taken_stores = {lower(d) for s in profile.get("services", []) or [] for d in s.get("owns_datastores", []) or []}
    taken_stores |= {lower(d) for d in profile.get("shared_datastore_names", []) or []}
    explicit = [norm(p.get("path", "")) for p in profile.get("projects", []) or []]
    entries = policy.get("services", []) or []
    if not isinstance(entries, list):
        return [], errors + ["policy.services must be a list"]

    # Every root occurrence of the set, to check each against the others: (entry, position, root).
    occurrences = [(i, k, norm(r)) for i, s in enumerate(entries) if isinstance(s, dict) and isinstance(s.get("roots"), list)
                   for k, r in enumerate(s["roots"]) if isinstance(r, str)]
    seen_ids: set[str] = set()
    seen_stores: set[str] = set()
    services: list[dict] = []
    for i, s in enumerate(entries):
        where = f"policy.services[{i}]"
        if not isinstance(s, dict):
            errors.append(f"{where}: must be an object")
            continue
        problems = []
        extra = sorted(set(s) - SERVICE_KEYS)
        if extra:
            problems.append(f"unknown key(s) {', '.join(shown(k) for k in extra)}")
        raw_id = s.get("id")
        sid = lower(raw_id) if isinstance(raw_id, str) else ""
        if not isinstance(raw_id, str) or not ID_RE.match(raw_id):
            problems.append("id must be a plain name (ASCII letters, digits, dashes)")
        elif sid in existing_ids:
            problems.append(f"service '{sid}' already exists in the profile (changing it is governance)")
        elif sid in seen_ids:
            problems.append(f"service '{sid}' is declared twice")
        seen_ids.add(sid)
        roots = s.get("roots")
        if not isinstance(roots, list) or not roots or not all(isinstance(r, str) for r in roots):
            problems.append("roots must list the folders of the new service's projects")
            roots = []
        for k, raw in enumerate(roots):
            r = norm(raw)
            if not r or r.startswith("..") or raw.startswith("/"):
                problems.append(f"root '{shown(raw)}' must be a folder inside the repository")
                continue
            if linked(r):
                problems.append(f"root '{shown(r)}' is, or is inside, a symbolic link")
                continue
            if r not in manifest_dirs:
                problems.append(f"root '{shown(r)}' holds no project manifest (create the project first)")
            clash = next((e for e in explicit if _inside(r, e) or _inside(e, r)), None)
            if clash:
                problems.append(f"root '{shown(r)}' overlaps the profiled project at {clash}")
            others = [(j, l, o) for j, l, o in occurrences if (j, l) != (i, k)]
            if any(o == r for _, _, o in others):
                problems.append(f"root '{shown(r)}' is declared twice")
            else:
                other = next((o for _, _, o in others if _inside(r, o) or _inside(o, r)), None)
                if other:
                    problems.append(f"root '{shown(r)}' overlaps the declared root '{shown(other)}'")
        stores = s.get("owns_datastores", []) or []
        if not isinstance(stores, list) or not all(isinstance(d, str) for d in stores):
            problems.append("owns_datastores must list datastore names")
            stores = []
        for d in stores:
            c = lower(d)
            if not STORE_RE.match(d):
                problems.append(f"datastore '{shown(d)}' must be a plain name (ASCII letters, digits, '.', '_', '-'; no spaces)")
            elif c in taken_stores:
                problems.append(f"datastore '{d}' is owned by another service or shared (names compare without case)")
            elif c in seen_stores:
                problems.append(f"datastore '{d}' is declared twice")
            seen_stores.add(c)
        if problems:
            errors.append(f"{where} ({shown(s.get('id'))}): " + "; ".join(problems))
        else:
            services.append({"id": sid, "roots": [norm(r) for r in roots], "owns_datastores": [lower(d) for d in stores]})
    return services, errors
