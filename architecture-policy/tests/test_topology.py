"""Derived classification (classify.py) and the application's declarations (topology.py).

The declaration rules are tested against architecture-policy/tests/topology_cases.json, the same table the factory
guard's JavaScript implementation (scripts/pipeline/lib/policy-topology.mjs) is tested against."""
import json
import sys
import unittest
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE / "hooks"))

from architecture import classify, topology  # noqa: E402

TABLE = json.loads((ENGINE / "tests" / "topology_cases.json").read_text(encoding="utf-8"))

PROFILE = {
    "projects": [{"name": "Shop.Api", "path": "src/Shop.Api", "type": "api", "service": "shop", "layer": "presentation"}],
    "services": [{"id": "shop", "owns_datastores": ["shopdb"], "traits": ["exposes_http_api"]}],
    "classification": {
        "service_names": {"Shop": "shop"},
        "conventions": [
            {"type": "test", "layer": "test", "match": {"roots": ["tests/*"], "test_project": True}},
            {"type": "api", "layer": "presentation", "service": "required", "traits": ["exposes_http_api"],
             "match": {"roots": ["src/*"], "sdk": ["Microsoft.NET.Sdk.Web"], "name": ["*.Api"]}},
            {"type": "library", "layer": "shared", "match": {"roots": ["src/*"], "sdk": ["Microsoft.NET.Sdk"], "test_project": False}},
        ],
    },
}
WEB = '<Project Sdk="Microsoft.NET.Sdk.Web" />'


class DeclarationTable(unittest.TestCase):
    def test_every_case(self):
        for case in TABLE["cases"]:
            with self.subTest(case["name"]):
                links = case.get("symlinks", [])
                linked = lambda rel: any(rel == l or rel.startswith(l + "/") for l in links)  # noqa: E731
                _, errors = topology.validate(TABLE["profile"], case["policy"], set(TABLE["manifest_dirs"]), is_symlink=linked)
                if case.get("error"):
                    self.assertTrue(any(case["error"] in e for e in errors), errors)
                else:
                    self.assertEqual(errors, [])


class SymlinkedRoots(unittest.TestCase):
    def test_a_root_through_a_symbolic_link_on_disk(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "src/Catalog.API").mkdir(parents=True)
            (root / "src/Catalog.API/Catalog.API.csproj").write_text(WEB)
            (root / "src/Alias.API").symlink_to(root / "src/Catalog.API")
            (root / "src/Real.API").mkdir()
            self.assertTrue(topology.symlinked(root, "src/Alias.API"))
            self.assertTrue(topology.symlinked(root, "src/Alias.API/Apis"))
            self.assertFalse(topology.symlinked(root, "src/Real.API"))
            policy = {"services": [{"id": "alias", "roots": ["src/Alias.API"]}]}
            _, errors = topology.validate(TABLE["profile"], policy, {"src/Alias.API"}, root=root)
            self.assertTrue(any("symbolic link" in e for e in errors), errors)


class Derivation(unittest.TestCase):
    def derive(self, manifests, declared=()):
        return classify.derive(PROFILE, manifests, list(declared))

    def test_a_project_of_an_existing_service_by_its_name(self):
        derived, unclassified = self.derive({"src/Shop.Admin.Api/Shop.Admin.Api.csproj": WEB})
        self.assertEqual(unclassified, {})
        self.assertEqual((derived[0]["type"], derived[0]["service"]), ("api", "shop"))

    def test_an_api_of_a_declared_new_service(self):
        derived, unclassified = self.derive({"src/Reviews.Api/Reviews.Api.csproj": WEB}, [{"id": "reviews", "roots": ["src/Reviews.Api"], "owns_datastores": []}])
        self.assertEqual(unclassified, {})
        self.assertEqual((derived[0]["type"], derived[0]["layer"], derived[0]["service"]), ("api", "presentation", "reviews"))

    def test_an_api_without_a_service_is_the_agents_to_declare(self):
        _, unclassified = self.derive({"src/Reviews.Api/Reviews.Api.csproj": WEB})
        info = unclassified["src/Reviews.Api/Reviews.Api.csproj"]
        self.assertFalse(info["needs_person"])
        self.assertIn("policy.services", info["reason"])

    def test_nested_projects_are_for_a_person(self):
        _, unclassified = self.derive({"src/Probe.Api/Probe.Api.csproj": WEB, "src/Probe.Api/Apis/Apis.csproj": '<Project Sdk="MSTest.Sdk" />'},
                                      [{"id": "probe", "roots": ["src/Probe.Api"], "owns_datastores": []}])
        self.assertEqual(set(unclassified), {"src/Probe.Api/Probe.Api.csproj", "src/Probe.Api/Apis/Apis.csproj"})
        self.assertTrue(all(u["needs_person"] for u in unclassified.values()))

    def test_inside_a_profiled_project_is_for_a_person(self):
        _, unclassified = self.derive({"src/Shop.Api/Inner/Inner.csproj": '<Project Sdk="MSTest.Sdk" />'})
        self.assertIn("profiled project at src/Shop.Api", unclassified["src/Shop.Api/Inner/Inner.csproj"]["reason"])

    def test_no_convention_or_several(self):
        _, none = self.derive({"src/Odd/Odd.csproj": '<Project Sdk="Some.Other.Sdk" />'})
        self.assertIn("fits none", none["src/Odd/Odd.csproj"]["reason"])
        profile = dict(PROFILE, classification=dict(PROFILE["classification"], conventions=PROFILE["classification"]["conventions"] + [{"type": "library", "layer": "shared", "match": {"roots": ["src/*"]}}]))
        _, several = classify.derive(profile, {"src/Lib/Lib.csproj": '<Project Sdk="Microsoft.NET.Sdk" />'}, [])
        self.assertIn("fits several", several["src/Lib/Lib.csproj"]["reason"])

    def test_a_test_project_under_tests(self):
        derived, unclassified = self.derive({"tests/Reviews.Tests/Reviews.Tests.csproj": '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="xunit.v3.mtp-v2" /></ItemGroup></Project>'})
        self.assertEqual(unclassified, {})
        self.assertEqual((derived[0]["type"], derived[0]["layer"]), ("test", "test"))

    def test_linked_folders(self):
        facts = classify.project_facts("src/A/A.csproj", '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><Compile Include="..\\Shared\\X.cs" Link="X.cs" /><Compile Include="Local.cs" /></ItemGroup></Project>')
        self.assertEqual(facts["linked_folders"], ["src/Shared"])


if __name__ == "__main__":
    unittest.main()


CLASSIFY = json.loads((ENGINE / "tests" / "classify_cases.json").read_text(encoding="utf-8"))


class ManifestFacts(unittest.TestCase):
    """The classifier reads manifests as MSBuild does, and never guesses (council A6)."""

    def test_every_case(self):
        profile = {"projects": [], "services": [{"id": "catalog", "owns_datastores": [], "traits": []}, {"id": "probe", "owns_datastores": [], "traits": []}],
                   "classification": {"conventions": CLASSIFY["conventions"], "service_names": CLASSIFY["service_names"]}}
        for case in CLASSIFY["cases"]:
            with self.subTest(case["name"]):
                files = case["files"]
                manifests = {f: t for f, t in files.items() if f.lower().endswith("proj")}
                derived, unclassified = classify.derive(profile, manifests, [], files=list(files), read=files.get)
                got = {d["manifest"]: f"{d['type']}/{d['layer']}" for d in derived}
                for m in manifests:
                    if case["expect"] == "person":
                        self.assertTrue(unclassified.get(m, {}).get("needs_person"), (m, got.get(m), unclassified.get(m)))
                    elif case["expect"] == "none":
                        self.assertIn(m, unclassified, got)
                    else:
                        self.assertEqual(got.get(m), case["expect"], unclassified.get(m))

    def test_a_disagreement_with_the_toolchain_goes_to_a_person(self):
        facts = classify.project_facts("src/A/A.csproj", '<Project Sdk="Microsoft.NET.Sdk.Web" />')
        self.assertEqual(classify.evaluation_disagreements(facts, {"UsingMicrosoftNETSdkWeb": "true", "UsingMicrosoftNETSdkRazor": "true", "UseMaui": "", "OutputType": "Exe"}), [])
        self.assertTrue(classify.evaluation_disagreements(facts, {"UsingMicrosoftNETSdkWeb": "", "IsAspireHost": "true", "UseMaui": "", "OutputType": "Exe"}))
        # The output type is compared even when the manifest does not set it (A7 Sol), and a test project MSBuild knows of.
        self.assertTrue(classify.evaluation_disagreements(facts, {"UsingMicrosoftNETSdkWeb": "true", "UsingMicrosoftNETSdkRazor": "true", "OutputType": "Library"}))
        self.assertTrue(classify.evaluation_disagreements(facts, {"UsingMicrosoftNETSdkWeb": "true", "UsingMicrosoftNETSdkRazor": "true", "OutputType": "Exe", "IsTestProject": "true"}))
        lib = classify.project_facts("src/L/L.csproj", '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Library</OutputType></PropertyGroup></Project>')
        self.assertTrue(classify.evaluation_disagreements(lib, {"OutputType": "Exe", "UseMaui": ""}))


class LinkedSources(unittest.TestCase):
    """Code compiled into a project from outside it, also through a Directory.Build.* file or a computed path (A7)."""

    def test_directory_build_wildcard_and_computed_paths(self):
        props = '<Project><ItemGroup><Compile Include="..\\..\\tests\\Catalog.Linked.Tests\\**\\*.cs" /></ItemGroup></Project>'
        files = {"src/Catalog.API/Catalog.API.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web" />', "src/Catalog.API/Directory.Build.props": props}
        facts = classify.project_facts("src/Catalog.API/Catalog.API.csproj", files["src/Catalog.API/Catalog.API.csproj"],
                                       imports=classify._imports("src/Catalog.API", set(files), files.get), read=files.get)
        self.assertEqual(facts["linked_folders"], ["tests/Catalog.Linked.Tests"])
        computed = classify.project_facts("src/A/A.csproj", '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><Compile Include="$(Shared)/X.cs" /></ItemGroup></Project>')
        self.assertEqual(computed["computed_includes"], ["src/A/A.csproj: $(Shared)/X.cs"])
        shared = classify.project_facts("src/A/A.csproj", '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><Compile Include="..\\Shared\\X.cs" Link="X.cs" /></ItemGroup></Project>')
        self.assertEqual(shared["linked_folders"], ["src/Shared"])


import os  # noqa: E402
import shutil  # noqa: E402
import tempfile  # noqa: E402


@unittest.skipUnless(shutil.which("dotnet") and os.environ.get("ARCH_MSBUILD_EVAL", "1") != "0", "no dotnet toolchain")
class ToolchainEvaluation(unittest.TestCase):
    def test_msbuild_agrees_with_an_honest_project_and_catches_what_the_parse_cannot_see(self):
        root = Path(tempfile.mkdtemp())
        (root / "src/Shop.Api").mkdir(parents=True)
        (root / "src/Shop.Api/Shop.Api.csproj").write_text('<Project Sdk="Microsoft.NET.Sdk.Web" />')
        props = sorted(set(classify.SDK_FLAGS.values()) | {"OutputType", "UseMaui"})
        facts = classify.project_facts("src/Shop.Api/Shop.Api.csproj", '<Project Sdk="Microsoft.NET.Sdk.Web" />')
        evaluated = classify.msbuild_evaluate(str(root / "src/Shop.Api/Shop.Api.csproj"), props)
        self.assertIsNotNone(evaluated)
        self.assertEqual(classify.evaluation_disagreements(facts, evaluated), [])
        # A property set where the parse does not look (a file an MSBuild SDK imports): the evaluation sees it.
        (root / "src/Shop.Api/Shop.Api.csproj").write_text('<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><UseMaui>$([System.String]::Copy(true))</UseMaui></PropertyGroup></Project>')
        evaluated = classify.msbuild_evaluate(str(root / "src/Shop.Api/Shop.Api.csproj"), props)
        self.assertTrue(classify.evaluation_disagreements(facts, evaluated))
        # Both configurations a build can use are evaluated (A7 Opus N3b: a Release-only import).
        (root / "src/Shop.Api/Shop.Api.csproj").write_text('<Project Sdk="Microsoft.NET.Sdk"><Import Project="rel.props" Condition="\'$(Configuration)\' == \'Release\'" /></Project>')
        (root / "src/Shop.Api/rel.props").write_text('<Project><PropertyGroup><OutputType>Exe</OutputType></PropertyGroup></Project>')
        both = classify.evaluate_all(str(root / "src/Shop.Api/Shop.Api.csproj"), props)
        self.assertEqual(both["Debug"]["OutputType"], "Library")
        self.assertEqual(both["Release"]["OutputType"], "Exe")
        lib = classify.project_facts("src/Shop.Api/Shop.Api.csproj", '<Project Sdk="Microsoft.NET.Sdk" />')
        self.assertEqual(classify.evaluation_disagreements(lib, both["Debug"]), [])
        self.assertTrue(classify.evaluation_disagreements(lib, both["Release"]))
