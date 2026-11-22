"""Run the market-refresh workflow's real shell steps against a local git remote and a fake gh."""

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest

from update_lobster_market import CHECK_RECORD_FIELDS

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github/workflows"
REFRESH = (WORKFLOWS / "market-refresh.yml").read_text()
DEPLOY = (WORKFLOWS / "ci-deploy.yml").read_text()
DOCS = {path: (ROOT / path).read_text() for path in ("README.md", "docs/github.md")}
DATA = "src/data/lobster-market.json"
REPO = "owner/lobster-ledger"
PULLS = f"GET repos/{REPO}/pulls?state=open&base=main&per_page=100"
ISSUES = f"GET repos/{REPO}/issues?state=open&labels=market-refresh&per_page=100"
JOBS = f"GET repos/{REPO}/actions/runs/1/jobs?filter=latest&per_page=100"
TITLE = "Lobster market refresh is failing"
# The personal access token secret this workflow used to need, spelled in two parts so the retired name
# appears nowhere else in the repository.
RETIRED_SECRET = "MARKET_REFRESH" + "_TOKEN"

PREPARE = "Prepare the data commit"
CHECKS = "Run the pull request checks on the data commit"
PUBLISH = "Push the data branch and open or update its pull request"
SUMMARY = "Publish run summary"
REPORT = "Open, update or close the failure issue"
DATA_COMMIT_READY = "steps.prepare.outputs.commit == 'true'"

FAKE_GH = """\
import json, os, sys
args = sys.argv[1:]
record = {"args": args}
if args[:1] == ["api"]:
    method, path, source, rest = "GET", None, None, iter(args[1:])
    for arg in rest:
        if arg in ("--method", "-X"):
            method = next(rest)
        elif arg == "--input":
            source = next(rest)
        elif not arg.startswith("-") and path is None:
            path = arg
    record = {"call": f"{method} {path}"}
    if source:
        text = sys.stdin.read() if source == "-" else open(source).read()
        record["input"] = json.loads(text)
    responses = json.loads(open(os.environ["FAKE_GH_RESPONSES"]).read())
    status, body = responses.get(record["call"], [0, {}])
else:
    status, body = 0, None
with open(os.environ["FAKE_GH_LOG"], "a") as log:
    log.write(json.dumps(record) + "\\n")
if body is not None:
    print(json.dumps(body))
sys.exit(status)
"""

# Records each call with its working directory, prints some output, and fails when asked to.
FAKE_TOOL = """\
#!/bin/sh
printf '%s\\t%s\\n' "$PWD" "$(basename "$0") $*" >> "$FAKE_TOOL_LOG"
echo "$(basename "$0") output for $*"
if [ "$(basename "$0") $*" = "$FAKE_TOOL_FAIL" ]; then
  echo "$(basename "$0") $*: something broke"
  exit 3
fi
"""


def run_blocks(workflow):
    """Every run: script in a workflow, in order."""
    lines, blocks = workflow.splitlines(), []
    for index, line in enumerate(lines):
        key = line.lstrip()
        if not key.startswith("run:"):
            continue
        if key.strip() != "run: |":
            blocks.append(key[4:].strip())
            continue
        indent, body = len(line) - len(key), []
        for following in lines[index + 1:]:
            if following.strip() and len(following) - len(following.lstrip()) <= indent:
                break
            body.append(following)
        blocks.append(textwrap.dedent("\n".join(body)).strip() + "\n")
    return blocks


def step(workflow, name):
    """The lines of one named step, up to the next step or job."""
    lines = workflow.splitlines()
    start = next(index for index, line in enumerate(lines) if line.strip() == f"- name: {name}")
    indent, body = len(lines[start]) - len(lines[start].lstrip()), [lines[start]]
    for line in lines[start + 1:]:
        if line.strip() and len(line) - len(line.lstrip()) <= indent:
            break
        body.append(line)
    return "\n".join(body) + "\n"


def step_names(text):
    return re.findall(r"(?m)^\s+- name: (.+)$", text)


def job(workflow, name):
    match = re.search(rf"^  {name}:\n(.*?)(?=^  \S|\Z)", workflow, re.M | re.S)
    return match.group(1) if match else ""


def permissions(job_text):
    """A job's permissions block as a dict; it must be the job's only one."""
    [block] = re.findall(r"(?m)^    permissions:\n((?:      \S.*\n)+)", job_text)
    return dict(line.strip().split(": ", 1) for line in block.splitlines())


def script(name):
    return run_blocks(step(REFRESH, name))[0]


def series_filter():
    return re.search(r"^\s+MARKET_SERIES_FILTER: '(.+)'$", REFRESH, re.M).group(1)


def snapshot(source_updated_on="2026-02-06", sha="a", checked_at="2026-10-15T00:00:00Z", years=range(1950, 2026), **extra):
    return {
        "schemaVersion": 1,
        "sourceUpdatedOn": source_updated_on,
        "sourcePageUrl": "https://www.maine.gov/dmr/fisheries/commercial/landings-program/historical-data",
        "checkedAt": checked_at,
        "observations": [{"year": year, "priceCentsPerLb": 500 + (year == 2025) * (sha != "a"), "preliminary": year == years[-1]} for year in years],
        "sourceSha256": sha * 64,
        **extra,
    }


class WorkflowHarness(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.temp = self.root / "runner-temp"
        self.temp.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        gh = self.bin / "gh"
        gh.write_text(f"#!{sys.executable}\n{FAKE_GH}")
        gh.chmod(0o755)
        self.responses = {}
        self.env = {
            "PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}",
            "HOME": str(self.root),
            "GIT_CONFIG_GLOBAL": str(self.root / "gitconfig"),
            "GIT_CONFIG_NOSYSTEM": "1",
            "RUNNER_TEMP": str(self.temp),
            "GITHUB_OUTPUT": str(self.root / "output"),
            "GITHUB_STEP_SUMMARY": str(self.root / "step-summary"),
            "GITHUB_REPOSITORY": REPO,
            "FAKE_GH_LOG": str(self.root / "gh.log"),
            "FAKE_GH_RESPONSES": str(self.root / "gh-responses.json"),
            "MARKET_SERIES_FILTER": series_filter(),
            "RUN_URL": "https://github.com/owner/lobster-ledger/actions/runs/1",
        }

    def run_step(self, name, cwd=None, **env):
        (self.root / "gh-responses.json").write_text(json.dumps(self.responses))
        return subprocess.run(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", script(name)], cwd=cwd or self.root, capture_output=True, text=True, env={**self.env, **env})

    def outputs(self):
        path = self.root / "output"
        return dict(line.split("=", 1) for line in path.read_text().splitlines() if "=" in line) if path.exists() else {}

    def summary(self):
        path = self.temp / "market-refresh.md"
        return path.read_text() if path.exists() else ""

    def gh_calls(self):
        path = self.root / "gh.log"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def writes(self):
        return [call for call in self.gh_calls() if "call" in call and not call["call"].startswith("GET ")]

    def git(self, *args, cwd):
        return subprocess.run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", *args], cwd=cwd, check=True, capture_output=True, text=True, env=self.env).stdout.strip()


class WorkflowDefinitionTests(unittest.TestCase):
    def test_refresh_runs_weekly_and_on_demand_with_least_privilege(self):
        self.assertRegex(REFRESH, r"(?m)^on:\n  schedule:\n    - cron: '23 14 \* \* 1'\n  workflow_dispatch:\n")
        self.assertRegex(REFRESH, r"(?m)^permissions: \{\}$")
        self.assertEqual(permissions(job(REFRESH, "refresh")), {"contents": "write", "pull-requests": "write", "statuses": "write"})
        self.assertEqual(permissions(job(REFRESH, "report")), {"actions": "read", "issues": "write"})

    def test_actions_are_pinned_to_the_deploy_workflow_commits(self):
        pinned = set(re.findall(r"uses: (\S+@[0-9a-f]{40})", DEPLOY))
        used = re.findall(r"(?m)^\s+(?:- )?uses: (\S+)", REFRESH)
        self.assertTrue(used)
        self.assertLessEqual(set(used), pinned)

    def test_untrusted_values_reach_scripts_only_through_the_environment(self):
        blocks = run_blocks(REFRESH)
        self.assertGreaterEqual(len(blocks), 7)
        for block in blocks:
            self.assertNotIn("${{", block)

    def test_only_the_built_in_token_is_used_and_only_where_needed(self):
        self.assertNotIn("secrets.", REFRESH)
        for name, text in {"market-refresh.yml": REFRESH, "ci-deploy.yml": DEPLOY, **DOCS}.items():
            with self.subTest(name):
                self.assertNotIn(RETIRED_SECRET, text)
        with_token = {name for name in step_names(REFRESH) if "GH_TOKEN" in step(REFRESH, name)}
        self.assertEqual(with_token, {PREPARE, PUBLISH, REPORT})
        for name in with_token:
            self.assertIn("GH_TOKEN: ${{ github.token }}", step(REFRESH, name))

    def test_checks_run_on_the_data_commit_before_anything_is_pushed(self):
        names = step_names(job(REFRESH, "refresh"))
        order = [PREPARE, "Set up pnpm", "Set up Node.js", CHECKS, PUBLISH, SUMMARY]
        self.assertEqual([name for name in names if name in order], order)
        for name in ("Set up pnpm", "Set up Node.js", CHECKS):
            self.assertIn(f"if: {DATA_COMMIT_READY}\n", step(REFRESH, name))
        self.assertIn(f"if: {DATA_COMMIT_READY} && github.ref == 'refs/heads/main'\n", step(REFRESH, PUBLISH))
        self.assertIn("node-version-file: .node-version", step(REFRESH, "Set up Node.js"))
        checks = script(CHECKS)
        self.assertEqual(re.findall(r"(?m)^gate '([^']+)' ", checks), ["pnpm install --frozen-lockfile", "pnpm test", "pnpm build", "importer tests"])
        self.assertIn("-m unittest discover -s scripts -p 'test_lobster_market_*.py'", checks)
        pushes = [name for name in step_names(REFRESH) if "run:" in step(REFRESH, name) and " push " in script(name)]
        self.assertEqual(pushes, [PUBLISH])

    def test_every_step_that_can_hang_has_its_own_timeout(self):
        self.assertIn("timeout-minutes: 45", job(REFRESH, "refresh"))
        for name in ("Test market-feed importer", "Refresh from the official source", PREPARE, CHECKS, PUBLISH):
            with self.subTest(name):
                self.assertRegex(step(REFRESH, name), r"\n        timeout-minutes: \d+\n")

    def test_report_runs_after_any_unfinished_refresh_and_knows_its_timeout(self):
        # always(): a job timeout must reach the report step even if GitHub treats it as a cancelled run;
        # the step itself tells a timeout from a cancel.
        self.assertIn("if: ${{ always() && github.ref == 'refs/heads/main' && needs.refresh.result != 'skipped' }}", job(REFRESH, "report"))
        timeout = re.search(r"(?m)^    timeout-minutes: (\d+)$", job(REFRESH, "refresh")).group(1)
        self.assertIn(f"REFRESH_TIMEOUT_MINUTES: {timeout}\n", step(REFRESH, REPORT))
        name = re.search(r"(?m)^    name: (.+)$", job(REFRESH, "refresh")).group(1)
        self.assertIn(f"REFRESH_JOB_NAME: {name}\n", step(REFRESH, REPORT))

    def test_publish_pushes_only_the_commit_the_checks_tested(self):
        self.assertIn("TESTED_SHA: ${{ steps.checks.outputs.tested-sha }}", step(REFRESH, PUBLISH))

    def test_series_comparison_ignores_exactly_the_check_record(self):
        self.assertEqual(series_filter(), "del(" + ", ".join(f".{field}" for field in CHECK_RECORD_FIELDS) + ")")

    def test_production_deploys_build_the_committed_snapshot(self):
        self.assertNotIn("schedule", DEPLOY)
        self.assertNotIn("update_lobster_market.py", DEPLOY)
        self.assertNotIn("Refresh official lobster market history", DEPLOY)
        self.assertIn("-m unittest discover -s scripts -p 'test_lobster_market_*.py'", step(DEPLOY, "Test market-feed importer"))
        self.assertIn("-m unittest discover -s scripts -p 'test_lobster_market_*.py'", script("Test market-feed importer"))


class ImportStepTests(WorkflowHarness):
    def run_import(self, exit_code):
        python = self.temp / "lobster-market-feed/bin/python"
        python.parent.mkdir(parents=True)
        python.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$IMPORT_ARGS"\necho "importer output"\nexit "$IMPORT_EXIT"\n')
        python.chmod(0o755)
        return self.run_step("Refresh from the official source", IMPORT_ARGS=str(self.root / "args"), IMPORT_EXIT=str(exit_code))

    def test_importer_fails_closed_and_writes_only_the_series(self):
        result = self.run_import(0)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / "args").read_text().splitlines(), ["scripts/update_lobster_market.py"])
        self.assertIn("importer output", self.summary())

    def test_importer_failure_fails_the_step_and_is_summarised(self):
        result = self.run_import(7)
        self.assertEqual(result.returncode, 7)
        self.assertIn("importer output", self.summary())


class SummaryStepTests(WorkflowHarness):
    def publish_summary(self, job_status="success", steps=None):
        result = self.run_step(SUMMARY, JOB_STATUS=job_status, STEP_RESULTS=json.dumps(steps or {}))
        self.assertEqual(result.returncode, 0, result.stderr)
        output = (self.root / "output").read_text()
        delimiter = re.match(r"text<<(\S+)\n", output).group(1)
        self.assertTrue(output.endswith(f"\n{delimiter}\n"))
        return output.split(delimiter)[1]

    def test_summary_becomes_a_job_output(self):
        (self.temp / "market-refresh.md").write_text("### Official source\n\nHTTP Error 403: Forbidden\n")
        text = self.publish_summary(steps={"import": {"outcome": "success", "conclusion": "success", "outputs": {}}})
        self.assertIn("HTTP Error 403: Forbidden", text)
        self.assertNotIn("Failed step", text)
        self.assertIn("HTTP Error 403", (self.root / "step-summary").read_text())

    def test_failure_names_the_step_and_keeps_the_tail_of_its_log(self):
        (self.temp / "logs").mkdir()
        (self.temp / "logs/publish.log").write_text("".join(f"log line {number}\n" for number in range(1, 61)))
        text = self.publish_summary("failure", {
            "prepare": {"outcome": "success", "conclusion": "success", "outputs": {}},
            "publish": {"outcome": "failure", "conclusion": "failure", "outputs": {}},
        })
        self.assertIn("Failed step: `publish`", text)
        self.assertIn("log line 21\n", text)
        self.assertIn("log line 60\n", text)
        self.assertNotIn("log line 20\n", text)
        self.assertIn("Failed step: `publish`", (self.root / "step-summary").read_text())

    def test_failure_in_a_step_without_its_own_log_points_to_its_section(self):
        (self.temp / "market-refresh.md").write_text("### Official source\n\nHTTP Error 403: Forbidden\n")
        text = self.publish_summary("failure", {"import": {"outcome": "failure", "conclusion": "failure", "outputs": {}}})
        self.assertIn("HTTP Error 403: Forbidden", text)
        self.assertIn("Failed step: `import`", text)
        self.assertNotIn("Last 40 lines", text)

    def test_a_timed_out_job_still_names_the_unfinished_step(self):
        text = self.publish_summary("cancelled", {"checks": {"outcome": "cancelled", "conclusion": "cancelled", "outputs": {}}})
        self.assertIn("Failed step: `checks`", text)


class DataPullRequestTests(WorkflowHarness):
    def setUp(self):
        super().setUp()
        self.origin = self.root / "origin.git"
        subprocess.run(["git", "init", "--quiet", "--bare", "-b", "main", str(self.origin)], check=True, env=self.env)
        seed = self.root / "seed"
        subprocess.run(["git", "clone", "--quiet", str(self.origin), str(seed)], check=True, env=self.env, capture_output=True)
        self.write(seed, snapshot())
        self.git("add", "-A", cwd=seed)
        self.git("commit", "--quiet", "-m", "Seed", cwd=seed)
        self.git("push", "--quiet", "origin", "HEAD:refs/heads/main", cwd=seed)
        self.seed = seed
        self.checkout = self.root / "checkout"
        subprocess.run(["git", "clone", "--quiet", str(self.origin), str(self.checkout)], check=True, env=self.env, capture_output=True)
        self.new = snapshot("2027-02-05", "b", "2027-02-08T14:23:00Z", range(1950, 2027))
        self.write(self.checkout, self.new)
        self.work = self.temp / "market-data-branch"

    def write(self, repo, data):
        (repo / DATA).parent.mkdir(parents=True, exist_ok=True)
        (repo / DATA).write_text(json.dumps(data, indent=2) + "\n")

    def branch(self, name, data):
        self.git("switch", "--quiet", "-c", name, "main", cwd=self.seed)
        self.write(self.seed, data)
        self.git("add", "-A", cwd=self.seed)
        self.git("commit", "--quiet", "-m", f"Data for {name}", cwd=self.seed)
        self.git("push", "--quiet", "origin", f"HEAD:refs/heads/{name}", cwd=self.seed)
        self.git("switch", "--quiet", "main", cwd=self.seed)
        return self.git("rev-parse", name, cwd=self.seed)

    def compare(self):
        result = self.run_step("Compare with the committed series", cwd=self.checkout)
        self.assertEqual(result.returncode, 0, result.stderr)
        return self.outputs()

    def prepare(self):
        outputs = self.compare()
        self.assertEqual(outputs["changed"], "true")
        return self.run_step(PREPARE, cwd=self.checkout, GH_TOKEN="token", SOURCE_UPDATED_ON=outputs["source-updated-on"])

    def publish(self, **env):
        outputs = self.outputs()
        (self.temp / "checks.md").write_text("### Checks on the data commit\n\n- `pnpm test`: passed\n")
        tested = self.git("rev-parse", "HEAD", cwd=self.work)
        values = {"SOURCE_UPDATED_ON": outputs["source-updated-on"], "BRANCH": outputs["branch"], "NUMBER": outputs["number"], "TESTED_SHA": tested, **env}
        return self.run_step(PUBLISH, cwd=self.checkout, GH_TOKEN="token", **values)

    def tip(self, branch):
        return self.git("rev-parse", f"refs/heads/{branch}", cwd=self.origin)

    def has_branch(self, branch):
        return subprocess.run(["git", "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}"], cwd=self.origin, capture_output=True, env=self.env).returncode == 0

    def tree(self, ref, path, repo=None):
        return subprocess.run(["git", "show", f"{ref}:{path}"], cwd=repo or self.origin, check=True, capture_output=True, env=self.env).stdout

    def test_check_time_and_method_alone_are_not_a_change(self):
        self.write(self.checkout, snapshot(checked_at="2026-10-19T14:23:00Z", checkMethod="manual-file"))
        self.assertEqual(self.compare(), {"changed": "false"})
        self.assertIn("unchanged", self.summary())

    def test_new_release_is_a_change(self):
        self.assertEqual(self.compare(), {"changed": "true", "source-updated-on": "2027-02-05"})
        self.assertIn("2027-02-05", self.summary())

    def test_an_unexpected_source_date_fails_and_is_logged(self):
        self.write(self.checkout, {**self.new, "sourceUpdatedOn": "soon"})
        result = self.run_step("Compare with the committed series", cwd=self.checkout)
        self.assertEqual(result.returncode, 1)
        self.assertIn("unexpected source date", (self.temp / "logs/compare.log").read_text())
        self.assertNotIn("changed=true", (self.root / "output").read_text() if (self.root / "output").exists() else "")

    def test_prepares_only_the_numeric_snapshot_for_publication(self):
        main = self.tip("main")
        self.responses = {PULLS: [0, [
            {"number": 3, "head": {"ref": "data/lobster-market-2027-01-01", "repo": {"full_name": "fork/lobster-ledger"}}},
            {"number": 4, "head": {"ref": "feature/other", "repo": {"full_name": REPO}}},
        ]]}
        result = self.prepare()
        self.assertEqual(result.returncode, 0, result.stderr)
        branch = "data/lobster-market-2027-02-05"
        self.assertEqual({key: self.outputs()[key] for key in ("commit", "branch", "number")}, {"commit": "true", "branch": branch, "number": ""})
        self.assertEqual(self.git("rev-parse", "HEAD^", cwd=self.work), main)
        self.assertEqual(json.loads(self.tree("HEAD", DATA, self.work)), self.new)
        self.assertEqual(self.git("diff", "--name-only", "HEAD^", "HEAD", cwd=self.work), DATA)
        self.assertFalse(self.has_branch(branch))
        self.assertEqual(self.writes(), [])

    def test_opens_one_pull_request_after_the_checks_pass(self):
        main = self.tip("main")
        self.responses = {PULLS: [0, []], f"POST repos/{REPO}/pulls": [0, {"number": 17}]}
        self.assertEqual(self.prepare().returncode, 0)
        head = self.git("rev-parse", "HEAD", cwd=self.work)
        result = self.publish()
        self.assertEqual(result.returncode, 0, result.stderr)
        branch = "data/lobster-market-2027-02-05"
        self.assertEqual(self.tip(branch), head)
        self.assertEqual(self.git("rev-parse", f"{branch}^", cwd=self.origin), main)
        self.assertEqual(self.tip("main"), main)
        status, create = self.writes()
        self.assertEqual(status, {"call": f"POST repos/{REPO}/statuses/{head}", "input": {
            "state": "success",
            "context": "market-refresh/checks",
            "target_url": self.env["RUN_URL"],
            "description": "pnpm test, pnpm build and the importer tests passed on this commit.",
        }})
        self.assertEqual(create["call"], f"POST repos/{REPO}/pulls")
        self.assertEqual({key: create["input"][key] for key in ("head", "base")}, {"head": branch, "base": "main"})
        self.assertIn("2027-02-05", create["input"]["title"])
        for text in ("b" * 64, "main has 2026-02-06", "new or revised: 2025, 2026", "- `pnpm test`: passed", head, self.env["RUN_URL"]):
            self.assertIn(text, create["input"]["body"])
        self.assertIn("Opened pull request #17", self.summary())

    def test_updates_the_open_data_pull_request_instead_of_opening_another(self):
        previous = self.branch("data/lobster-market-2027-01-10", snapshot("2027-01-10", "c", "2027-01-11T00:00:00Z"))
        self.responses = {PULLS: [0, [{"number": 12, "head": {"ref": "data/lobster-market-2027-01-10", "repo": {"full_name": REPO}}}]]}
        self.assertEqual(self.prepare().returncode, 0)
        branch = "data/lobster-market-2027-01-10"
        self.assertEqual({key: self.outputs()[key] for key in ("branch", "number")}, {"branch": branch, "number": "12"})
        result = self.publish()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git("rev-parse", f"{branch}^", cwd=self.origin), previous)
        self.assertEqual(json.loads(self.tree(branch, DATA)), self.new)
        status, update = self.writes()
        self.assertEqual(status["call"], f"POST repos/{REPO}/statuses/{self.tip(branch)}")
        self.assertEqual(update["call"], f"PATCH repos/{REPO}/pulls/12")
        self.assertIn("2027-02-05", update["input"]["title"])
        self.assertIn("- `pnpm test`: passed", update["input"]["body"])
        self.assertIn("Updated pull request #12", self.summary())

    def test_leaves_an_up_to_date_pull_request_alone(self):
        current = self.branch("data/lobster-market-2027-02-05", {**self.new, "checkedAt": "2027-02-01T14:23:00Z"})
        self.responses = {PULLS: [0, [{"number": 12, "head": {"ref": "data/lobster-market-2027-02-05", "repo": {"full_name": REPO}}}]]}
        result = self.prepare()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.outputs()["commit"], "false")
        self.assertEqual(self.tip("data/lobster-market-2027-02-05"), current)
        self.assertEqual(self.writes(), [])
        self.assertIn("#12 already has this series", self.summary())

    def test_refuses_to_reuse_a_leftover_branch(self):
        leftover = self.branch("data/lobster-market-2027-02-05", snapshot("2027-02-05", "c"))
        self.responses = {PULLS: [0, []]}
        result = self.prepare()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.tip("data/lobster-market-2027-02-05"), leftover)
        self.assertIn("already exists without an open pull request", self.summary())
        self.assertIn("already exists without an open pull request", (self.temp / "logs/prepare.log").read_text())
        self.assertEqual(self.writes(), [])

    def test_publish_pushes_only_to_a_data_branch(self):
        main = self.tip("main")
        self.responses = {PULLS: [0, []]}
        self.assertEqual(self.prepare().returncode, 0)
        for branch in ("main", "refs/heads/main", "data/other", "data/lobster-market-2027-02-05:main"):
            with self.subTest(branch):
                result = self.publish(BRANCH=branch)
                self.assertEqual(result.returncode, 1)
                self.assertIn("not a data branch", (self.temp / "logs/publish.log").read_text())
        self.assertEqual(self.tip("main"), main)
        self.assertFalse(self.has_branch("data/lobster-market-2027-02-05"))
        self.assertEqual(self.writes(), [])

    def test_publish_refuses_a_commit_the_checks_did_not_test(self):
        main = self.tip("main")
        self.responses = {PULLS: [0, []]}
        self.assertEqual(self.prepare().returncode, 0)
        for tested in ("", main):
            with self.subTest(tested=tested):
                result = self.publish(TESTED_SHA=tested)
                self.assertEqual(result.returncode, 1)
                self.assertIn("is not the commit the checks tested", (self.temp / "logs/publish.log").read_text())
        self.assertFalse(self.has_branch("data/lobster-market-2027-02-05"))
        self.assertEqual(self.writes(), [])

    def test_a_new_branch_is_removed_when_its_status_or_pull_request_fails(self):
        branch = "data/lobster-market-2027-02-05"
        self.responses = {PULLS: [0, []]}
        self.assertEqual(self.prepare().returncode, 0)
        head = self.git("rev-parse", "HEAD", cwd=self.work)
        for failing in (f"POST repos/{REPO}/statuses/{head}", f"POST repos/{REPO}/pulls"):
            with self.subTest(failing):
                self.responses = {PULLS: [0, []], f"POST repos/{REPO}/pulls": [0, {"number": 17}], failing: [1, {"message": "Forbidden"}]}
                result = self.publish()
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.has_branch(branch))
                self.assertIn(f"Removing {branch}", (self.temp / "logs/publish.log").read_text())

    def test_a_failed_update_keeps_the_open_pull_request_branch(self):
        branch = "data/lobster-market-2027-01-10"
        self.branch(branch, snapshot("2027-01-10", "c", "2027-01-11T00:00:00Z"))
        self.responses = {PULLS: [0, [{"number": 12, "head": {"ref": branch, "repo": {"full_name": REPO}}}]]}
        self.assertEqual(self.prepare().returncode, 0)
        self.responses[f"PATCH repos/{REPO}/pulls/12"] = [1, {"message": "Forbidden"}]
        result = self.publish()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.tip(branch), self.git("rev-parse", "HEAD", cwd=self.work))
        self.assertNotIn("Removing", (self.temp / "logs/publish.log").read_text())

    def test_a_failed_push_is_logged_for_the_failure_issue(self):
        self.responses = {PULLS: [0, []]}
        self.assertEqual(self.prepare().returncode, 0)
        self.git("remote", "set-url", "origin", str(self.root / "missing.git"), cwd=self.checkout)
        result = self.publish()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing.git", (self.temp / "logs/publish.log").read_text())
        self.assertEqual(self.writes(), [])


class ChecksStepTests(WorkflowHarness):
    def setUp(self):
        super().setUp()
        self.work = self.temp / "market-data-branch"
        self.work.mkdir()
        self.git("init", "--quiet", cwd=self.work)
        self.git("commit", "--quiet", "--allow-empty", "-m", "Data", cwd=self.work)
        venv = self.temp / "lobster-market-feed/bin"
        venv.mkdir(parents=True)
        for tool in (self.bin / "pnpm", venv / "pip", venv / "python"):
            tool.write_text(FAKE_TOOL)
            tool.chmod(0o755)
        self.env["FAKE_TOOL_LOG"] = str(self.root / "tools.log")

    def checks(self, fail=""):
        return self.run_step(CHECKS, FAKE_TOOL_FAIL=fail)

    def calls(self):
        return [tuple(line.split("\t")) for line in (self.root / "tools.log").read_text().splitlines()]

    def test_runs_every_pull_request_gate_on_the_data_commit(self):
        result = self.checks()
        self.assertEqual(result.returncode, 0, result.stderr)
        work = self.work.resolve()
        self.assertEqual([(Path(cwd).resolve(), call) for cwd, call in self.calls()], [
            (work, "pnpm install --frozen-lockfile"),
            (work, "pnpm test"),
            (work, "pnpm build"),
            (work, "pip install --quiet -r scripts/requirements-market.txt"),
            (work, "python -m unittest discover -s scripts -p test_lobster_market_*.py"),
        ])
        gates = (self.temp / "checks.md").read_text()
        for gate in ("pnpm install --frozen-lockfile", "pnpm test", "pnpm build", "importer tests"):
            self.assertIn(f"- `{gate}`: passed", gates)
        self.assertIn(gates, self.summary())
        self.assertEqual(self.outputs(), {"tested-sha": self.git("rev-parse", "HEAD", cwd=self.work)})

    def test_a_failed_gate_stops_the_run_and_is_reported(self):
        result = self.checks(fail="pnpm test")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.outputs(), {})
        self.assertEqual([call for _, call in self.calls()], ["pnpm install --frozen-lockfile", "pnpm test"])
        self.assertIn("- `pnpm test`: **failed**", self.summary())
        self.assertIn("pnpm test: something broke", (self.temp / "logs/checks.log").read_text())


class FailureIssueTests(WorkflowHarness):
    def report(self, result, summary="### Official source\n\nHTTP Error 403: Forbidden\n"):
        outcome = self.run_step(REPORT, REFRESH_RESULT=result, REFRESH_SUMMARY=summary, GITHUB_RUN_ID="1", REFRESH_JOB_NAME="Refresh market series", REFRESH_TIMEOUT_MINUTES="45")
        self.assertEqual(outcome.returncode, 0, outcome.stderr)
        return self.writes()

    def test_first_failure_opens_one_labelled_issue_with_the_summary(self):
        self.responses = {
            ISSUES: [0, [{"number": 7, "title": TITLE, "pull_request": {}}, {"number": 8, "title": "Something else"}]],
            f"GET repos/{REPO}/labels/market-refresh": [1, {"message": "Not Found"}],
            f"POST repos/{REPO}/issues": [0, {"number": 9}],
        }
        label, issue = self.report("failure")
        self.assertEqual(label["call"], f"POST repos/{REPO}/labels")
        self.assertEqual(label["input"]["name"], "market-refresh")
        self.assertEqual(issue["call"], f"POST repos/{REPO}/issues")
        self.assertEqual((issue["input"]["title"], issue["input"]["labels"]), (TITLE, ["market-refresh"]))
        for text in ("HTTP Error 403: Forbidden", "failure", self.env["RUN_URL"], "--source-file"):
            self.assertIn(text, issue["input"]["body"])
        self.assertIn("Opened issue #9", (self.root / "step-summary").read_text())

    def test_later_failures_update_the_open_issue(self):
        self.responses = {ISSUES: [0, [{"number": 5, "title": TITLE}]]}
        [comment] = self.report("failure", summary="")
        self.assertEqual(comment["call"], f"POST repos/{REPO}/issues/5/comments")
        self.assertIn("No summary was captured", comment["input"]["body"])

    def jobs(self, minutes, name="Refresh market series"):
        started = "2026-10-19T14:23:05Z"
        completed = f"2026-10-19T{14 + (23 + minutes) // 60:02d}:{(23 + minutes) % 60:02d}:05Z"
        return [0, {"total_count": 2, "jobs": [
            {"name": "Report refresh status", "started_at": "2026-10-19T15:10:00Z", "completed_at": None},
            {"name": name, "conclusion": "cancelled", "started_at": started, "completed_at": completed},
        ]}]

    def test_a_timed_out_refresh_is_reported_as_a_failure(self):
        self.responses = {ISSUES: [0, [{"number": 5, "title": TITLE}]], JOBS: self.jobs(45)}
        [comment] = self.report("cancelled")
        self.assertEqual(comment["call"], f"POST repos/{REPO}/issues/5/comments")
        self.assertIn("45-minute job timeout", comment["input"]["body"])
        self.assertIn("HTTP Error 403: Forbidden", comment["input"]["body"])

    def test_a_refresh_cancelled_by_hand_changes_nothing(self):
        for jobs in (self.jobs(12), self.jobs(45, name="Something else"), [0, {"jobs": []}]):
            with self.subTest(jobs=jobs):
                self.responses = {ISSUES: [0, [{"number": 5, "title": TITLE}]], JOBS: jobs}
                self.assertEqual(self.report("cancelled"), [])
                self.assertIn("cancelled before its timeout", (self.root / "step-summary").read_text())

    def test_skipped_refresh_changes_nothing(self):
        self.responses = {ISSUES: [0, [{"number": 5, "title": TITLE}]]}
        self.assertEqual(self.report("skipped"), [])

    def test_success_closes_the_open_issue(self):
        self.responses = {ISSUES: [0, [{"number": 5, "title": TITLE}]]}
        comment, close = self.report("success")
        self.assertEqual(comment["call"], f"POST repos/{REPO}/issues/5/comments")
        self.assertIn(self.env["RUN_URL"], comment["input"]["body"])
        self.assertEqual(close, {"call": f"PATCH repos/{REPO}/issues/5", "input": {"state": "closed", "state_reason": "completed"}})

    def test_success_without_an_issue_changes_nothing(self):
        self.responses = {ISSUES: [0, []]}
        self.assertEqual(self.report("success"), [])


if __name__ == "__main__":
    unittest.main()
