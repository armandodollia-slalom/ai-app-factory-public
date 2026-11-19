"""Deterministic project-graph validators over build manifests.

They know no build system. The validator's params say which files are manifests and how a manifest names what it
depends on; the profile says which project, service and layer a path belongs to:

    manifest_globs:      files that declare a project's dependencies (e.g. **/Cargo.toml, **/pom.xml, **/*.csproj)
    reference_patterns:  how a manifest references another project of this repository. Each entry is a regex with a
                         named group 'ref', or {regex, kind}: kind 'path' (default) reads 'ref' as a path relative
                         to the manifest (to the other project's directory or manifest); kind 'name' reads it as
                         the name of a profile project.
    package_patterns:    regexes with a named group 'name' for third-party packages (forbidden_packages)
    name_separators:     characters that end a package-name segment (default . - _ / :), so the forbidden entry
                         'acme' also covers 'acme.http' or 'acme-http' but not 'acmex'
"""
from __future__ import annotations

import posixpath

from _vcommon import compile_regex, fail, match_any, normalize

DEFAULT_SEPARATORS = (".", "-", "_", "/", ":")


def _manifests(ctx) -> list[str]:
    return [f for f in ctx.files if match_any(f, ctx.params["manifest_globs"])]


def _references(ctx, path: str, text: str):
    """Yield (match, cited target, profile project or None, kind) for every in-repository reference of a manifest."""
    base = posixpath.dirname(path)
    for spec in ctx.params.get("reference_patterns", []):
        spec = spec if isinstance(spec, dict) else {"regex": spec}
        kind = spec.get("kind", "path")
        for m in compile_regex(spec["regex"], spec.get("flags")).finditer(text):
            ref = m.group("ref")
            if kind == "name":
                yield m, ref, ctx.index.project_by_name(ref), kind
                continue
            target = normalize(posixpath.normpath(posixpath.join(base, normalize(ref))))
            project = (ctx.index.project_by_dir(target) or ctx.index.project_by_dir(posixpath.dirname(target))
                       or ctx.index.project_for(target))
            yield m, target, project, kind


def layer_dependencies(ctx) -> list[dict]:
    """Project references must follow profile.layer_dependencies; every project must be classified."""
    rules = ctx.profile.get("layer_dependencies", {})
    results = []
    for path in _manifests(ctx):
        text = ctx.read(path) or ""
        source = ctx.index.project_for(path)
        if source is None or not source.get("layer"):
            info = getattr(ctx, "unclassified", {}).get(path) or {"reason": "it is not in the profile", "needs_person": True}
            if info["needs_person"]:
                fix = ("Do not try to fix this in the code: a person must extend the policy profile (its projects or classification "
                       "conventions). Report it in your result.")
            else:
                fix = "Declare the new service in the application's topology file (policy.services), then finish again."
            results.append({**fail(path, None, None, f"Project is not classified: {info['reason']}."),
                            "remediation": fix, "needs_person": info["needs_person"]})
            continue
        allowed = rules.get(source["layer"], [])
        for m, cited, target, kind in _references(ctx, path, text):
            if "*" in allowed:
                continue
            if target is None:
                if kind == "path":  # a name the profile does not know is an external dependency, not a project
                    results.append(fail(path, text, m.start(), f"Reference to unclassified project '{cited}'."))
                continue
            if target is source:
                continue
            ok = any(a == "shared" and target.get("layer") == "shared"
                     or a.startswith("same_service:") and target.get("layer") == a.split(":", 1)[1]
                     for a in allowed)
            if not ok:
                results.append(fail(path, text, m.start(),
                                    f"{source['layer']} project '{source['name']}' must not reference {target.get('layer')} project '{target['name']}'."))
    return results


def forbidden_packages(ctx) -> list[dict]:
    """Packages forbidden for a layer (profile.forbidden_packages_by_layer)."""
    by_layer = ctx.profile.get("forbidden_packages_by_layer", {})
    seps = tuple(ctx.params.get("name_separators", DEFAULT_SEPARATORS))
    patterns = [compile_regex(r) for r in ctx.params.get("package_patterns", [])]

    def hit(pkg: str, entry: str) -> bool:
        stem = entry.rstrip("".join(seps))
        return pkg == stem or (pkg.startswith(stem) and pkg[len(stem):len(stem) + 1] in seps)

    results = []
    for path in _manifests(ctx):
        source = ctx.index.project_for(path)
        forbidden = by_layer.get(source.get("layer") if source else "", [])
        if not forbidden:
            continue
        text = ctx.read(path) or ""
        for regex in patterns:
            for m in regex.finditer(text):
                pkg = m.group("name")
                if any(hit(pkg, f) for f in forbidden):
                    results.append(fail(path, text, m.start(), f"Package '{pkg}' is forbidden in the {source['layer']} layer."))
    return results


def service_isolation(ctx) -> list[dict]:
    """A service project may not reference a project owned by a different service."""
    results = []
    for path in _manifests(ctx):
        source = ctx.index.project_for(path)
        if not source or not source.get("service"):
            continue
        text = ctx.read(path) or ""
        for m, _, target, _kind in _references(ctx, path, text):
            if target and target.get("service") and target["service"] != source["service"]:
                results.append(fail(path, text, m.start(),
                                    f"Service '{source['service']}' references '{target['name']}' owned by service '{target['service']}'. "
                                    "Integrate through APIs or integration events instead."))
    return results
