"""Tests for the Architecture Policy Pack engine. Run: python -m unittest discover architecture-policy/tests

The engine ships no policy, so most tests run it on the eShop example policy (examples/eshop/.factory/policy)
through the policy-dir mechanism; the last classes cover that mechanism, the no-policy result and the starter
template (templates/policy).
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]
FACTORY = ENGINE.parent
HOOKS = ENGINE / "hooks"
AGENTS = ENGINE / "agents"
ESHOP_POLICY = FACTORY / "examples" / "eshop" / ".factory" / "policy"
TEMPLATE_POLICY = FACTORY / "templates" / "policy"
sys.path.insert(0, str(HOOKS))
sys.path.insert(0, str(AGENTS))

# Never write test runs into the developer's real failure history.
_TMP = tempfile.TemporaryDirectory()
os.environ["ARCH_HISTORY_DB"] = str(Path(_TMP.name) / "history.sqlite")
os.environ["ARCH_HISTORY_LEDGER"] = "off"
os.environ.pop("ARCH_HISTORY", None)
os.environ.pop("ARCH_REVIEW_LLM_CMD", None)
os.environ.pop("ARCH_POLICY_DIR", None)
os.environ.pop("ARCH_WORKSPACE", None)

import architecture  # noqa: E402
from architecture import NotFound  # noqa: E402
from arch_review_agent import ArchReviewAgent  # noqa: E402

# The eShop sources are not in this repository: the workspace is an empty folder and every test supplies its
# files in memory.
WORKSPACE = Path(_TMP.name) / "workspace"
WORKSPACE.mkdir()
PACK = architecture.get_pack(ESHOP_POLICY, WORKSPACE)
CLI_ENV = {**os.environ, "ARCH_POLICY_DIR": str(ESHOP_POLICY), "ARCH_WORKSPACE": str(WORKSPACE)}
API_FILE = "src/Catalog.API/Apis/CatalogApi.cs"
ANON_WRITE = 'api.MapPost("/items", CreateItem);'
SECRET_FILE = "src/Basket.API/Program.cs"
SECRET = 'var pw = "Password=SuperS3cretValue!;";'


def run(checkpoint, files, today="2026-11-09", artifacts=None, **ctx):
    context = {"memory_files": files, "changed_files": list(files), "today": today,
               "write_evidence": False, "record_history": False, "caller": "unittest", **ctx}
    return architecture.validate(checkpoint, context, artifacts or {}, pack=PACK)


def fresh_db():
    fd, path = tempfile.mkstemp(suffix=".sqlite", dir=_TMP.name)
    os.close(fd)
    os.remove(path)
    return path


def outcomes(result, rule_id):
    return [f["outcome"] for f in result["findings"] if f["rule_id"] == rule_id]


class DecisionTests(unittest.TestCase):
    def test_clean_change_passes_pre_commit(self):
        r = run("pre_commit", {"src/Catalog.API/Model/Thing.cs": "namespace Catalog; public record Thing(int Id);"})
        self.assertEqual(r["decision"], "PASS")
        self.assertEqual(r["exit_code"], 0)

    def test_block_dominates(self):
        r = run("pre_commit", {"src/Basket.API/Program.cs": 'var pw = "Password=SuperS3cretValue!;";\nConsole.WriteLine(pw);'})
        self.assertEqual(r["decision"], "BLOCK")
        self.assertEqual(r["exit_code"], 1)
        self.assertIn("BLOCK", outcomes(r, "SEC-001"))

    def test_active_exception_waives_and_expired_exception_enforces(self):
        active = run("pre_commit", {API_FILE: ANON_WRITE}, rule_ids=["API-002"])
        self.assertEqual(outcomes(active, "API-002"), ["WAIVED"])
        self.assertEqual(active["decision"], "PASS")
        self.assertIn("EXC-0001", [e if isinstance(e, str) else e["id"] for e in active["exceptions"]["applied"]])

        expired = run("pre_commit", {API_FILE: ANON_WRITE}, today="2027-03-01", rule_ids=["API-002"])
        self.assertEqual(expired["decision"], "BLOCK")
        self.assertIn("BLOCK", outcomes(expired, "API-002"))

    def test_unapproved_exception_waives_nothing(self):
        from architecture import waivers
        import datetime as _dt
        exc = {"id": "EXC-9", "rule_id": "API-002", "scope": {"paths": ["src/**"]}, "approved_by": "", "approver_role": "architecture-board",
               "created": "2026-01-01", "expires": "2099-01-01"}
        finding = {"rule_id": "API-002", "file": "src/X/Apis/A.cs", "status": "fail", "outcome": "BLOCK", "finding_id": "f1", "message": ""}
        self.assertEqual(waivers.status_of(exc, _dt.date(2026, 6, 1)), "unapproved")
        waivers.apply([exc], [finding], "code_review", _dt.date(2026, 6, 1))
        self.assertEqual(finding["outcome"], "BLOCK")
        self.assertEqual(waivers.status_of(dict(exc, approved_by="jane"), _dt.date(2026, 6, 1)), "active")

    def test_text_output_names_an_unapproved_exception_as_not_approved(self):
        from architecture.cli import format_text
        base = {"checkpoint": "code_review", "decision": "BLOCK", "run_id": "r", "policy": {"version": "1"},
                "summary": {"rules_evaluated": 1, "rules_not_applicable": 0, "rules_skipped": 0, "findings_by_outcome": {"BLOCK": 1}},
                "review_requests": [], "exceptions": {"applied": {}, "expired_hits": {}, "expiring_soon": []}, "evidence": {"bundle_path": None}}
        finding = {"outcome": "BLOCK", "rule_id": "API-002", "file": "src/A/Apis/A.cs", "line": 3, "message": "m", "remediation": "r",
                   "finding_id": "f1", "exception": {"id": "EXC-0001", "status": "unapproved", "expires": "2099-01-01"}}
        text = format_text(dict(base, findings=[finding]))
        self.assertIn("BLOCK  API-002", text)
        self.assertIn("[proposed exception EXC-0001 is not approved]", text)
        self.assertNotIn("waived", text)
        waived = format_text(dict(base, findings=[dict(finding, outcome="WAIVED", exception=dict(finding["exception"], status="active"))]))
        self.assertIn("[waived by EXC-0001]", waived)

    def test_exception_does_not_leak_to_other_services(self):
        r = run("pre_commit", {"src/Ordering.API/Apis/OrdersApi.cs": ANON_WRITE}, rule_ids=["API-002"])
        self.assertEqual(r["decision"], "BLOCK")

    def test_strict_turns_warn_into_nonzero(self):
        files = {"src/Basket.API/Grpc/BasketService.cs": 'Console.WriteLine("basket updated");'}
        r = run("pre_commit", files, rule_ids=["OBS-002"])
        self.assertEqual(r["decision"], "WARN")
        self.assertEqual(r["exit_code"], 0)
        self.assertEqual(run("pre_commit", files, rule_ids=["OBS-002"], strict=True)["exit_code"], 3)


class CheckpointTests(unittest.TestCase):
    def test_pre_commit_never_runs_semantic_validators(self):
        r = run("pre_commit", {API_FILE: ANON_WRITE})
        self.assertEqual(r["review_requests"], [])
        semantic = {f["rule_id"] for f in r["findings"] if f["validation_mode"] == "semantic"}
        self.assertEqual(semantic, set())

    def test_code_review_emits_review_requests_and_accepts_judgments(self):
        files = {API_FILE: "namespace Catalog; public static class CatalogApi { }"}
        first = run("code_review", files)
        self.assertTrue(first["review_requests"], "semantic rules should request review at code_review")
        req = first["review_requests"][0]
        self.assertIn("rubric", req)
        rid = req["rule_id"]

        passed = run("code_review", files, rule_ids=[rid], artifacts={
            "semantic_judgments": [{"rule_id": rid, "verdict": "pass", "rationale": "ok",
                                    "reviewer": {"type": "agent", "id": "review-agent"}}],
            "approvals": [{"rule_id": rid, "approver": "jane", "role": "architect", "date": "2026-11-09"}]})
        self.assertNotIn("WARN", outcomes(passed, rid))
        self.assertNotIn("BLOCK", outcomes(passed, rid))

        failed = run("code_review", files, rule_ids=[rid], artifacts={
            "semantic_judgments": [{"rule_id": rid, "verdict": "fail", "rationale": "violates rubric",
                                    "reviewer": {"type": "agent", "id": "review-agent"},
                                    "findings": [{"file": API_FILE, "line": 1, "message": "bad"}]}]})
        self.assertTrue(set(outcomes(failed, rid)) & {"WARN", "BLOCK"})

    def test_testing_without_test_results_blocks(self):
        r = run("testing", {API_FILE: "namespace Catalog;"}, rule_ids=["TEST-002"])
        self.assertEqual(r["decision"], "BLOCK")
        self.assertTrue(any(f["status"] == "missing_evidence" for f in r["findings"]))

    def test_unknown_checkpoint_rejected(self):
        with self.assertRaises(ValueError):
            architecture.validate("deploy", {}, {}, pack=PACK)


class OperationTests(unittest.TestCase):
    def test_finding_ids_are_stable(self):
        files = {"src/Basket.API/Program.cs": 'var pw = "Password=SuperS3cretValue!;";'}
        a = [f["finding_id"] for f in run("pre_commit", files)["findings"]]
        b = [f["finding_id"] for f in run("pre_commit", files)["findings"]]
        self.assertTrue(a)
        self.assertEqual(a, b)

    def test_explain_finding_falls_back_to_rule(self):
        fid = run("pre_commit", {"src/Basket.API/Program.cs": 'var pw = "Password=SuperS3cretValue!;";'})["findings"][0]["finding_id"]
        exp = architecture.explain_finding(fid, pack=PACK)
        self.assertEqual(exp["rule"]["id"], fid.rsplit("-", 1)[0])
        self.assertIn("steps", exp["how_to_fix"])
        with self.assertRaises(NotFound):
            architecture.explain_finding("NOPE-999-abc", pack=PACK)

    def test_get_operations(self):
        self.assertEqual(architecture.get_rule("SEC-001", pack=PACK)["rule"]["id"], "SEC-001")
        pid = PACK.rules["DATA-003"]["patterns"][0]
        self.assertEqual(architecture.get_pattern(pid, pack=PACK)["pattern"]["id"], pid)
        ex = architecture.get_examples(pid, "approved", pack=PACK)["examples"]
        self.assertTrue(ex and all(e["kind"] == "approved" for e in ex))
        with self.assertRaises(NotFound):
            architecture.get_rule("XYZ-001", pack=PACK)

    def test_get_applicable_rules_filters_by_file_and_checkpoint(self):
        r = architecture.get_applicable_rules({"checkpoint": "pre_commit", "files": [API_FILE]}, pack=PACK)
        ids = {x["id"] for x in r["rules"]}
        self.assertIn("API-002", ids)
        self.assertTrue(all(x["checkpoints"]["pre_commit"] != "off" for x in r["rules"]))
        none = architecture.get_applicable_rules({"files": ["README.md"], "categories": ["data"]}, pack=PACK)
        self.assertEqual(none["count"], 0)

    def test_operations_contract_matches_engine(self):
        contract = json.loads((HOOKS / "operations.json").read_text(encoding="utf-8"))
        self.assertEqual({o["name"] for o in contract["operations"]}, set(architecture.OPERATIONS))

    def test_cli_call_is_same_engine(self):
        out = subprocess.run([sys.executable, str(HOOKS / "arch.py"), "call", "get_rule", '{"rule_id": "ARCH-001"}'],
                             capture_output=True, text=True, encoding="utf-8", env=CLI_ENV)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(json.loads(out.stdout)["rule"]["id"], "ARCH-001")


class HistoryTests(unittest.TestCase):
    def test_failures_are_recorded_and_recurring_findings_reported(self):
        db = fresh_db()
        for _ in range(2):
            r = run("pre_commit", {SECRET_FILE: SECRET}, record_history=True, history_db=db)
            self.assertTrue(r["history"]["recorded"], r["history"])
        run("pre_commit", {"src/Catalog.API/Model/Thing.cs": "public record Thing(int Id);"}, record_history=True, history_db=db)
        h = architecture.get_failure_history({"history_db": db, "since_days": 1}, pack=PACK)
        self.assertEqual((h["totals"]["runs"], h["totals"]["block_runs"], h["totals"]["pass_runs"]), (3, 2, 1))
        self.assertIn("SEC-001", [r["rule_id"] for r in h["top_rules"]])
        rec = [x for x in h["recurring_findings"] if x["rule_id"] == "SEC-001"]
        self.assertTrue(rec and rec[0]["occurrences"] == 2)
        self.assertEqual(rec[0]["callers"], ["unittest"])
        explained = architecture.explain_finding(rec[0]["finding_id"], {"history_db": db}, pack=PACK)
        self.assertEqual(explained["history"]["occurrences"], 2)

    def test_pending_semantic_review_is_not_counted_as_failure_by_default(self):
        db = fresh_db()
        run("code_review", {API_FILE: "namespace Catalog; public static class CatalogApi { }"}, record_history=True, history_db=db)
        default = architecture.get_failure_history({"history_db": db, "min_occurrences": 1}, pack=PACK)
        pending = architecture.get_failure_history({"history_db": db, "min_occurrences": 1, "include_pending_review": True}, pack=PACK)
        self.assertGreater(pending["totals"]["findings"], default["totals"]["findings"])

    def test_record_history_false_and_env_off_skip_recording(self):
        db = fresh_db()
        r = run("pre_commit", {SECRET_FILE: SECRET}, history_db=db)
        self.assertFalse(r["history"]["recorded"])
        os.environ["ARCH_HISTORY"] = "off"
        try:
            r = run("pre_commit", {SECRET_FILE: SECRET}, record_history=True, history_db=db)
            self.assertFalse(r["history"]["recorded"])
        finally:
            os.environ.pop("ARCH_HISTORY")
        self.assertFalse(Path(db).exists())


class ArchReviewAgentTests(unittest.TestCase):
    OPTS = {"write_evidence": False}

    def agent(self, reviewer=None):
        return ArchReviewAgent(pack=PACK, reviewer=reviewer)

    def test_review_blocks_with_actionable_items(self):
        res = self.agent().review({"requester": {"agent": "code-agent"}, "files": {SECRET_FILE: SECRET},
                                   "options": self.OPTS})
        self.assertEqual(res["schema"], "arch-review-result/v1")
        self.assertEqual(res["decision"], "BLOCK")
        self.assertFalse(res["can_proceed"])
        item = next(i for i in res["action_items"] if i["rule_id"] == "SEC-001")
        self.assertEqual(item["outcome"], "BLOCK")
        self.assertTrue(res["next_actions"])
        h = architecture.get_failure_history({"caller": "arch-review-agent:code-agent", "since_days": 1}, pack=PACK)
        self.assertGreaterEqual(h["totals"]["runs"], 1)

    def test_requester_is_required_and_self_certification_rejected(self):
        from arch_review_agent.agent import AgentRequestError
        with self.assertRaises(AgentRequestError):
            self.agent().review({"files": {API_FILE: "x"}})
        files = {API_FILE: "namespace Catalog; public static class CatalogApi { }"}
        first = self.agent().review({"requester": "code-agent", "files": files, "options": self.OPTS})
        rid = first["pending_judgments"][0]["rule_id"]
        res = self.agent().review({"requester": "code-agent", "files": files, "options": self.OPTS, "semantic_judgments": [
            {"rule_id": rid, "verdict": "pass", "rationale": "mine", "reviewer": {"type": "agent", "id": "code-agent"}}]})
        self.assertTrue(any("self-certified" in n for n in res["notes"]))
        self.assertIn(rid, [p["rule_id"] for p in res["pending_judgments"]])

    def test_semantic_reviewer_resolves_pending_rules(self):
        seen = {}

        def reviewer(request):
            seen["rules"] = [r["rule_id"] for r in request["requests"]]
            return [{"rule_id": r, "verdict": "pass", "rationale": "meets rubric"} for r in seen["rules"]]

        files = {API_FILE: "namespace Catalog; public static class CatalogApi { }"}
        res = self.agent(reviewer).review({"requester": "code-agent", "files": files, "options": self.OPTS})
        self.assertTrue(seen["rules"])
        self.assertEqual(res["status"], "completed")
        self.assertEqual(res["pending_judgments"], [])
        self.assertTrue(res["semantic_reviewer"].startswith("arch-review-agent/"))

    def test_iteration_delta_shows_resolved_findings(self):
        first = self.agent().review({"requester": "code-agent", "files": {SECRET_FILE: SECRET}, "options": self.OPTS})
        fixed = 'var pw = builder.Configuration["Basket:Password"];'
        second = self.agent().review({"requester": "code-agent", "files": {SECRET_FILE: fixed}, "options": self.OPTS,
                                      "previous_review_id": first["review_id"]})
        resolved = second["delta"]["resolved"]
        self.assertTrue(any(f.startswith("SEC-001") for f in resolved), second["delta"])
        self.assertNotIn("SEC-001", [i["rule_id"] for i in second["action_items"]])

    def test_advise_returns_rules_and_patterns(self):
        res = self.agent().advise({"files": ["src/Ordering.Infrastructure/OrderingContext.cs"]})
        self.assertTrue(res["rules"])
        self.assertTrue(res["patterns"])

    def test_agent_card_matches_implementation_and_mcp_server(self):
        from arch_review_agent.agent import AGENT_OPERATIONS
        from arch_review_agent import mcp_server
        card = json.loads((AGENTS / "arch_review_agent" / "agent.json").read_text(encoding="utf-8"))
        self.assertEqual({o["name"] for o in card["operations"]}, set(AGENT_OPERATIONS))
        msgs = [{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
                {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                 "params": {"name": "arch_get_rule", "arguments": {"rule_id": "SEC-001"}}}]
        out = subprocess.run([sys.executable, str(AGENTS / "arch_review.py"), "mcp"],
                             input="\n".join(json.dumps(m) for m in msgs) + "\n",
                             capture_output=True, text=True, encoding="utf-8", timeout=60, env=CLI_ENV)
        replies = {r["id"]: r for r in map(json.loads, out.stdout.splitlines())}
        self.assertIn("serverInfo", replies[1]["result"])
        self.assertEqual(len(replies[2]["result"]["tools"]), len(AGENT_OPERATIONS))
        self.assertIn("SEC-001", replies[3]["result"]["content"][0]["text"])
        self.assertTrue(hasattr(mcp_server, "serve"))


class LessonsTests(unittest.TestCase):
    CLEAN = {"src/Catalog.API/Model/Thing.cs": "namespace Catalog; public record Thing(int Id);"}

    def test_lessons_report_denials_reasons_reintroductions_and_prompt(self):
        db = fresh_db()
        seq = [{SECRET_FILE: SECRET}, self.CLEAN, {SECRET_FILE: SECRET}, self.CLEAN]
        for files in seq:
            run("pre_commit", files, record_history=True, history_db=db, caller="test-agent")
        run("pre_commit", {SECRET_FILE: SECRET}, record_history=True, history_db=db, caller="other-agent")
        les = architecture.get_lessons({"agent": "test-agent", "history_db": db}, pack=PACK)
        st = les["denial_stats"]
        self.assertEqual((st["runs"], st["denied_runs"], st["denial_rate"]), (4, 2, 0.5))
        reason = next(r for r in les["denial_reasons"] if r["rule_id"] == "SEC-001")
        self.assertEqual((reason["runs"], reason["reintroduced"]), (2, 1))
        self.assertTrue(reason["why"][0]["message"])
        lesson = next(le for le in les["lessons"] if le["rule_id"] == "SEC-001")
        self.assertTrue(lesson["instead"])
        self.assertIn("SEC-001", les["prompt"])
        self.assertTrue(les["fingerprint"])
        with self.assertRaises(ValueError):
            architecture.get_lessons({"history_db": db}, pack=PACK)

    def test_trend_improves_when_agent_stops_failing(self):
        db = fresh_db()
        for files in [{SECRET_FILE: SECRET}] * 2 + [self.CLEAN] * 2:
            run("pre_commit", files, record_history=True, history_db=db, caller="test-agent")
        self.assertEqual(architecture.get_lessons({"agent": "test-agent", "history_db": db}, pack=PACK)
                         ["denial_stats"]["trend"], "improving")

    def test_agent_feeds_lessons_into_advise_and_flags_repeat_mistakes(self):
        db = fresh_db()
        agent = ArchReviewAgent(pack=PACK)
        req = {"requester": "test-agent", "files": {SECRET_FILE: SECRET}, "context": {"history_db": db},
               "options": {"write_evidence": False}}
        first = agent.review(req)
        self.assertFalse(next(i for i in first["action_items"] if i["rule_id"] == "SEC-001")["repeat_mistake"])
        agent.review(dict(req, files={SECRET_FILE: 'var pw = builder.Configuration["Basket:Password"];'}))
        third = agent.review(req)
        item = next(i for i in third["action_items"] if i["rule_id"] == "SEC-001")
        self.assertTrue(item["repeat_mistake"])
        self.assertTrue(any("get_lessons" in a for a in third["next_actions"]))
        advice = agent.advise({"requester": {"agent": "test-agent"}, "files": [SECRET_FILE], "context": {"history_db": db}})
        self.assertIn("SEC-001", [le["rule_id"] for le in advice["lessons"]["lessons"]])
        self.assertIn("SEC-001", advice["lessons"]["prompt"])
        iters = agent.get_lessons({"agent": "test-agent", "history_db": db})["iterations"]
        self.assertEqual(iters["reviews"], 3)


class SharedLedgerTests(unittest.TestCase):
    """Two teammates (two local sqlite stores) share lessons through the git-tracked ledger."""

    def setUp(self):
        self.ledger = Path(tempfile.mkdtemp(dir=_TMP.name)) / "arch-history"
        os.environ["ARCH_HISTORY_LEDGER"] = str(self.ledger)

    def tearDown(self):
        os.environ["ARCH_HISTORY_LEDGER"] = "off"

    def ledger_files(self):
        return sorted(p.relative_to(self.ledger).as_posix() for p in self.ledger.glob("*/*.json"))

    def test_teammate_lessons_include_denials_recorded_elsewhere(self):
        alice, bob = fresh_db(), fresh_db()
        agent = ArchReviewAgent(pack=PACK)
        req = {"requester": "test-agent", "files": {SECRET_FILE: SECRET}, "context": {"history_db": alice},
               "options": {"write_evidence": False}}
        agent.review(req)
        agent.review(req)
        run("pre_commit", {SECRET_FILE: SECRET}, record_history=True, history_db=alice, caller="git-pre-commit")
        files = self.ledger_files()
        self.assertEqual([f.split("/")[1].split("-")[0] for f in files].count("run"), 2)
        self.assertEqual([f.split("/")[1].split("-")[0] for f in files].count("review"), 2)
        doc = json.loads((self.ledger / files[0]).read_text())
        self.assertEqual(doc["schema"], "arch-history-ledger/v1")
        self.assertIsNone(doc.get("run", {}).get("bundle_path"))

        bob_lessons = architecture.get_lessons({"agent": "test-agent", "history_db": bob}, pack=PACK)
        self.assertEqual(bob_lessons["denial_stats"]["denied_runs"], 2)
        self.assertIn("SEC-001", bob_lessons["prompt"])
        self.assertEqual(bob_lessons["iterations"]["reviews"], 2)
        self.assertEqual(architecture.get_lessons({"agent": "test-agent", "history_db": bob}, pack=PACK)
                         ["denial_stats"]["runs"], 2, "re-import must be idempotent")

    def test_newer_fields_are_ignored_and_bad_files_skipped(self):
        db = fresh_db()
        run("pre_commit", {SECRET_FILE: SECRET}, record_history=True, history_db=fresh_db(), caller="test-agent")
        (name,) = self.ledger_files()
        doc = json.loads((self.ledger / name).read_text())
        doc["run"]["added_by_a_newer_teammate"] = "x"
        doc["findings"][0]["confidence"] = 0.9
        (self.ledger / name).write_text(json.dumps(doc))
        (self.ledger / name).with_name("run-broken.json").write_text("<<<<<<< HEAD")
        self.assertEqual(architecture.history_mod.sync_ledger(PACK, db)["imported"], 1)
        self.assertEqual(architecture.get_lessons({"agent": "test-agent", "history_db": db}, pack=PACK)
                         ["denial_stats"]["denied_runs"], 1)

    def test_per_call_store_is_isolated_unless_a_ledger_is_configured(self):
        os.environ.pop("ARCH_HISTORY_LEDGER")
        run("pre_commit", {SECRET_FILE: SECRET}, record_history=True, history_db=fresh_db(), caller="test-agent")
        self.assertEqual(self.ledger_files(), [])


class PackIntegrityTests(unittest.TestCase):
    def test_selfcheck_passes(self):
        from architecture.selfcheck import selfcheck
        # The eShop sources are elsewhere, so the checks that need them (project paths, exemplars) are skipped.
        rep = selfcheck(PACK, check_workspace=False)
        failed = [c for c in rep["checks"] if c["status"] == "fail"]
        self.assertTrue(rep["ok"], failed)

    def test_selfcheck_needs_the_workspace_for_project_paths(self):
        from architecture.selfcheck import selfcheck
        rep = selfcheck(PACK, run_self_tests=False)
        profile = next(c for c in rep["checks"] if c["check"] == "profile")
        self.assertEqual(profile["status"], "fail")
        self.assertTrue(any("profile project path not found" in e for e in profile["errors"]))

    def test_engine_holds_no_policy_content(self):
        for name in ("policy.yaml", "rules", "patterns", "profiles", "exceptions", "architecture-rules.md"):
            self.assertFalse((ENGINE / name).exists(), f"{name} is policy content and belongs to an app repository")
        self.assertFalse((ENGINE / "validators" / "registry.yaml").exists())


def cli(script, *args, cwd=None, **env):
    """Run an engine entry point as a subprocess with only the given ARCH_* location variables."""
    clean = {k: v for k, v in os.environ.items() if k not in ("ARCH_POLICY_DIR", "ARCH_WORKSPACE")}
    return subprocess.run([sys.executable, str(script), *args], cwd=cwd, env={**clean, **env}, input="",
                          capture_output=True, text=True, encoding="utf-8", timeout=120)


class PolicyDirTests(unittest.TestCase):
    """Where the engine finds the policy: argument, then $ARCH_POLICY_DIR, then <workspace>/.factory/policy."""

    @classmethod
    def setUpClass(cls):
        # Three copies of the starter policy that differ by name, so each test can tell which one was loaded.
        cls.tmp = Path(tempfile.mkdtemp(dir=_TMP.name)).resolve()
        cls.repo = cls.tmp / "app"
        for name, target in (("in-repo", cls.repo / ".factory" / "policy"), ("from-env", cls.tmp / "env-policy"),
                             ("from-arg", cls.tmp / "arg-policy")):
            shutil.copytree(TEMPLATE_POLICY, target)
            manifest = target / "policy.yaml"
            manifest.write_text(manifest.read_text(encoding="utf-8").replace("name: app-architecture-policy", f"name: {name}"),
                                encoding="utf-8")
        (cls.repo / "src").mkdir()
        subprocess.run(["git", "init", "-q", str(cls.repo)], check=True)

    def setUp(self):
        self.addCleanup(os.environ.pop, "ARCH_POLICY_DIR", None)
        self.addCleanup(os.environ.pop, "ARCH_WORKSPACE", None)

    def test_default_is_dot_factory_policy_of_the_workspace(self):
        pack = architecture.get_pack(repo_root=self.repo)
        self.assertEqual(pack.manifest["name"], "in-repo")
        self.assertEqual(pack.root, self.repo / ".factory" / "policy")
        self.assertEqual(pack.repo_root, self.repo)
        self.assertEqual(pack.engine_root, ENGINE)

    def test_environment_overrides_the_default_and_argument_overrides_the_environment(self):
        os.environ["ARCH_POLICY_DIR"] = str(self.tmp / "env-policy")
        self.assertEqual(architecture.get_pack(repo_root=self.repo).manifest["name"], "from-env")
        self.assertEqual(architecture.get_pack(self.tmp / "arg-policy", self.repo).manifest["name"], "from-arg")

    def test_workspace_comes_from_argument_environment_then_current_git_repository(self):
        os.environ["ARCH_WORKSPACE"] = str(self.repo)
        self.assertEqual(architecture.resolve_workspace(), self.repo)
        self.assertEqual(architecture.resolve_workspace(self.tmp), self.tmp)
        os.environ.pop("ARCH_WORKSPACE")
        out = cli(HOOKS / "arch.py", "call", "get_rule", '{"rule_id": "SEC-001"}', cwd=self.repo / "src")
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(json.loads(out.stdout)["source"], ".factory/policy/rules/security.yaml")

    def test_policy_and_workspace_are_separate(self):
        # Policy from one place, code under review from another: findings are about the workspace's files.
        (self.repo / "src" / "settings.conf").write_text('db_password = "S3cr3t-Pa55word!"\n', encoding="utf-8")
        self.addCleanup((self.repo / "src" / "settings.conf").unlink)
        out = cli(HOOKS / "arch.py", "validate", "--checkpoint", "code_review", "--format", "json", "--no-evidence",
                  "--no-history", "--policy-dir", str(self.tmp / "arg-policy"), "--workspace", str(self.repo),
                  cwd=self.tmp)
        result = json.loads(out.stdout)
        self.assertEqual(result["policy"]["name"], "from-arg")
        self.assertEqual(result["decision"], "BLOCK", out.stdout[-2000:])
        self.assertEqual(out.returncode, 1)
        self.assertIn("src/settings.conf", [f["file"] for f in result["findings"] if f["rule_id"] == "SEC-001"])

    def test_cli_accepts_the_options_before_and_after_the_command(self):
        for args in (["--policy-dir", str(self.tmp / "arg-policy"), "call", "get_rule", '{"rule_id": "SEC-001"}'],
                     ["call", "get_rule", '{"rule_id": "SEC-001"}', "--policy-dir", str(self.tmp / "arg-policy")]):
            out = cli(HOOKS / "arch.py", *args, cwd=self.repo)
            self.assertEqual(out.returncode, 0, out.stderr)
            self.assertEqual(json.loads(out.stdout)["source"], str(self.tmp / "arg-policy" / "rules" / "security.yaml"))

    def test_evidence_and_history_are_written_to_the_app_repository_not_the_engine(self):
        files = {"src/settings.conf": 'db_password = "S3cr3t-Pa55word!"'}
        saved = {k: os.environ.pop(k, None) for k in ("ARCH_HISTORY_DB", "ARCH_HISTORY_LEDGER")}
        self.addCleanup(lambda: os.environ.update({k: v for k, v in saved.items() if v is not None}))
        pack = architecture.get_pack(repo_root=self.repo)
        result = architecture.validate("code_review", {"memory_files": files, "changed_files": list(files),
                                                       "caller": "implementer"}, {}, pack=pack)
        self.assertEqual(result["decision"], "BLOCK")
        policy = self.repo / ".factory" / "policy"
        self.assertTrue((self.repo / result["evidence"]["bundle_path"]).is_file())
        self.assertTrue(result["evidence"]["bundle_path"].startswith(".factory/policy/evidence/runs/"))
        self.assertTrue((policy / "evidence" / "history" / "architecture-history.sqlite").is_file())
        ledger = sorted(p.relative_to(self.repo).as_posix() for p in (self.repo / ".factory" / "metrics" / "arch-history").glob("*/*.json"))
        self.assertEqual(len(ledger), 1, ledger)
        self.assertFalse((ENGINE / "evidence" / "runs").exists())
        self.assertFalse((ENGINE / "evidence" / "history").exists())


class NoPolicyTests(unittest.TestCase):
    """A repository without .factory/policy/policy.yaml has no policy: a distinct result that blocks nothing."""

    def setUp(self):
        self.repo = Path(tempfile.mkdtemp(dir=_TMP.name)).resolve()

    def test_get_pack_raises_no_policy_configured(self):
        with self.assertRaises(architecture.NoPolicyConfigured) as caught:
            architecture.get_pack(repo_root=self.repo)
        self.assertEqual(caught.exception.policy_dir, self.repo / ".factory" / "policy")
        self.assertIn("no architecture policy configured", str(caught.exception))
        with self.assertRaises(architecture.NoPolicyConfigured):
            ArchReviewAgent(workspace=self.repo)

    def test_validate_cli_reports_not_configured_and_exits_zero(self):
        out = cli(HOOKS / "arch.py", "validate", "--checkpoint", "code_review", "--format", "json", cwd=self.repo,
                  ARCH_WORKSPACE=str(self.repo))
        self.assertEqual(out.returncode, 0, out.stderr)
        result = json.loads(out.stdout)
        self.assertEqual((result["status"], result["decision"], result["can_proceed"]), ("not_configured", "NOT_CONFIGURED", True))
        text = cli(HOOKS / "arch.py", "validate", "--checkpoint", "pre_commit", cwd=self.repo, ARCH_WORKSPACE=str(self.repo))
        self.assertEqual(text.returncode, 0)
        self.assertIn("no architecture policy configured", text.stdout)

    def test_review_agent_reports_not_configured_and_exits_zero(self):
        out = cli(AGENTS / "arch_review.py", "review", '{"requester": {"agent": "implementer"}}', "--workspace", str(self.repo))
        self.assertEqual(out.returncode, 0, out.stderr)
        result = json.loads(out.stdout)
        self.assertEqual(result["decision"], "NOT_CONFIGURED")
        self.assertEqual(result["action_items"], [])
        self.assertIn("no architecture policy configured", result["summary"])
        lessons = cli(AGENTS / "arch_review.py", "get_lessons", '{"agent": "implementer"}', ARCH_POLICY_DIR=str(self.repo / "nowhere"))
        self.assertEqual((lessons.returncode, json.loads(lessons.stdout)["prompt"]), (0, ""))

    def test_mcp_server_answers_not_configured_instead_of_an_error(self):
        from arch_review_agent import mcp_server
        reply = mcp_server.Server(workspace=self.repo).handle(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "arch_review", "arguments": {"requester": "x"}}})
        self.assertFalse(reply["result"]["isError"])
        self.assertEqual(reply["result"]["structuredContent"]["status"], "not_configured")


class StarterTemplateTests(unittest.TestCase):
    """templates/policy is what a new app repository starts from: it must be valid and usable as it is."""

    @classmethod
    def setUpClass(cls):
        cls.repo = Path(tempfile.mkdtemp(dir=_TMP.name)).resolve()
        cls.pack = architecture.get_pack(TEMPLATE_POLICY, cls.repo)

    def test_template_passes_selfcheck_including_workspace_checks(self):
        from architecture.selfcheck import selfcheck
        rep = selfcheck(self.pack)
        self.assertTrue(rep["ok"], [c for c in rep["checks"] if c["status"] == "fail"])
        self.assertEqual(self.pack.load_errors + self.pack.schema_errors, [])
        self.assertGreaterEqual(rep["stats"]["validator_self_tests"], 10)
        self.assertTrue(4 <= rep["stats"]["rules"] <= 6, rep["stats"]["rules"])

    def test_template_selfcheck_cli_passes(self):
        out = cli(HOOKS / "arch.py", "selfcheck", "--policy-dir", str(TEMPLATE_POLICY), "--workspace", str(self.repo))
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertIn("SELFCHECK PASSED", out.stdout)

    def test_template_names_no_stack(self):
        text = "\n".join(p.read_text(encoding="utf-8") for p in TEMPLATE_POLICY.rglob("*.yaml") if p.name != "profile.yaml")
        for word in ("csproj", "dotnet", "eShop", "Aspire", "IConfiguration"):
            self.assertNotIn(word, text)

    def run_template(self, files, profile=None, **ctx):
        import copy
        pack = self.pack
        if profile:
            pack = copy.copy(pack)
            pack.profile = {**pack.profile, **profile}
        context = {"memory_files": files, "changed_files": list(files), "write_evidence": False,
                   "record_history": False, "caller": "unittest", **ctx}
        return architecture.validate("code_review", context, {}, pack=pack)

    def test_secret_blocks_on_any_stack(self):
        for path, text in (("crates/api/src/main.rs", 'let api_key = "sk_live_abcdefgh12345678";'),
                           ("svc/src/main/java/App.java", 'String password = "S3cr3t-Pa55word!";'),
                           ("app/settings.py", "SECRET = 'S3cr3t-Pa55word!'")):
            self.assertEqual(outcomes(self.run_template({path: text}, rule_ids=["SEC-001"]), "SEC-001"), ["BLOCK"], path)
        clean = self.run_template({"app/settings.py": 'SECRET = os.environ["SECRET"]'}, rule_ids=["SEC-001"])
        self.assertEqual(clean["decision"], "PASS")

    def test_profile_driven_rules_are_silent_until_the_profile_is_filled(self):
        files = {"services/orders/src/db.py": 'URL = "postgres://db:5432/billingdb"'}
        self.assertEqual(self.run_template(files, rule_ids=["DATA-002", "TEST-001"])["decision"], "PASS")
        profile = {
            "projects": [{"name": "orders", "path": "services/orders", "type": "api", "service": "orders"}],
            "services": [{"id": "orders", "owns_datastores": ["ordersdb"], "traits": []},
                         {"id": "billing", "owns_datastores": ["billingdb"], "traits": []}],
            "test_mapping": [{"source": "services/orders/src", "tests": ["services/orders/tests/**"]}],
        }
        filled = self.run_template(files, profile, rule_ids=["DATA-002", "TEST-001"])
        self.assertEqual(outcomes(filled, "DATA-002"), ["BLOCK"])
        self.assertEqual(outcomes(filled, "TEST-001"), ["WARN"])

    def test_generated_file_edit_warns_and_semantic_rules_request_review(self):
        r = self.run_template({"api/gen/client.go": "// Code generated by protoc-gen-go. DO NOT EDIT.\npackage gen\n"})
        self.assertEqual(outcomes(r, "ARCH-008"), ["WARN"])
        self.assertIn("ARCH-004", [rr["rule_id"] for rr in r["review_requests"]])
        self.assertNotEqual(r["decision"], "BLOCK")


class DataDrivenValidatorTests(unittest.TestCase):
    """The project-graph validators know no build system: params and the profile describe it."""

    PROFILE = {
        "projects": [
            {"name": "orders-domain", "path": "crates/orders-domain", "type": "library", "service": "orders", "layer": "domain"},
            {"name": "orders-api", "path": "crates/orders-api", "type": "api", "service": "orders", "layer": "presentation"},
            {"name": "billing-domain", "path": "crates/billing-domain", "type": "library", "service": "billing", "layer": "domain"},
            {"name": "common", "path": "crates/common", "type": "library", "layer": "shared"},
        ],
        "services": [{"id": "orders", "owns_datastores": [], "traits": []}, {"id": "billing", "owns_datastores": [], "traits": []}],
        "layer_dependencies": {"domain": ["shared"], "presentation": ["same_service:domain", "shared"], "shared": ["shared"]},
        "forbidden_packages_by_layer": {"domain": ["sqlx", "axum"]},
    }

    def call(self, implementation, params, files, profile=None):
        import copy
        from architecture.engine import ValidatorContext
        from architecture.profile import ProjectIndex
        from architecture.workspace import Workspace
        pack = copy.copy(architecture.get_pack(TEMPLATE_POLICY, WORKSPACE))
        pack.profile = {**pack.profile, **(profile or self.PROFILE)}
        rule = {"id": "ARCH-004", "applicability": {"include": ["**/*"]}}
        run_ = {"pack": pack, "checkpoint": "code_review", "workspace": Workspace(WORKSPACE, "memory", memory=files),
                "index": ProjectIndex(pack.profile), "changed": {p: "M" for p in files}, "artifacts": {},
                "rule_files": {"ARCH-004": sorted(files)}, "validators_executed": {}}
        return pack.implementation(implementation)(ValidatorContext(run_, rule, {"params": params}))

    CARGO = {"manifest_globs": ["**/Cargo.toml"],
             "reference_patterns": [r'path\s*=\s*"(?P<ref>[^"]+)"'],
             "package_patterns": [r'(?m)^(?P<name>[A-Za-z0-9_-]+)\s*=\s*(?:"|\{)']}
    MAVEN = {"manifest_globs": ["**/pom.xml"],
             "reference_patterns": [{"regex": r"<dependency>.*?<artifactId>(?P<ref>[^<]+)</artifactId>", "flags": ["s"], "kind": "name"}]}

    def test_cargo_path_dependencies_follow_layers_and_services(self):
        ok = {"crates/orders-api/Cargo.toml": '[dependencies]\norders-domain = { path = "../orders-domain" }\ncommon = { path = "../common" }\n'}
        self.assertEqual(self.call("project_validators:layer_dependencies", self.CARGO, ok), [])
        self.assertEqual(self.call("project_validators:service_isolation", self.CARGO, ok), [])
        up = {"crates/orders-domain/Cargo.toml": '[dependencies]\norders-api = { path = "../orders-api" }\n'}
        self.assertEqual(len(self.call("project_validators:layer_dependencies", self.CARGO, up)), 1)
        across = {"crates/orders-api/Cargo.toml": '[dependencies]\nbilling-domain = { path = "../billing-domain" }\n'}
        (finding,) = self.call("project_validators:service_isolation", self.CARGO, across)
        self.assertIn("owned by service 'billing'", finding["message"])
        self.assertEqual(finding["line"], 2)

    def test_cargo_forbidden_packages_and_unclassified_crates(self):
        files = {"crates/orders-domain/Cargo.toml": '[dependencies]\nserde = "1"\nsqlx = { version = "0.8" }\nsqlx-core = "0.8"\nsqlxtra = "1"\n'}
        found = self.call("project_validators:forbidden_packages", self.CARGO, files)
        self.assertEqual([f["message"].split("'")[1] for f in found], ["sqlx", "sqlx-core"])
        new = {"crates/new-thing/Cargo.toml": "[package]\n"}
        self.assertIn("not classified", self.call("project_validators:layer_dependencies", self.CARGO, new)[0]["message"])

    def test_maven_dependencies_are_matched_by_module_name(self):
        profile = {**self.PROFILE, "projects": [dict(p, path=p["path"].replace("crates/", "")) for p in self.PROFILE["projects"]]}
        dep = "<dependency><groupId>com.acme</groupId><artifactId>{}</artifactId></dependency>"
        pom = lambda *names: "<project><dependencies>" + "".join(dep.format(n) for n in names) + "</dependencies></project>"
        self.assertEqual(self.call("project_validators:layer_dependencies", self.MAVEN,
                                   {"orders-api/pom.xml": pom("orders-domain", "common", "spring-web")}, profile), [])
        self.assertEqual(len(self.call("project_validators:service_isolation", self.MAVEN,
                                       {"orders-api/pom.xml": pom("billing-domain")}, profile)), 1)
        self.assertEqual(len(self.call("project_validators:layer_dependencies", self.MAVEN,
                                       {"orders-domain/pom.xml": pom("orders-api")}, profile)), 1)

    def test_comment_lines_are_skipped_only_when_the_profile_declares_prefixes(self):
        params = {"patterns": [{"regex": "forbidden_call", "message": "no"}]}
        files = {"app/a.py": "# forbidden_call()\nforbidden_call()\n"}
        self.assertEqual(len(self.call("text_validators:forbidden_pattern", params, files)), 2)
        hashed = {**self.PROFILE, "comment_prefixes": ["#"]}
        self.assertEqual([f["line"] for f in self.call("text_validators:forbidden_pattern", params, files, hashed)], [2])


if __name__ == "__main__":
    unittest.main()


class MigrationStatusTests(unittest.TestCase):
    """Dogfood C5: a review passed its changed files as a plain list, every file counted as modified, and DATA-001
    blocked the story's own NEW migration. A new migration and the snapshot update pass; editing or deleting a
    migration that exists on the base still blocks."""

    def _repo(self):
        root = Path(tempfile.mkdtemp(dir=_TMP.name))
        def git(*a):
            subprocess.run(["git", *a], cwd=root, check=True, capture_output=True)
        git("init", "-q", "-b", "main")
        mig = root / "src/Ordering.Infrastructure/Migrations"
        mig.mkdir(parents=True)
        (mig / "20200101000000_Init.cs").write_text("public partial class Init {}\n")
        (mig / "OrderingContextModelSnapshot.cs").write_text("// <auto-generated />\nclass S {}\n")
        git("add", "-A")
        git("-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "-m", "base")
        base = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True).stdout.strip()
        return root, mig, base

    def _data001(self, root, base, files):
        pack = architecture.get_pack(ESHOP_POLICY, root)
        result = architecture.validate("code_review", {"changed_files": files, "base": base, "write_evidence": False,
                                                      "record_history": False, "caller": "unittest"}, {}, pack=pack)
        return [o for o in outcomes(result, "DATA-001") if o not in ("pass", "skipped", "not_applicable")]

    def test_new_migration_and_snapshot_update_pass(self):
        root, mig, base = self._repo()
        (mig / "20261114000000_AddNote.cs").write_text("public partial class AddNote {}\n")
        (mig / "OrderingContextModelSnapshot.cs").write_text("// <auto-generated />\nclass S { int Note; }\n")
        files = ["src/Ordering.Infrastructure/Migrations/20261114000000_AddNote.cs", "src/Ordering.Infrastructure/Migrations/OrderingContextModelSnapshot.cs"]
        self.assertEqual(self._data001(root, base, files), [])

    def test_editing_an_existing_migration_blocks(self):
        root, mig, base = self._repo()
        (mig / "20200101000000_Init.cs").write_text("public partial class Init { int Changed; }\n")
        self.assertNotEqual(self._data001(root, base, ["src/Ordering.Infrastructure/Migrations/20200101000000_Init.cs"]), [])


class AddedLinesTriggerTests(unittest.TestCase):
    """Council C3: a held-out bug fix added a ProblemHttpResult 400 that its OpenAPI contract omitted. A convention can be
    required of new code only (trigger_on: added), so code that predates it does not fail."""

    class Ctx:
        def __init__(self, files, added):
            self.params = {"file_globs": ["**/Apis/**/*.cs"], "trigger": r"ProblemHttpResult|TypedResults\.Problem\(",
                           "trigger_on": "added", "require": [{"regex": r"\.Produces(Validation)?Problem\(", "message": "undeclared"}]}
            self.files = list(files)
            self._files = files
            self._added = added

        def read(self, path):
            return self._files.get(path)

        def added_text(self, path):
            return self._added.get(path, "")

    def test_new_problem_result_needs_a_declaration_and_old_code_does_not(self):
        import importlib
        vdir = str(Path(__file__).resolve().parents[1] / "validators")
        if vdir not in sys.path:
            sys.path.insert(0, vdir)
        tv = importlib.import_module("text_validators")
        old = 'api.MapPut("/cancel", Cancel); static Results<Ok, ProblemHttpResult> Cancel() => TypedResults.Problem();'
        # Untouched old code: nothing added, nothing reported.
        self.assertEqual(tv.required_pattern(self.Ctx({"src/O/Apis/OrdersApi.cs": old}, {})), [])
        # The change adds a handler returning a problem without ProducesProblem: reported.
        new = old + '\nstatic Results<Ok, ProblemHttpResult> Draft() => TypedResults.Problem(statusCode: 400);'
        out = tv.required_pattern(self.Ctx({"src/O/Apis/OrdersApi.cs": new}, {"src/O/Apis/OrdersApi.cs": "static Results<Ok, ProblemHttpResult> Draft() => TypedResults.Problem(statusCode: 400);"}))
        self.assertEqual(len(out), 1)
        # Declared: passes.
        declared = new + '\napi.MapPost("/draft", Draft).ProducesProblem(400);'
        self.assertEqual(tv.required_pattern(self.Ctx({"src/O/Apis/OrdersApi.cs": declared}, {"src/O/Apis/OrdersApi.cs": "TypedResults.Problem(statusCode: 400)"})), [])
