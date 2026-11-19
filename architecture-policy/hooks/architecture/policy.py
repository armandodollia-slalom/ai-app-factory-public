"""Loads and indexes an architecture policy. The only reader of policy files.

Three locations are kept apart:

* the engine (this package, the validators, the schema, the agents): ENGINE_ROOT, wherever the factory is installed;
* the workspace: the repository under review (`repo_root`);
* the policy directory: the policy content of that repository (`root`): policy.yaml, rules/, patterns/, the profile,
  the validator registry and the exception register. Default `<workspace>/.factory/policy`.
"""
from __future__ import annotations

import hashlib
import importlib
import json
import os
import subprocess
import sys
from pathlib import Path

import posixpath

from . import classify, topology
from .yamlio import load_yaml

ENGINE_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_POLICY_DIR = ".factory/policy"
MANIFEST_FILE = "policy.yaml"
CHECKPOINTS = ("pre_commit", "code_review", "testing", "ci")
NOT_CONFIGURED = "NOT_CONFIGURED"


class PolicyError(Exception):
    pass


class NoPolicyConfigured(PolicyError):
    """The policy directory has no policy.yaml: this repository has no architecture policy. Not a failure."""

    def __init__(self, policy_dir: Path):
        self.policy_dir = Path(policy_dir)
        super().__init__(f"no architecture policy configured ({self.policy_dir / MANIFEST_FILE} not found)")


def not_configured(exc: NoPolicyConfigured) -> dict:
    """The non-blocking result every entry point returns when the repository has no policy."""
    return {"schema": "architecture-not-configured/v1", "status": "not_configured", "decision": NOT_CONFIGURED,
            "can_proceed": True, "exit_code": 0, "summary": str(exc), "message": str(exc),
            "policy_dir": str(exc.policy_dir), "findings": [], "action_items": [], "review_requests": [],
            "lessons": [], "prompt": ""}


def resolve_workspace(workspace: str | Path | None = None) -> Path:
    """The repository under review: argument, then $ARCH_WORKSPACE, then the git top level of the current
    directory, then the current directory."""
    raw = workspace or os.environ.get("ARCH_WORKSPACE")
    if raw:
        return Path(raw).expanduser().resolve()
    try:
        res = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True,
                             encoding="utf-8", errors="replace", timeout=30)
        if res.returncode == 0 and res.stdout.strip():
            return Path(res.stdout.strip()).resolve()
    except (OSError, subprocess.SubprocessError):
        pass
    return Path.cwd().resolve()


def resolve_policy_dir(policy_dir: str | Path | None = None, workspace: str | Path | None = None) -> Path:
    """The policy content: argument, then $ARCH_POLICY_DIR, then <workspace>/.factory/policy. A relative argument
    or variable is relative to the current directory."""
    raw = policy_dir or os.environ.get("ARCH_POLICY_DIR")
    if raw:
        return Path(raw).expanduser().resolve()
    return resolve_workspace(workspace) / DEFAULT_POLICY_DIR


class PolicyPack:
    def __init__(self, root: str | Path | None = None, repo_root: str | Path | None = None, profile: str | None = None):
        self.repo_root = resolve_workspace(repo_root)
        self.root = resolve_policy_dir(root, self.repo_root)
        self.engine_root = ENGINE_ROOT
        if not (self.root / MANIFEST_FILE).is_file():
            raise NoPolicyConfigured(self.root)
        self.load_errors: list[str] = []
        self.schema_errors: list[str] = []
        self.duplicate_ids: list[str] = []
        self.documents: dict[str, dict] = {}  # path relative to the policy directory -> document

        self.schema = json.loads((self.engine_root / "architecture-rule.schema.json").read_text(encoding="utf-8"))
        self.manifest = self._load(MANIFEST_FILE, "PolicyManifest") or {}
        # Profile: an explicit id, then policy.yaml profile_file, then profiles/<default_profile>/profile.yaml,
        # then profile.yaml beside policy.yaml.
        profile_id = profile or (None if self.manifest.get("profile_file") else self.manifest.get("default_profile"))
        self.profile_file = f"profiles/{profile_id}/profile.yaml" if profile_id else self.manifest.get("profile_file", "profile.yaml")
        self.profile = self._load(self.profile_file, "Profile") or {}
        self.profile_id = profile_id or self.profile.get("id") or "default"
        # New services the application declares (`policy.services` in the factory's app.json, topology.py). Projects
        # the profile does not list are classified from the project itself (classify.py), per run.
        self.topology_file = self.manifest.get("topology_file", "../app.json")
        self.topology_path = (self.root / self.topology_file).resolve()
        self.topology_policy, self.topology_read_error = topology.read(self.topology_path)

        self.rules: dict[str, dict] = {}
        self.rule_files: dict[str, str] = {}
        for cat in self.manifest.get("categories", []):
            doc = self._load(cat["file"], "RuleSet")
            if not doc:
                continue
            for rule in doc.get("rules", []):
                self._index(self.rules, rule, cat["file"])
                self.rule_files[rule.get("id")] = cat["file"]

        self.patterns: dict[str, dict] = {}
        for path in sorted((self.root / "patterns").glob("*.yaml")):
            rel = path.relative_to(self.root).as_posix()
            doc = self._load(rel, "Pattern")
            if doc:
                self._index(self.patterns, doc, rel)

        # Paths in rule and pattern texts are rendered from the resolved files, never written as literals:
        # {profile_file} and {topology_file} (repository-relative), so a fix hint names a file that exists.
        for doc in [*self.rules.values(), *self.patterns.values()]:
            self._render(doc)

        self.registry_file = self.manifest.get("validators", {}).get("registry", "validators/registry.yaml")
        registry = self._load(self.registry_file, "ValidatorRegistry") or {}
        self.validators: dict[str, dict] = {}
        for v in registry.get("validators", []):
            self._index(self.validators, v, self.registry_file)

        self.exceptions_file = self.manifest.get("exceptions", {}).get("file", "exceptions/exceptions.yaml")
        exc_doc = self._load(self.exceptions_file, "ExceptionRegister") or {}
        self.exceptions: list[dict] = exc_doc.get("exceptions", []) or []
        seen = set()
        for e in self.exceptions:
            if e.get("id") in seen:
                self.duplicate_ids.append(f"exception {e.get('id')}")
            seen.add(e.get("id"))

        # Evidence types are the policy's own when it ships the file, else the engine's defaults.
        ev_file = self.manifest.get("evidence", {}).get("types_file", "evidence/evidence-types.yaml")
        ev_base = self.root if (self.root / ev_file).is_file() else self.engine_root
        ev_doc = self._load(ev_file if ev_base == self.root else "evidence/evidence-types.yaml", "EvidenceTypes", base=ev_base) or {}
        self.evidence_types: dict[str, dict] = {}
        for t in ev_doc.get("evidence_types", []):
            self._index(self.evidence_types, t, "evidence/evidence-types.yaml")

        self._impl_cache: dict[str, object] = {}

    # -- loading -------------------------------------------------------------------
    def effective_profile(self, manifests: dict, *, files=None, read=None, on_disk: bool = False) -> tuple[dict, dict, list[str]]:
        """The profile a run uses: the governed profile, the declared new services and the projects derived from
        `manifests` ({path: text}). Returns (profile, unclassified {manifest: {reason, needs_person}}, declaration errors)."""
        dirs = {posixpath.dirname(classify.norm(m)) for m in manifests}
        declared, errors = topology.validate(self.profile, self.topology_policy, dirs, root=self.repo_root if on_disk else None)
        if self.topology_read_error:
            errors = [self.topology_read_error] + errors
        derived, unclassified = classify.derive(self.profile, manifests, declared, files=files, read=read,
                                                root=self.repo_root if on_disk else None)
        profile = dict(self.profile)
        profile["projects"] = list(self.profile.get("projects", []) or []) + derived
        profile["services"] = list(self.profile.get("services", []) or []) + [
            {"id": s["id"], "owns_datastores": s["owns_datastores"], "declared": True,
             "traits": classify.new_service_traits(self.profile, s["id"], derived, s["owns_datastores"])} for s in declared]
        return profile, unclassified, errors

    def linked_source_errors(self, manifests: dict, files=None, read=None) -> list[str]:
        """Folders compiled into a project from outside it (linked source) that the profile does not list, including
        compile items a Directory.Build.* file adds (`files` and `read` find those), and compile items whose path is
        computed from properties, which only MSBuild could resolve. Their code would otherwise take the class of
        whatever folder they sit in. Selfcheck and every checkpoint use this."""
        from . import classify
        profiled = [classify.norm(p["path"]) for p in self.profile.get("projects", []) or []]
        all_files = set(files if files is not None else manifests)
        read = read or (lambda f: manifests.get(f))
        missing: dict[str, list[str]] = {}
        computed: dict[str, list[str]] = {}
        for manifest, text in manifests.items():
            folder = classify.posixpath.dirname(classify.norm(manifest))
            facts = classify.project_facts(manifest, text or "", imports=classify._imports(folder, all_files, read), read=read)
            for f in facts["linked_folders"]:
                if not any(f == p or f.startswith(p + "/") for p in profiled):
                    missing.setdefault(f, []).append(manifest)
            for inc in facts["computed_includes"]:
                computed.setdefault(inc, []).append(manifest)
        return ([f"{folder} is compiled into {', '.join(sorted(users))} (linked source) but is not in the profile: add it (usually type library, layer shared)"
                 for folder, users in sorted(missing.items())]
                + [f"{inc.split(': ', 1)[0]} compiles a path computed from properties ({inc.split(': ', 1)[1]}) into {', '.join(sorted(users))}: only MSBuild can resolve it, so a person checks what it adds"
                   for inc, users in sorted(computed.items())])

    def disk_files(self) -> list[str]:
        from .globs import match_any
        exclude = [e for e in self.profile.get("global_exclude", []) if not e.startswith(".factory")]
        out = []
        for path in self.repo_root.rglob("*"):
            rel = path.relative_to(self.repo_root).as_posix()
            if path.is_file() and not rel.startswith((".git/", "node_modules/")) and "/node_modules/" not in rel and not match_any(rel, exclude):
                out.append(rel)
        return sorted(out)

    def disk_read(self, rel: str) -> str | None:
        try:
            return (self.repo_root / rel).read_text(encoding="utf-8", errors="replace")
        except OSError:
            return None

    def disk_manifests(self) -> dict:
        """The project manifests of the repository on disk, for checks that run outside a validation (selfcheck)."""
        from .globs import match_any, match_manifest
        out = {}
        exclude = self.profile.get("global_exclude", [])
        for path in sorted(self.repo_root.rglob("*")):
            if not path.is_file():
                continue
            rel = path.relative_to(self.repo_root).as_posix()
            if match_manifest(rel, self.profile.get("project_manifests", [])) and not match_any(rel, exclude):
                out[rel] = path.read_text(encoding="utf-8", errors="replace")
        return out

    def rel_to_repo(self, path: Path) -> str:
        try:
            return path.resolve().relative_to(self.repo_root.resolve()).as_posix()
        except ValueError:
            return path.as_posix()

    def render_text(self, text: str) -> str:
        return (text.replace("{profile_file}", self.rel_to_repo(self.root / self.profile_file))
                    .replace("{topology_file}", self.rel_to_repo(self.topology_path)))

    def _render(self, node):
        if isinstance(node, dict):
            for k, v in node.items():
                if isinstance(v, str):
                    node[k] = self.render_text(v)
                else:
                    self._render(v)
        elif isinstance(node, list):
            for i, v in enumerate(node):
                if isinstance(v, str):
                    node[i] = self.render_text(v)
                else:
                    self._render(v)

    def _load(self, rel: str, kind: str, base: Path | None = None) -> dict | None:
        path = (base or self.root) / rel
        try:
            doc = load_yaml(path)
        except FileNotFoundError:
            self.load_errors.append(f"{rel}: file not found")
            return None
        except Exception as exc:  # yaml errors
            self.load_errors.append(f"{rel}: YAML parse error: {exc}")
            return None
        if not isinstance(doc, dict):
            self.load_errors.append(f"{rel}: expected a mapping document")
            return None
        if doc.get("kind") != kind:
            self.schema_errors.append(f"{rel}: kind must be {kind!r}, found {doc.get('kind')!r}")
        self.schema_errors.extend(f"{rel}: {e}" for e in self.validate_document(doc, kind))
        self.documents[rel] = doc
        return doc

    def validate_document(self, doc: dict, kind: str) -> list[str]:
        try:
            from jsonschema import Draft202012Validator
        except ImportError:  # selfcheck reports this; runtime validation continues
            return []
        sub = dict(self.schema)
        sub["$ref"] = f"#/$defs/{kind}"
        validator = Draft202012Validator(sub)
        errors = []
        for err in sorted(validator.iter_errors(doc), key=lambda e: list(e.absolute_path)):
            loc = "/".join(str(p) for p in err.absolute_path) or "<root>"
            errors.append(f"{loc}: {err.message}")
        return errors

    def _index(self, table: dict, item: dict, source: str):
        item_id = item.get("id")
        if item_id in table:
            self.duplicate_ids.append(f"{item_id} (in {source})")
        table[item_id] = item

    # -- accessors -------------------------------------------------------------------
    def active_rules(self) -> list[dict]:
        return [r for _, r in sorted(self.rules.items()) if r.get("status") == "active"]

    def checkpoint_config(self, checkpoint: str) -> dict:
        return self.manifest.get("checkpoints", {}).get(checkpoint, {})

    def rel(self, policy_file: str) -> str:
        """A file of the policy directory as callers should cite it: relative to the workspace when it lies inside."""
        path = self.root / policy_file
        try:
            return path.relative_to(self.repo_root).as_posix()
        except ValueError:
            return str(path)

    def implementation(self, ref: str):
        """Resolve 'module:function' from the engine's validators directory. Policy content never supplies code."""
        if ref in self._impl_cache:
            return self._impl_cache[ref]
        module_name, func_name = ref.split(":", 1)
        impl_dir = str(self.engine_root / "validators")
        if impl_dir not in sys.path:
            sys.path.insert(0, impl_dir)
        module = importlib.import_module(module_name)
        fn = getattr(module, func_name)
        if not callable(fn):
            raise PolicyError(f"{ref} is not callable")
        self._impl_cache[ref] = fn
        return fn

    def content_hash(self) -> str:
        """Hash of everything that decides an outcome: the policy content and the engine that evaluates it."""
        h = hashlib.sha256()
        for label, base in (("policy", self.root), ("engine", self.engine_root)):
            for path in sorted(base.rglob("*")):
                if not path.is_file():
                    continue
                rel = path.relative_to(base).as_posix()
                if "__pycache__" in rel or rel.startswith(("tests/", "evidence/runs/", "evidence/history/")):
                    continue
                if path.suffix in (".yaml", ".yml", ".json", ".py", ".md", ".sh", ".ps1"):
                    h.update(f"{label}/{rel}".encode())
                    h.update(path.read_bytes().replace(b"\r\n", b"\n"))
        return h.hexdigest()


_PACK_CACHE: dict[tuple, PolicyPack] = {}


def get_pack(root: str | Path | None = None, repo_root: str | Path | None = None, profile: str | None = None,
             reload: bool = False) -> PolicyPack:
    """The policy of a workspace. `root` is the policy directory and `repo_root` the workspace; see
    resolve_policy_dir and resolve_workspace for what applies when they are omitted. Raises NoPolicyConfigured
    when the policy directory has no policy.yaml."""
    workspace = resolve_workspace(repo_root)
    policy_dir = resolve_policy_dir(root, workspace)
    key = (str(policy_dir), str(workspace), profile)
    if reload or key not in _PACK_CACHE:
        _PACK_CACHE[key] = PolicyPack(policy_dir, workspace, profile)
    return _PACK_CACHE[key]
