"""Derived classification: a project the profile does not list is classified from the project itself.

The profile (governed: only people change it) lists the projects it knows and, under `classification`, the
conventions for new ones: for each class (type, layer), what a project of it looks like. For example, a test
project lives under tests/ and is a test project; an API lives under src/, uses the Web SDK and is named *.API.
The engine reads a new project's facts from its manifest (`project_facts`) and applies the conventions:

- exactly one convention fits: the project gets that class;
- none fits, or several do: the project is unclassified, and a person must extend the profile (an explained
  escalation, `needs_person`). Agents cannot fix it, because the conventions are governance;
- the class belongs to a service: the service comes from the project's name (`service_names`: the first segment
  of the name maps to a service the profile has), or from a NEW service the application declares with its project
  roots (topology.py). Neither, or two different ones, leaves the project unclassified.

Nothing an agent writes picks a class. A declaration names a new service and the folders of its projects; the
class still comes from the project. A project nested inside another project, or containing one, is never
classified by convention, so a nested folder cannot take a more permissive class than its parent.
"""
from __future__ import annotations

import fnmatch
import posixpath
import re
# Test framework packages, by name prefix (xunit.v3.mtp-v2, MSTest.TestFramework, NUnit3TestAdapter, ...).
TEST_PACKAGE_PREFIXES = ("microsoft.net.test.sdk", "xunit", "mstest", "nunit", "tunit")
# Properties the classifier reads besides the ones a profile's conventions name.
READ_PROPERTIES = {"OutputType", "IsTestProject", "UseMaui"}
# Language knowledge for the content traits (C#): endpoint mappings, and routes under /api.
ENDPOINT_RX = re.compile(r"\.Map(Get|Post|Put|Delete|Patch|Methods|GrpcService)\b|\[(ApiController|Http(Get|Post|Put|Delete|Patch))\b")
API_ROUTE_RX = re.compile(r"""\.Map(Get|Post|Put|Delete|Patch|Methods|Group)\s*\(\s*@?"/?api[/"]|\[Route\(\s*"/?api[/"]""")


def _glob(path: str, pattern: str) -> bool:
    """fnmatch where `*` does not cross a slash and `**` does."""
    rx = re.escape(pattern).replace(r"\*\*", "\0").replace(r"\*", "[^/]*").replace("\0", ".*").replace(r"\?", "[^/]")
    return re.fullmatch(rx, path) is not None


def norm(path: str) -> str:
    p = posixpath.normpath(str(path or "").replace("\\", "/")).strip("/")
    return "" if p == "." else p


def _local(tag) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _msbuild_doc(text: str):
    """The manifest as XML (comments are not elements), or None when it is not well-formed."""
    import xml.etree.ElementTree as ET
    try:
        return ET.fromstring(text)
    except ET.ParseError:
        return None


def _properties(root, wanted: set[str]) -> dict[str, list[tuple[str, bool]]]:
    """Every assignment of the wanted properties: name -> [(value, conditional)] in document order. Property names
    compare without case, as in MSBuild (`<outputtype>` is OutputType); the result uses the wanted spelling."""
    canon = {w.lower(): w for w in wanted}
    out: dict[str, list[tuple[str, bool]]] = {}
    for group in root.iter():
        if _local(group.tag) != "PropertyGroup":
            continue
        group_cond = bool(group.get("Condition"))
        for prop in group:
            name = canon.get(_local(prop.tag).lower())
            if name:
                out.setdefault(name, []).append(((prop.text or "").strip(), group_cond or bool(prop.get("Condition"))))
    return out


def _possible(assigned: list[tuple[str, bool]]) -> list[str | None]:
    """The values a property can end with, in MSBuild's order (the last assignment that applies wins); None is unset."""
    possible: list[str | None] = [None]
    for value, conditional in assigned:
        possible = (possible + [value]) if conditional else [value]
    seen, out = set(), []
    for v in possible:
        k = None if v is None else v.lower()
        if k not in seen:
            seen.add(k)
            out.append(v)
    return out


def _test_references(root) -> tuple[bool, bool]:
    """(references a test framework, any such reference is conditional)."""
    found = conditional = False
    for group in root.iter():
        if _local(group.tag) != "ItemGroup":
            continue
        for item in group:
            if _local(item.tag) in ("PackageReference", "GlobalPackageReference") and str(item.get("Include") or "").lower().startswith(TEST_PACKAGE_PREFIXES):
                found = True
                conditional = conditional or bool(group.get("Condition") or item.get("Condition"))
    return found, conditional


def _resolve_import(project: str, ipath: str, imports_dir: str, all_files: set[str] | None) -> tuple[str | None, bool]:
    """(the repository file an <Import Project> in a Directory.* file names, whether it is one of the Directory.*
    files already read). None when the path cannot be resolved without evaluating MSBuild."""
    m = re.fullmatch(r"\$\(\[MSBuild\]::GetPathOfFileAbove\(\s*'?([^',)]+)'?\s*(?:,.*)?\)\)", project.strip())
    if m and posixpath.basename(m.group(1)) in ("Directory.Build.props", "Directory.Build.targets", "Directory.Packages.props"):
        return m.group(1), True
    p = project.replace("\\", "/").replace("$(MSBuildThisFileDirectory)", imports_dir + "/" if imports_dir else "")
    if "$(" in p or "*" in p:
        return None, False
    target = norm(posixpath.join(imports_dir, p))
    if target.startswith(".."):
        return None, False
    return target, False


def project_facts(path: str, text: str | None, *, wanted: set[str] | None = None, imports: dict[str, str] | None = None, read=None) -> dict:
    """What a manifest says about its project, read the way MSBuild reads it: as XML (comments are not part of it),
    property names without case, the last assignment that applies wins. A property assigned under a Condition gets
    every value it can end with (`variants`); the class is derived for each, and must be the same (derive). Anything
    else MSBuild could resolve differently is listed in `ambiguous` (the project then goes to a person): an SDK named
    twice or differently, a property assigned different values unconditionally, a conditional test-framework
    reference, an explicit <Import> in the manifest, or a Directory.Build.* / Directory.Packages.props (`imports`:
    path -> text, followed through their own imports with `read`) that sets what is read or imports conditionally.
    MSBuild projects (.csproj, .fsproj, .vbproj, any case) in full; other manifests by their folder."""
    path = norm(path)
    folder = posixpath.dirname(path)
    facts = {"manifest": path, "dir": folder, "name": posixpath.basename(folder), "sdk": None, "output_type": None,
             "output_type_explicit": False, "test_project": False, "properties": {}, "variants": {}, "linked_folders": [],
             "computed_includes": [], "ambiguous": []}
    if not re.search(r"\.(cs|fs|vb)proj$", path, re.I) or text is None:
        return facts
    facts["name"] = re.sub(r"\.(cs|fs|vb)proj$", "", posixpath.basename(path), flags=re.I)
    root = _msbuild_doc(text)
    if root is None:
        facts["ambiguous"].append("the manifest is not well-formed XML")
        return facts
    wanted = set(READ_PROPERTIES) | set(wanted or ())
    sdks = [s.split("/")[0].strip() for s in str(root.get("Sdk") or "").split(";") if s.strip()]
    for el in root.iter():
        tag = _local(el.tag)
        if tag == "Sdk" and el.get("Name"):
            sdks.append(el.get("Name").split("/")[0].strip())
        elif tag == "Import":
            if el.get("Sdk"):
                sdks.append(el.get("Sdk").split("/")[0].strip())
            else:
                facts["ambiguous"].append(f"it imports {el.get('Project')!r}, which can set what the classifier reads")
    distinct = sorted(set(sdks), key=str.lower)
    if len({d.lower() for d in distinct}) > 1:
        facts["ambiguous"].append(f"it names several SDKs ({', '.join(distinct)})")
    facts["sdk"] = distinct[0] if len(distinct) == 1 else (sdks[0] if sdks else None)
    props = _properties(root, wanted)
    for name, assigned in props.items():
        fixed = [v for v, cond in assigned if not cond]
        if len({v.lower() for v in fixed}) > 1:
            facts["ambiguous"].append(f"{name} is set more than once with different values")
        possible = _possible(assigned)
        if len(possible) > 1:
            facts["variants"][name] = possible
        if possible[-1] is not None:
            facts["properties"][name] = possible[-1]
    finish(facts)
    refs, refs_conditional = _test_references(root)
    if refs_conditional:
        facts["ambiguous"].append("a test-framework reference is conditional")
    facts["test_refs"] = refs
    finish(facts)
    # What the Directory.Build.* / Directory.Packages.props files set (and the files they import), when it is
    # something the classifier reads; the compile items they add are linked source of this project.
    queue = sorted((imports or {}).items())
    seen = {p for p, _ in queue}
    linked = set()
    while queue:
        ipath, itext = queue.pop(0)
        iroot = _msbuild_doc(itext or "")
        if iroot is None:
            facts["ambiguous"].append(f"{ipath} is not well-formed XML")
            continue
        set_there = sorted(_properties(iroot, wanted))
        if set_there:
            facts["ambiguous"].append(f"{ipath} sets {', '.join(set_there)}")
        if _test_references(iroot)[0]:
            facts["ambiguous"].append(f"{ipath} adds a test-framework reference")
        idir = posixpath.dirname(ipath)
        for el in iroot.iter():
            tag = _local(el.tag)
            if tag == "Import" and not el.get("Sdk"):
                cond = str(el.get("Condition") or "").strip()
                if cond and not re.fullmatch(r"(?i)!?\s*exists\(\s*'[^']*'\s*\)", cond):
                    facts["ambiguous"].append(f"{ipath} imports {el.get('Project')!r} under a Condition ({cond}), so builds can differ")
                    continue
                target, chained = _resolve_import(str(el.get("Project") or ""), ipath, idir, None)
                if chained:
                    continue
                if target is None:
                    facts["ambiguous"].append(f"{ipath} imports {el.get('Project')!r}, a path the classifier cannot resolve")
                    continue
                if target not in seen:
                    seen.add(target)
                    t = read(target) if read else None
                    if t is None:
                        if not re.search(r"\.(props|targets)$", target, re.I) or cond:
                            continue
                        facts["ambiguous"].append(f"{ipath} imports {target}, which the classifier cannot read")
                        continue
                    queue.append((target, t))
            elif tag == "Compile" and el.get("Include"):
                inc = el.get("Include")
                if "$(" in inc.replace("$(MSBuildThisFileDirectory)", "").replace("$(MSBuildProjectDirectory)", ""):
                    facts["computed_includes"].append(f"{ipath}: {inc}")
                    continue
                # Item paths are relative to the project, even in an imported file.
                absolute = "$(MSBuildThisFileDirectory)" in inc or "$(MSBuildProjectDirectory)" in inc
                inc = inc.replace("$(MSBuildThisFileDirectory)", (idir + "/") if idir else "").replace("$(MSBuildProjectDirectory)", folder + "/" if folder else "")
                for part in inc.split(";"):
                    if part.strip():
                        linked.add(_link_target(folder, part.strip(), folder, absolute=absolute))
    for el in root.iter():
        if _local(el.tag) == "Compile" and el.get("Include"):
            inc = el.get("Include")
            if "$(" in inc:
                facts["computed_includes"].append(f"{path}: {inc}")
                continue
        if _local(el.tag) in ("Compile", "Content", "None") and el.get("Include") and "$(" not in el.get("Include"):
            for part in el.get("Include").split(";"):
                if part.strip():
                    linked.add(_link_target(folder, part.strip(), folder))
    facts["linked_folders"] = sorted(f for f in linked if f)
    return facts


def _link_target(base: str, include: str, folder: str, absolute: bool = False) -> str | None:
    """The folder an item include outside the project points to (None when it stays inside the project)."""
    inc = include.replace("\\", "/")
    target = norm(inc if absolute else posixpath.join(base, inc))
    if target.startswith("..") or target == folder or target.startswith(folder + "/"):
        return None
    head = target.split("*", 1)[0].rstrip("/")
    if "*" in target:
        return head if not head.endswith(".cs") else posixpath.dirname(head)
    return posixpath.dirname(target) if "." in posixpath.basename(target) else target


def finish(facts: dict) -> dict:
    """The facts that follow from the properties: output type (MSBuild's default per SDK) and test project."""
    props = facts["properties"]
    facts["output_type_explicit"] = "OutputType" in props
    # MSBuild's default: a library for the plain and Razor SDKs, an executable for the others (Web, Worker, AppHost, MSTest).
    default_output = "Library" if (facts["sdk"] or "Microsoft.NET.Sdk").lower() in ("microsoft.net.sdk", "microsoft.net.sdk.razor") else "Exe"
    facts["output_type"] = props.get("OutputType") or default_output
    facts["test_project"] = (str(props.get("IsTestProject", "")).lower() == "true" or (facts["sdk"] or "").lower() == "mstest.sdk"
                             or bool(facts.get("test_refs")))
    return facts


def variants_of(facts: dict, limit: int = 32) -> list[dict]:
    """The facts for every combination of the values conditional properties can end with (the facts themselves
    when there is none); None when there are more combinations than `limit`."""
    import itertools
    names = sorted(facts.get("variants") or {})
    if not names:
        return [facts]
    combos = list(itertools.islice(itertools.product(*[facts["variants"][n] for n in names]), limit + 1))
    if len(combos) > limit:
        return None
    out = []
    for combo in combos:
        f = {**facts, "properties": dict(facts["properties"])}
        for n, v in zip(names, combo):
            if v is None:
                f["properties"].pop(n, None)
            else:
                f["properties"][n] = v
        out.append(finish(f))
    return out


MAP_CALL_RX = re.compile(r"\.Map(Get|Post|Put|Delete|Patch|Methods|Group)\s*\(\s*([^,)]*)")
ROUTE_ATTR_RX = re.compile(r"\[(?:Route|Http(?:Get|Post|Put|Delete|Patch))\s*\(\s*([^,)\]]+)")
CONST_RX = re.compile(r"""\bstring\s+(\w+)\s*=\s*@?"([^"]*)"\s*;""")


def _is_api_route(value: str) -> bool:
    v = value.strip().lstrip("~").lstrip("/").lower()
    return v == "api" or v.startswith(("api/", "api{"))


def _route_value(expr: str, constants: dict[str, str]) -> str | None:
    """The leading text of a route expression: a literal, a simple string constant, `Const + "..."`, or an
    interpolated string starting with a constant. None when it cannot be read without running the code."""
    e = expr.strip()
    m = re.match(r'@?"([^"]*)"', e)
    if m:
        return m.group(1)
    if e.startswith("$"):
        m = re.match(r'\$@?"\{([\w.]+)\}([^"]*)', e)
        if m:
            head = constants.get(m.group(1).split(".")[-1])
            return None if head is None else head + m.group(2)
        m = re.match(r'\$@?"([^{"]+)', e)
        return m.group(1) if m else None
    m = re.match(r"([A-Za-z_][\w.]*)", e)
    if m and m.group(1).split(".")[-1] in constants:
        return constants[m.group(1).split(".")[-1]]
    return None


def content_traits(folder: str, files: list[str], read) -> dict:
    """What the project's code does, for the conventions' `content`: whether it maps endpoints (C# minimal APIs,
    gRPC services, controllers), and whether any route is under /api. Routes are read through string constants
    (`const string Prefix = "/api"`); a route the classifier cannot read is listed in `unreadable_routes`."""
    traits = {"maps_endpoints": False, "maps_api_routes": False, "unreadable_routes": []}
    texts = []
    for f in files:
        if not f.startswith(folder + "/") or not f.lower().endswith(".cs") or "/bin/" in f or "/obj/" in f:
            continue
        texts.append((f, read(f) or ""))
    constants = {name: value for _, t in texts for name, value in CONST_RX.findall(t)}
    for f, text in texts:
        traits["maps_endpoints"] = traits["maps_endpoints"] or bool(ENDPOINT_RX.search(text))
        for rx in (MAP_CALL_RX, ROUTE_ATTR_RX):
            for m in rx.finditer(text):
                expr = m.groups()[-1]
                if not expr.strip():
                    continue
                value = _route_value(expr, constants)
                if value is None:
                    traits["unreadable_routes"].append(f"{f}: {expr.strip()[:60]}")
                elif _is_api_route(value):
                    traits["maps_api_routes"] = True
    return traits


# The toolchain's own evaluation (MSBuild), where it is installed: the SDK flags and the explicit properties it
# resolves, to compare with the parse. A disagreement goes to a person. Off with ARCH_MSBUILD_EVAL=0.
SDK_FLAGS = {"Microsoft.NET.Sdk.Web": "UsingMicrosoftNETSdkWeb", "Microsoft.NET.Sdk.Worker": "UsingMicrosoftNETSdkWorker",
             "Microsoft.NET.Sdk.Razor": "UsingMicrosoftNETSdkRazor", "Aspire.AppHost.Sdk": "IsAspireHost"}
_EVAL_CACHE: dict = {}


def eval_disabled() -> bool:
    import os
    return os.environ.get("ARCH_MSBUILD_EVAL", "1") == "0"


def msbuild_evaluate(manifest_abs: str, props: list[str], configuration: str = "Debug") -> dict | None:
    """MSBuild's evaluation of the project's properties in one configuration, or None (no toolchain, or it failed)."""
    import json as _json
    import os
    import shutil
    import subprocess
    if eval_disabled() or not shutil.which("dotnet") or not os.path.isfile(manifest_abs):
        return None
    key = (manifest_abs, os.path.getmtime(manifest_abs), tuple(props), configuration)
    if key not in _EVAL_CACHE:
        try:
            r = subprocess.run(["dotnet", "msbuild", manifest_abs, "-nologo", f"-p:Configuration={configuration}", *[f"-getProperty:{p}" for p in props]],
                               capture_output=True, text=True, timeout=180, env={**os.environ, "DOTNET_CLI_TELEMETRY_OPTOUT": "1", "DOTNET_NOLOGO": "1"})
            out = _json.loads(r.stdout).get("Properties") if r.returncode == 0 and r.stdout.strip().startswith("{") else None
        except Exception:  # noqa: BLE001 - no evaluation: reported by the caller
            out = None
        _EVAL_CACHE[key] = out
    return _EVAL_CACHE[key]


EVAL_CONFIGURATIONS = ("Debug", "Release")


def evaluate_all(manifest_abs: str, props: list[str]) -> dict[str, dict] | None:
    """MSBuild's evaluation in every configuration a build can use (Debug and Release); None if any one failed."""
    out = {}
    for c in EVAL_CONFIGURATIONS:
        e = msbuild_evaluate(manifest_abs, props, c)
        if e is None:
            return None
        out[c] = e
    return out


def evaluation_disagreements(facts: dict, evaluated: dict | None, wanted: set[str] | None = None) -> list[str]:
    """Where MSBuild's evaluation (one configuration's properties) contradicts the parse: the SDK flags, the output
    type and UseMaui (explicit or not), a test project MSBuild knows of, and the properties the conventions read."""
    if not evaluated:
        return []
    out = []
    sdk = facts.get("sdk") or ""
    for name, flag in SDK_FLAGS.items():
        on = str(evaluated.get(flag, "")).lower() == "true"
        expected = sdk.lower() == name.lower() or (name == "Microsoft.NET.Sdk.Razor" and sdk.lower() == "microsoft.net.sdk.web")
        if sdk.lower() in (*(k.lower() for k in SDK_FLAGS), "microsoft.net.sdk") and on != expected:
            out.append(f"MSBuild says {flag}={evaluated.get(flag) or 'unset'} for an SDK read as {sdk}")
    possible = {str(v.get("output_type", "")).lower() for v in (variants_of(facts) or [facts])}
    if str(evaluated.get("OutputType", "")).lower() not in possible:
        out.append(f"MSBuild evaluates OutputType to {evaluated.get('OutputType') or 'unset'}, the classifier read {facts['output_type']}")
    for prop in sorted({"UseMaui", *(wanted or ())} - {"OutputType", "IsTestProject"}):
        values = {str(v.get("properties", {}).get(prop, "")).lower() for v in (variants_of(facts) or [facts])}
        if str(evaluated.get(prop, "")).lower() not in values:
            out.append(f"MSBuild evaluates {prop} to {evaluated.get(prop) or 'unset'}, the classifier read {facts['properties'].get(prop) or 'unset'}")
    if str(evaluated.get("IsTestProject", "")).lower() == "true" and not facts.get("test_project"):
        out.append("MSBuild says IsTestProject=true, the classifier read no test project")
    return out


def _matches(match: dict, facts: dict) -> bool:
    folder, name = facts["dir"], facts["name"].lower()
    if match.get("roots") and not any(_glob(folder, r) for r in match["roots"]):
        return False
    if match.get("sdk") is not None and (facts["sdk"] or "").lower() not in [x.lower() for x in match["sdk"]]:
        return False
    if "test_project" in match and bool(match["test_project"]) != facts["test_project"]:
        return False
    if match.get("output_type") and (facts["output_type"] or "").lower() != str(match["output_type"]).lower():
        return False
    # Names compare without case: `src/Probe.Api` is `*.API`.
    if match.get("name") and not any(fnmatch.fnmatchcase(name, n.lower()) for n in match["name"]):
        return False
    if match.get("not_name") and any(fnmatch.fnmatchcase(name, n.lower()) for n in match["not_name"]):
        return False
    for k, v in (match.get("properties") or {}).items():
        if str(facts["properties"].get(k, "")).lower() != str(v).lower():
            return False
    for k in match.get("properties_absent") or []:
        if k in facts["properties"]:
            return False
    return True


def _inside(child: str, parent: str) -> bool:
    return child == parent or child.startswith(parent + "/")


def _imports(folder: str, files: set[str], read) -> dict[str, str]:
    """The Directory.Build.* and Directory.Packages.props files MSBuild may import for a project in `folder`."""
    out = {}
    parts = folder.split("/") if folder else []
    # Names compare without case: a case-insensitive file system (macOS, Windows) imports directory.build.targets.
    by_lower: dict[str, list[str]] = {}
    for f in files:
        if posixpath.basename(f).lower() in ("directory.build.props", "directory.build.targets", "directory.packages.props"):
            by_lower.setdefault(f.lower(), []).append(f)
    for i in range(len(parts), -1, -1):
        base = "/".join(parts[:i])
        for name in ("Directory.Build.props", "Directory.Build.targets", "Directory.Packages.props"):
            want = (f"{base}/{name}" if base else name).lower()
            for f in by_lower.get(want, []):
                out[f] = read(f) or ""
    return out


def _convention_properties(conventions: list[dict]) -> set[str]:
    out = set()
    for c in conventions:
        m = c.get("match") or {}
        out |= set((m.get("properties") or {}).keys()) | set(m.get("properties_absent") or [])
    return out


def derive(profile: dict, manifests: dict[str, str | None], declared: list[dict], *, files=None, read=None, root=None) -> tuple[list[dict], dict[str, dict]]:
    """(derived projects, unclassified {manifest: {reason, needs_person}}) for the manifests the profile does not list.
    `declared` are the validated new services ({id, roots, owns_datastores}) from topology.py. `files` (every
    repository file) and `read` give the imports and the project's code; `root` (the checkout on disk) lets the
    toolchain evaluate the manifest. Each derived project carries `convention` and `facts`: what it was derived from."""
    explicit = [norm(p["path"]) for p in profile.get("projects", []) or []]
    conf = profile.get("classification") or {}
    conventions = conf.get("conventions") or []
    names = {str(k).casefold(): v for k, v in (conf.get("service_names") or {}).items()}
    known_services = {s.get("id") for s in profile.get("services", []) or []}
    folders = {norm(m): posixpath.dirname(norm(m)) for m in manifests}
    per_folder: dict[str, list[str]] = {}
    for m, f in folders.items():
        per_folder.setdefault(f, []).append(m)
    all_files = set(files if files is not None else manifests)
    read = read or (lambda f: manifests.get(f))
    wanted = _convention_properties(conventions)
    derived: list[dict] = []
    unclassified: dict[str, dict] = {}

    def refuse(manifest: str, reason: str, needs_person: bool = True) -> None:
        unclassified[manifest] = {"reason": reason, "needs_person": needs_person}

    for manifest, folder in sorted(folders.items()):
        if folder in explicit:
            continue
        holder = next((e for e in explicit if _inside(folder, e) or _inside(e, folder)), None)
        if holder is not None:
            refuse(manifest, f"it is nested in, or contains, the profiled project at {holder}; nested projects are classified by a person")
            continue
        if len(per_folder[folder]) > 1:
            refuse(manifest, f"its folder {folder} holds {len(per_folder[folder])} project manifests ({', '.join(posixpath.basename(m) for m in sorted(per_folder[folder]))}); a person must classify them")
            continue
        other = next((f for m, f in folders.items() if m != manifest and f != folder and (_inside(folder, f) or _inside(f, folder))), None)
        if other is not None:
            refuse(manifest, f"it is nested in, or contains, the project at {other}; nested projects are classified by a person")
            continue
        if not conventions:
            refuse(manifest, "the profile has no classification conventions, so every new project is classified by a person")
            continue
        facts = project_facts(manifest, manifests[manifest], wanted=wanted, imports=_imports(folder, all_files, read), read=read)
        evaluation = "not evaluated (no checkout on disk)"
        if root is not None and re.search(r"\.(cs|fs|vb)proj$", manifest, re.I):
            import os
            if eval_disabled():
                evaluation = "not evaluated by MSBuild (ARCH_MSBUILD_EVAL=0)"
            else:
                props = sorted(set(SDK_FLAGS.values()) | {"OutputType", "UseMaui", "IsTestProject"} | wanted)
                evaluated = evaluate_all(os.path.join(str(root), manifest), props)
                if evaluated is None:
                    facts["ambiguous"].append("the MSBuild cross-check could not run here (no .NET SDK, or the evaluation failed), so the facts are unconfirmed")
                else:
                    for config, e in evaluated.items():
                        facts["ambiguous"] += [f"{d} ({config})" for d in evaluation_disagreements(facts, e, wanted)]
                    evaluation = f"evaluated by MSBuild in {' and '.join(evaluated)}: SDK, OutputType, UseMaui, IsTestProject{''.join(', ' + w for w in sorted(wanted - {'OutputType', 'UseMaui', 'IsTestProject'}))}"
        if facts["ambiguous"]:
            refuse(manifest, "MSBuild could read it differently than the classifier: " + "; ".join(facts["ambiguous"]) + "; a person must classify it")
            continue
        variants = variants_of(facts)
        if variants is None:
            refuse(manifest, f"too many properties are set under a Condition ({', '.join(sorted(facts['variants']))}); a person must classify it")
            continue
        fit_sets = [tuple(id(c) for c in conventions if _matches(c.get("match") or {}, v)) for v in variants]
        if len(set(fit_sets)) > 1:
            refuse(manifest, f"{', '.join(sorted(facts['variants']))} {'is' if len(facts['variants']) == 1 else 'are'} set under a Condition, and the class depends on the value; a person must classify it")
            continue
        fits = [c for c in conventions if _matches(c.get("match") or {}, facts)]
        described = f"(name {facts['name']}, SDK {facts['sdk'] or 'none'}, {'a test project' if facts['test_project'] else 'not a test project'}, output {facts['output_type'] or 'n/a'})"
        if not fits:
            refuse(manifest, f"it fits none of the profile's classification conventions {described}; a person must extend the conventions or list the project")
            continue
        if len(fits) > 1:
            refuse(manifest, f"it fits several classification conventions ({', '.join(c['type'] + '/' + c['layer'] for c in fits)}) {described}; a person must make the conventions distinct")
            continue
        conv = fits[0]
        notes = []
        if conv.get("content"):
            traits = content_traits(folder, sorted(all_files), read)
            clash = []
            for k, want in conv["content"].items():
                if traits.get(k) == bool(want):
                    continue
                # Decision (docs/architecture-policy.md): a class that must map endpoints accepts a project that maps
                # none YET (a scaffolding ticket); it is shown as a note, and the class's rules apply when it does.
                if k == "maps_endpoints" and want and not traits.get(k):
                    notes.append("it maps no endpoint yet")
                    continue
                clash.append(f"{k} is {str(traits.get(k)).lower()}")
            if conv["content"].get("maps_api_routes") is False and traits["unreadable_routes"]:
                clash.append(f"routes the classifier cannot read ({'; '.join(traits['unreadable_routes'][:3])})")
            if clash:
                refuse(manifest, f"its code contradicts the {conv['type']}/{conv['layer']} class its manifest fits ({', '.join(clash)}, the convention wants {', '.join(f'{k}={str(v).lower()}' for k, v in conv['content'].items())}); a person must classify it")
                continue
        project = {"name": facts["name"], "path": folder, "type": conv["type"], "layer": conv["layer"], "derived": True,
                   "convention": f"{conv['type']}/{conv['layer']}", "manifest": manifest,
                   "facts": {"sdk": facts["sdk"], "test_project": facts["test_project"], "output_type": facts["output_type"],
                             "properties": facts["properties"], "conditional": sorted(facts["variants"]),
                             "evaluated_by_msbuild": evaluation.startswith("evaluated"), "evaluation": evaluation, "notes": notes}}
        if conv.get("service") == "required":
            candidates = set()
            by_name = names.get(facts["name"].split(".")[0].casefold()) or names.get(facts["name"].casefold())
            if by_name in known_services:
                candidates.add(by_name)
            for s in declared:
                if any(_inside(folder, r) for r in s.get("roots", [])):
                    candidates.add(s["id"])
            if not candidates:
                refuse(manifest, f"{'an' if conv['type'][:1] in 'aeiou' else 'a'} {conv['type']} project belongs to a service, and its name ({facts['name']}) maps to none of the profile's services. If it is a NEW service, declare it in the topology file under policy.services (id, roots: [\"{folder}\"]); a project of an existing service needs its name in the profile's service_names (a person)", needs_person=False)
                continue
            if len(candidates) > 1:
                refuse(manifest, f"its name and a declared service give different services ({', '.join(sorted(candidates))}); a person must decide")
                continue
            project["service"] = candidates.pop()
        derived.append(project)
    return derived, unclassified


def new_service_traits(profile: dict, service_id: str, derived: list[dict], owns: list[str]) -> list[str]:
    conv = {(c["type"], c["layer"]): c for c in (profile.get("classification") or {}).get("conventions") or []}
    traits = {t for p in derived if p.get("service") == service_id for t in conv.get((p["type"], p["layer"]), {}).get("traits", [])}
    if owns:
        traits.add("owns_database")
    return sorted(traits)
