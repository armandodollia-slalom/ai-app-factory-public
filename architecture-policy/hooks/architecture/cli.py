"""Command-line front end for the architecture hook operations.

Every adapter (Git pre-commit, CI, agents via shell) goes through this module, which only translates
arguments into calls of the operations in architecture/__init__.py.
"""
from __future__ import annotations

import argparse
import glob as globlib
import json
import sys
from pathlib import Path

from . import (NotFound, OPERATIONS, explain_finding, get_applicable_rules, get_examples, get_failure_history,
               get_lessons, get_pattern, get_rule, validate)
from .policy import CHECKPOINTS, NoPolicyConfigured, get_pack, not_configured

SARIF_LEVEL = {"BLOCK": "error", "WARN": "warning", "INFO": "note", "WAIVED": "none"}


def _load_json_arg(value: str | None):
    if not value:
        return None
    if value == "-":
        return json.load(sys.stdin)
    p = Path(value)
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    return json.loads(value)


def _expand(patterns: list[str] | None, repo_root: Path) -> list[str]:
    out = []
    for pat in patterns or []:
        hits = globlib.glob(pat, recursive=True) or globlib.glob(str(repo_root / pat), recursive=True)
        out.extend(hits or [pat])
    return out


def to_sarif(result: dict, pack) -> dict:
    rules_used = sorted({f["rule_id"] for f in result["findings"]})
    rule_defs = []
    for rid in rules_used:
        r = pack.rules.get(rid)
        if not r:
            continue
        rule_defs.append({
            "id": rid, "name": r["title"],
            "shortDescription": {"text": r["title"]},
            "fullDescription": {"text": " ".join(r["description"].split())},
            "help": {"text": r["remediation"]["summary"]},
            "properties": {"category": r["category"], "severity": r["severity"], "mode": r["validation"]["mode"]},
        })
    results = []
    for f in result["findings"]:
        res = {
            "ruleId": f["rule_id"],
            "level": SARIF_LEVEL[f["outcome"]],
            "message": {"text": f"{f['message']} Remediation: {f['remediation']}"},
            "partialFingerprints": {"architectureFindingId": f["finding_id"]},
            "properties": {"outcome": f["outcome"], "status": f["status"], "validator": f["validator"],
                           "exception": (f.get("exception") or {}).get("id")},
        }
        if f.get("file"):
            loc = {"artifactLocation": {"uri": f["file"]}}
            if f.get("line"):
                loc["region"] = {"startLine": int(f["line"])}
            res["locations"] = [{"physicalLocation": loc}]
        if f["outcome"] == "WAIVED":
            res["suppressions"] = [{"kind": "external", "justification": f"Exception {(f.get('exception') or {}).get('id')}"}]
        results.append(res)
    return {
        "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
        "version": "2.1.0",
        "runs": [{
            "tool": {"driver": {"name": "architecture-policy", "version": result["policy"]["version"],
                                "informationUri": pack.rel("architecture-rules.md"), "rules": rule_defs}},
            "automationDetails": {"id": f"architecture/{result['checkpoint']}/{result['run_id']}"},
            "results": results,
            "properties": {"decision": result["decision"], "policy_sha256": result["policy"]["content_sha256"]},
        }],
    }


def format_text(result: dict) -> str:
    lines = [f"Architecture policy [{result['checkpoint']}] decision: {result['decision']}  "
             f"(run {result['run_id']}, policy {result['policy']['version']})"]
    s = result["summary"]
    lines.append(f"  rules evaluated: {s['rules_evaluated']}, not applicable: {s['rules_not_applicable']}, "
                 f"skipped: {s['rules_skipped']}, findings: {s['findings_by_outcome'] or {}}")
    order = {"BLOCK": 0, "WARN": 1, "INFO": 2, "WAIVED": 3}
    for f in sorted(result["findings"], key=lambda f: (order[f["outcome"]], f["rule_id"], f.get("file") or "")):
        loc = f" {f['file']}:{f['line']}" if f.get("file") and f.get("line") else (f" {f['file']}" if f.get("file") else "")
        exc = f.get("exception")
        if not exc:
            waived = ""
        elif f["outcome"] == "WAIVED":
            waived = f" [waived by {exc['id']}]"
        elif exc.get("status") == "unapproved":
            waived = f" [proposed exception {exc['id']} is not approved]"
        else:
            waived = f" [exception {exc['id']} is {exc.get('status', 'not active')}]"
        lines.append(f"  {f['outcome']:<6} {f['rule_id']:<9}{loc} - {f['message']}{waived}")
        if f["outcome"] in ("BLOCK", "WARN"):
            lines.append(f"         fix: {f['remediation']}  (explain: arch.py explain {f['finding_id']})")
    if result["review_requests"]:
        lines.append(f"  {len(result['review_requests'])} semantic review request(s): "
                     + ", ".join(r["rule_id"] for r in result["review_requests"])
                     + " - answer via artifacts.semantic_judgments")
    for e in result["exceptions"]["expiring_soon"]:
        lines.append(f"  NOTE exception {e['id']} ({e['rule_id']}) expires {e['expires']} ({e['days_remaining']} days)")
    if result["evidence"]["bundle_path"]:
        lines.append(f"  evidence: {result['evidence']['bundle_path']}")
    return "\n".join(lines)


def format_history(rep: dict) -> str:
    t = rep["totals"]
    lines = [f"Architecture failure history ({rep['store']['path']}, last {rep['window']['since_days']} days)"]
    if not t.get("runs"):
        return lines[0] + "\n  no runs recorded"
    lines.append(f"  runs: {t['runs']} (BLOCK {t.get('block_runs') or 0}, WARN {t.get('warn_runs') or 0}, "
                 f"PASS {t.get('pass_runs') or 0}); findings: {t.get('findings') or 0} across "
                 f"{t.get('distinct_rules') or 0} rules / {t.get('distinct_files') or 0} files")
    if rep["top_rules"]:
        lines.append("  top failing rules:")
        lines += [f"    {r['rule_id']:<9} {r['failures']:>4} findings in {r['runs']} runs, {r['distinct_files']} files "
                  f"(blocks {r['blocks']}, last {r['last_seen'][:10]})" for r in rep["top_rules"]]
    if rep["top_files"]:
        lines.append("  hotspot files:")
        lines += [f"    {r['failures']:>4}  {r['file']}  [{', '.join(r['rules'])}]" for r in rep["top_files"]]
    if rep["recurring_findings"]:
        lines.append("  recurring findings:")
        lines += [f"    {r['finding_id']}  x{r['occurrences']}  {'OPEN ' if r['still_open'] else 'fixed'}  "
                  f"{r['file'] or ''}  {(r['message'] or '')[:80]}" for r in rep["recurring_findings"]]
    if rep["by_caller"]:
        lines.append("  by caller: " + ", ".join(f"{c['caller']}={c['runs']} (block {c['block_runs']})" for c in rep["by_caller"]))
    return "\n".join(lines)


def _dump(obj, out=None):
    print(json.dumps(obj, indent=2, default=str), file=out or sys.stdout)


def main(argv: list[str] | None = None) -> int:
    # Accepted before or after the command, so adapters can append them to any call.
    where = argparse.ArgumentParser(add_help=False)
    where.add_argument("--policy-dir", default=argparse.SUPPRESS,
                       help="policy content (default $ARCH_POLICY_DIR, else <workspace>/.factory/policy)")
    where.add_argument("--workspace", default=argparse.SUPPRESS,
                       help="repository under review (default $ARCH_WORKSPACE, else the git top level of the current directory)")
    ap = argparse.ArgumentParser(prog="arch.py", description="Architecture Policy Pack engine", parents=[where])
    commands = ap.add_subparsers(dest="cmd", required=True)

    def command(name, **kw):
        return commands.add_parser(name, parents=[where], **kw)

    p = command("rules", help="architecture.get_applicable_rules(context)")
    p.add_argument("--checkpoint", choices=CHECKPOINTS)
    p.add_argument("--files", nargs="*")
    p.add_argument("--category", action="append")
    p.add_argument("--severity", action="append")

    p = command("rule", help="architecture.get_rule(rule_id)")
    p.add_argument("rule_id")
    p = command("pattern", help="architecture.get_pattern(pattern_id)")
    p.add_argument("pattern_id")
    p = command("examples", help="architecture.get_examples(pattern_id)")
    p.add_argument("pattern_id")
    p.add_argument("--kind", choices=["approved", "anti_pattern"])

    p = command("validate", help="architecture.validate(checkpoint, context, artifacts)")
    p.add_argument("--checkpoint", required=True, choices=CHECKPOINTS)
    p.add_argument("--caller", default="cli")
    p.add_argument("--scope", choices=["changed", "all"])
    p.add_argument("--base", help="git base ref for change detection (default: the first of origin/main, main, origin/HEAD, origin/master, master that exists)")
    p.add_argument("--files", nargs="*", help="explicit changed files (skips git change detection)")
    p.add_argument("--rule", action="append", dest="rule_ids")
    p.add_argument("--category", action="append", dest="categories")
    p.add_argument("--artifacts", help="artifacts JSON (inline, file path, or '-' for stdin)")
    p.add_argument("--judgments", help="semantic_judgments JSON file/inline")
    p.add_argument("--approvals", help="approvals JSON file/inline")
    p.add_argument("--test-results", nargs="*", help="TRX/JUnit files or globs")
    p.add_argument("--coverage", nargs="*", help="Cobertura files or globs")
    p.add_argument("--format", choices=["text", "json", "sarif"], default="text")
    p.add_argument("--output", help="write the formatted result to a file as well")
    p.add_argument("--strict", action="store_true", help="WARN exits non-zero (3)")
    p.add_argument("--no-evidence", action="store_true", help="do not write an evidence bundle")
    p.add_argument("--no-history", action="store_true", help="do not record this run in the failure history")
    p.add_argument("--worktree", action="store_true", help="pre_commit: read the working tree instead of the index")

    p = command("explain", help="architecture.explain_finding(finding_id)")
    p.add_argument("finding_id")

    p = command("history", help="architecture.get_failure_history(query)")
    p.add_argument("--since-days", type=int, default=30)
    p.add_argument("--checkpoint", choices=CHECKPOINTS)
    p.add_argument("--caller", help="caller prefix, e.g. git-pre-commit or arch-review-agent")
    p.add_argument("--branch")
    p.add_argument("--rule", dest="rule_id")
    p.add_argument("--category")
    p.add_argument("--file", help="path prefix")
    p.add_argument("--limit", type=int, default=10)
    p.add_argument("--format", choices=["text", "json"], default="text")

    p = command("lessons", help="architecture.get_lessons(query): denials + prompt-ready lessons for one agent")
    p.add_argument("--agent", required=True, help="caller name, e.g. test-agent")
    p.add_argument("--checkpoint", choices=CHECKPOINTS)
    p.add_argument("--since-days", type=int, default=90)
    p.add_argument("--limit", type=int, default=10)
    p.add_argument("--min-occurrences", type=int, default=2)
    p.add_argument("--format", choices=["md", "json"], default="md", help="md = the prompt block only")
    p.add_argument("--out", help="write to this file (e.g. the agent's instructions include) instead of stdout")

    p = command("call", help="JSON-in/JSON-out call of any operation (for agents and tools)")
    p.add_argument("operation", choices=sorted(OPERATIONS))
    p.add_argument("request", nargs="?", default="{}", help="request JSON (inline, file path, or '-')")

    p = command("selfcheck", help="validate the policy itself")
    p.add_argument("--format", choices=["text", "json"], default="text")
    p.add_argument("--skip-self-tests", action="store_true")
    p.add_argument("--skip-workspace", action="store_true",
                   help="skip the checks that need the code under review (project paths, exemplars, stale exceptions)")

    p = command("classes", help="the class of every project: listed in the profile, derived (with the convention and facts), or unclassified (why)")
    p.add_argument("--base", help="only the projects a change from this ref touches")
    p.add_argument("--format", choices=["text", "json", "markdown"], default="text")

    p = command("docs", help="regenerate architecture-rules.md in the policy directory")
    p.add_argument("--check", action="store_true", help="fail if the file is out of date")

    args = ap.parse_args(argv)
    try:
        pack = get_pack(getattr(args, "policy_dir", None), getattr(args, "workspace", None))
    except NoPolicyConfigured as exc:
        # No policy is a result, not an error: nothing is enforced and nothing blocks.
        if getattr(args, "format", "json") in ("json", "sarif") or args.cmd in ("call", "rules", "rule", "pattern", "examples", "explain"):
            _dump(not_configured(exc))
        else:
            print(f"Architecture policy: {exc}; nothing to check.")
        return 0

    try:
        if args.cmd == "classes":
            return _classes(pack, args)
        if args.cmd == "rules":
            _dump(get_applicable_rules({"checkpoint": args.checkpoint, "files": args.files or [],
                                        "categories": args.category, "severities": args.severity}, pack=pack))
        elif args.cmd == "rule":
            _dump(get_rule(args.rule_id, pack=pack))
        elif args.cmd == "pattern":
            _dump(get_pattern(args.pattern_id, pack=pack))
        elif args.cmd == "examples":
            _dump(get_examples(args.pattern_id, args.kind, pack=pack))
        elif args.cmd == "explain":
            _dump(explain_finding(args.finding_id, pack=pack))
        elif args.cmd == "history":
            q = {k: v for k, v in {"since_days": args.since_days, "checkpoint": args.checkpoint, "caller": args.caller,
                                   "branch": args.branch, "rule_id": args.rule_id, "category": args.category,
                                   "file": args.file, "limit": args.limit}.items() if v is not None}
            rep = get_failure_history(q, pack=pack)
            print(json.dumps(rep, indent=2, default=str) if args.format == "json" else format_history(rep))
        elif args.cmd == "lessons":
            q = {"agent": args.agent, "checkpoint": args.checkpoint, "since_days": args.since_days,
                 "limit": args.limit, "min_occurrences": args.min_occurrences}
            rep = get_lessons({k: v for k, v in q.items() if v is not None}, pack=pack)
            text = json.dumps(rep, indent=2, default=str) if args.format == "json" else (
                rep["prompt"] or f"No recurring architecture denials for {args.agent} in the last {args.since_days} days.\n")
            if args.out:
                Path(args.out).parent.mkdir(parents=True, exist_ok=True)
                Path(args.out).write_text(text, encoding="utf-8")
                print(f"wrote {args.out} ({len(rep['lessons'])} lesson(s), fingerprint {rep['fingerprint']})")
            else:
                print(text, end="" if text.endswith("\n") else "\n")
        elif args.cmd == "call":
            req = _load_json_arg(args.request) or {}
            result = OPERATIONS[args.operation](req, pack=pack)
            _dump(result)
            if args.operation == "validate":
                return result["exit_code"]
        elif args.cmd == "validate":
            artifacts = _load_json_arg(args.artifacts) or {}
            if args.judgments:
                artifacts.setdefault("semantic_judgments", []).extend(_load_json_arg(args.judgments))
            if args.approvals:
                artifacts.setdefault("approvals", []).extend(_load_json_arg(args.approvals))
            if args.test_results is not None:
                artifacts["test_results"] = _expand(args.test_results, pack.repo_root)
            if args.coverage is not None:
                artifacts["coverage_reports"] = _expand(args.coverage, pack.repo_root)
            context = {"caller": args.caller, "scope": args.scope, "base": args.base, "rule_ids": args.rule_ids,
                       "categories": args.categories, "strict": args.strict, "write_evidence": not args.no_evidence,
                       "record_history": not args.no_history, "staged": not args.worktree}
            if args.files is not None:
                context["changed_files"] = args.files
            result = validate(args.checkpoint, context, artifacts, pack=pack)
            if args.format == "json":
                text = json.dumps(result, indent=2, default=str)
            elif args.format == "sarif":
                text = json.dumps(to_sarif(result, pack), indent=2)
            else:
                text = format_text(result)
            print(text)
            if args.output:
                Path(args.output).write_text(text, encoding="utf-8")
            return result["exit_code"]
        elif args.cmd == "selfcheck":
            from .selfcheck import selfcheck
            rep = selfcheck(pack, run_self_tests=not args.skip_self_tests, check_workspace=not args.skip_workspace)
            if args.format == "json":
                _dump(rep)
            else:
                for c in rep["checks"]:
                    print(f"[{c['status'].upper():4}] {c['check']}" + (f" - {c['info']}" if c.get("info") else ""))
                    for e in c["errors"]:
                        print(f"        ERROR {e}")
                    for wmsg in c["warnings"]:
                        print(f"        WARN  {wmsg}")
                print("stats: " + json.dumps(rep["stats"]))
                print("SELFCHECK " + ("PASSED" if rep["ok"] else "FAILED"))
            return 0 if rep["ok"] else pack.manifest["decision"]["exit_codes"]["ERROR"]
        elif args.cmd == "docs":
            from .docs import render
            md = render(pack)
            path = pack.root / "architecture-rules.md"
            if args.check:
                current = path.read_text(encoding="utf-8") if path.exists() else ""
                if current != md:
                    print(f"{pack.rel('architecture-rules.md')} is out of date; run: arch.py docs")
                    return 1
                print("architecture-rules.md is up to date")
            else:
                with open(path, "w", encoding="utf-8", newline="\n") as fh:
                    fh.write(md)
                print(f"wrote {path}")
    except (NotFound, ValueError, KeyError) as exc:
        _dump({"error": type(exc).__name__, "message": str(exc)}, out=sys.stderr)
        return pack.manifest.get("decision", {}).get("exit_codes", {}).get("ERROR", 2)
    return 0


def _classes(pack, args) -> int:
    """`arch.py classes`: what the review sees about each project's class."""
    from .engine import describe_derived
    from .globs import match_any, match_manifest
    from .workspace import Workspace
    ws = Workspace(pack.repo_root, "worktree", exclude=pack.profile.get("global_exclude", []))
    manifests = {f: ws.read(f) for f in ws.list_files() if match_manifest(f, pack.profile.get("project_manifests", []))}
    profile, unclassified, errors = pack.effective_profile(manifests, files=ws.list_files(), read=ws.read, on_disk=True)
    changed = set(ws.changed_files("code_review", args.base)) if args.base else None
    touches = lambda path: changed is None or any(f == path or f.startswith(path.rstrip("/") + "/") for f in changed)
    rows = []
    for p in profile.get("projects", []):
        if not touches(p["path"]):
            continue
        if p.get("derived"):
            rows.append({"kind": "derived", **describe_derived(p)})
        else:
            rows.append({"kind": "listed", "path": p["path"], "type": p.get("type"), "layer": p.get("layer"), "service": p.get("service"),
                         "summary": f"{p['path']}: {p.get('type')}/{p.get('layer')}{', service ' + p['service'] if p.get('service') else ''} (listed in the profile)"})
    for m, info in sorted(unclassified.items()):
        if changed is None or m in changed or touches(m.rsplit("/", 1)[0]):
            rows.append({"kind": "unclassified", "manifest": m, "needs_person": info["needs_person"], "summary": f"{m}: not classified: {info['reason']}"})
    if args.format == "json":
        _dump({"projects": rows, "declaration_errors": errors})
    elif args.format == "markdown":
        derived = [r for r in rows if r["kind"] != "listed"]
        if derived:
            print("## New projects and their classes\n")
            print("The architecture policy derived these classes from the projects themselves (not from its profile). Check that each matches what the project is and does.\n")
            for r in derived:
                print(f"- {r['summary']}")
    else:
        for r in rows:
            print(f"[{r['kind']}] {r['summary']}")
        for e in errors:
            print(f"[declaration refused] {e}")
    return 0
