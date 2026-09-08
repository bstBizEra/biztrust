"""The validator cannot fail OPEN.

An instrument that has never been observed failing is indistinguishable from one
that passed. These tests build a minimal repository in a temporary directory,
prove the validator passes on it, then break exactly one thing at a time and
require that each break is reported.

The property under test is not "the validator finds this defect". It is that a
malformed artifact produces exactly one ``CONTINUITY_VALIDATION`` summary line
and a NON-ZERO exit, never a traceback and silence, which a caller reads as
success.

Run: ``py -m unittest discover -s tests/unit`` (``python3`` on Linux).
"""

from __future__ import annotations

import copy
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VALIDATOR = ROOT / "scripts" / "validate_continuity.py"

WP = "BIZTRUST-WP-999"
SHA = "0" * 40
NOW = "2026-01-01T00:00:00Z"

STATE = {
    "schema_version": "1.0.0",
    "project_id": "BIZTRUST",
    "repository": "bstBizEra/biztrust",
    "updated_at": NOW,
    "active_work_package": {
        "id": WP,
        "title": "fixture",
        "state": "IN_PROGRESS",
        "objective": "fixture",
        "issue_url": None,
        "owner_role": "platform-engineer",
        "scope": ["fixture"],
    },
    "source": {
        "branch": "fixture",
        "baseline_commit": SHA,
        "baseline_kind": "main",
        "expected_remote": "https://github.com/bstBizEra/biztrust",
    },
    "gates": {
        "BT-G0": "UNRECORDED",
        "BT-G1": "UNRECORDED",
        "BT-G2": "UNRECORDED",
        "BT-G3": "UNRECORDED",
        "BT-G4": "UNRECORDED",
        "boundary_check": "PASS",
        "migration_lint": "PASS",
        "record_validation": "PASS",
        "typecheck": "PASS",
        "mutation_check": "PASS",
        "branch_protection": "NOT_RECORDED_REQUIRES_REPOSITORY_ADMIN",
    },
    "authority": {
        "repository_scaffold": "GRANTED_BY_OPERATOR_INSTRUCTION_2026_09_08",
        "architecture_contract_freeze": "NOT_GRANTED",
        "p0_implementation": "NOT_GRANTED",
        "adr_acceptance": "NOT_GRANTED",
        "production_deployment": "NOT_GRANTED",
        "main_branch_protection": "NOT_RECORDED_REQUIRES_REPOSITORY_ADMIN",
        "wp_001_acceptance": "NOT_GRANTED_AWAITING_INDEPENDENT_VERIFIER",
    },
    "latest_checkpoint": "sessions/checkpoints/fixture.json",
    "latest_handoff": None,
    "primary_next_action_id": "NS-001",
    "resume_decision": "CONTINUE",
    "stop_reason": None,
    "known_divergence": None,
}

ACTIONS = {
    "schema_version": "1.0.0",
    "work_package": WP,
    "generated_at": NOW,
    "actions": [
        {
            "id": "NS-001",
            "priority": 1,
            "primary": True,
            "title": "fixture",
            "owner_role": "platform-engineer",
            "blocked_by": [],
            "acceptance": "fixture",
        },
        {
            "id": "NS-002",
            "priority": 2,
            "primary": False,
            "title": "fixture",
            "owner_role": "platform-engineer",
            "blocked_by": ["NS-001"],
            "acceptance": "fixture",
        },
    ],
}

DECISION = {
    "id": "DEC-001",
    "recorded_at": NOW,
    "work_package": WP,
    "decision": "fixture",
    "rationale": "fixture",
    "authority": "fixture",
    "agent_id": "fixture",
    "supersedes": None,
}

CHECKPOINT = {
    "schema_version": "1.0.0",
    "work_package": WP,
    "state": "IN_PROGRESS",
    "created_at": NOW,
    "objective": "fixture",
    "completed_scope": [],
    "branch": "fixture",
    "baseline_commit": SHA,
    "files_changed": [],
    "validation": [{"command": "true", "exit_status": 0, "observed_at": NOW}],
    "decisions": [],
    "assumptions": [],
    "blockers": [],
    "authority_status": "fixture",
    "next_action_id": "NS-001",
    "next_action": "fixture",
    "recovery": "fixture",
}

REGISTRY_STUB = 'version: "0.1.0"\nfixture: true\n'
REGISTRIES = ("lifecycle.yaml", "authority.yaml", "gates.yaml", "agents.yaml", "skills.yaml")


def build(tmp: Path, *, state=None, actions=None, decision_lines=None, checkpoint=None,
          registries=REGISTRIES, extra_files=None) -> Path:
    """Materialises a minimal repository the validator can run against."""
    (tmp / "scripts").mkdir(parents=True, exist_ok=True)
    shutil.copy2(VALIDATOR, tmp / "scripts" / "validate_continuity.py")
    shutil.copytree(ROOT / "schemas", tmp / "schemas", dirs_exist_ok=True)

    badf = tmp / "badf"
    badf.mkdir(exist_ok=True)
    (badf / "current-state.json").write_text(
        json.dumps(STATE if state is None else state, indent=2), encoding="utf-8"
    )
    (badf / "next-actions.json").write_text(
        json.dumps(ACTIONS if actions is None else actions, indent=2), encoding="utf-8"
    )
    lines = [json.dumps(DECISION)] if decision_lines is None else decision_lines
    (badf / "decision-log.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")
    for name in registries:
        (badf / name).write_text(REGISTRY_STUB, encoding="utf-8")

    checkpoints = tmp / "sessions" / "checkpoints"
    checkpoints.mkdir(parents=True, exist_ok=True)
    if checkpoint is not False:
        (checkpoints / "fixture.json").write_text(
            json.dumps(CHECKPOINT if checkpoint is None else checkpoint, indent=2),
            encoding="utf-8",
        )
    for relative, content in (extra_files or {}).items():
        target = tmp / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    return tmp


def run(tmp: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(tmp / "scripts" / "validate_continuity.py")],
        capture_output=True, text=True, cwd=tmp, check=False,
    )


class ValidatorFailsClosed(unittest.TestCase):
    def _broken(self, **kwargs) -> subprocess.CompletedProcess:
        """Builds a repository with one deliberate defect and runs the validator."""
        with tempfile.TemporaryDirectory() as directory:
            result = run(build(Path(directory), **kwargs))
        self.assertNotEqual(
            result.returncode, 0,
            f"the validator PASSED on a malformed repository, which is failing "
            f"open:\n{result.stdout}{result.stderr}",
        )
        combined = result.stdout + result.stderr
        summaries = [
            line for line in combined.splitlines()
            if line.startswith("CONTINUITY_VALIDATION FAIL")
        ]
        self.assertEqual(
            len(summaries), 1,
            f"expected exactly one summary line, found {len(summaries)}:\n{combined}",
        )
        self.assertNotIn(
            "Traceback", combined,
            "a raw traceback reached the caller instead of one summary line",
        )
        return result

    # ---- the baseline must pass, or every test below is meaningless --------

    def test_the_valid_fixture_passes(self):
        with tempfile.TemporaryDirectory() as directory:
            result = run(build(Path(directory)))
        self.assertEqual(
            result.returncode, 0,
            f"the baseline fixture must pass:\n{result.stdout}{result.stderr}",
        )
        self.assertIn("CONTINUITY_VALIDATION PASS", result.stdout)

    # ---- one deliberate defect per test ------------------------------------

    def test_missing_required_field_is_a_data_defect(self):
        state = copy.deepcopy(STATE)
        del state["resume_decision"]
        result = self._broken(state=state)
        self.assertEqual(result.returncode, 1)
        self.assertIn("resume_decision", result.stderr)

    def test_wrong_typed_field_is_a_data_defect(self):
        state = copy.deepcopy(STATE)
        state["active_work_package"]["scope"] = "not a list"
        result = self._broken(state=state)
        self.assertEqual(result.returncode, 1)

    def test_unexpected_field_is_reported(self):
        state = copy.deepcopy(STATE)
        state["surprise"] = "unexpected"
        result = self._broken(state=state)
        self.assertIn("surprise", result.stderr)

    def test_value_outside_the_enum_is_reported(self):
        state = copy.deepcopy(STATE)
        state["resume_decision"] = "PROBABLY_FINE"
        self._broken(state=state)

    def test_a_timestamp_that_is_not_rfc3339_is_reported(self):
        state = copy.deepcopy(STATE)
        state["updated_at"] = "8 September 2026"
        self._broken(state=state)

    def test_unparseable_json_is_a_data_defect_not_a_crash(self):
        with tempfile.TemporaryDirectory() as directory:
            tmp = build(Path(directory))
            (tmp / "badf" / "current-state.json").write_text("{ not json", encoding="utf-8")
            result = run(tmp)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertNotIn("Traceback", result.stdout + result.stderr)

    def test_two_primary_actions_are_reported(self):
        actions = copy.deepcopy(ACTIONS)
        actions["actions"][1]["primary"] = True
        result = self._broken(actions=actions)
        self.assertIn("primary", result.stderr)

    def test_no_primary_action_is_reported(self):
        actions = copy.deepcopy(ACTIONS)
        actions["actions"][0]["primary"] = False
        self._broken(actions=actions)

    def test_a_gap_in_the_priorities_is_reported(self):
        actions = copy.deepcopy(ACTIONS)
        actions["actions"][1]["priority"] = 7
        result = self._broken(actions=actions)
        self.assertIn("priorities", result.stderr)

    def test_a_work_package_mismatch_across_the_records_is_reported(self):
        actions = copy.deepcopy(ACTIONS)
        actions["work_package"] = "BIZTRUST-WP-888"
        result = self._broken(actions=actions)
        self.assertIn("work package id", result.stderr)

    def test_a_primary_action_the_state_file_does_not_name_is_reported(self):
        state = copy.deepcopy(STATE)
        state["primary_next_action_id"] = "NS-002"
        result = self._broken(state=state)
        self.assertIn("primary", result.stderr)

    def test_a_missing_checkpoint_is_reported(self):
        result = self._broken(checkpoint=False)
        self.assertIn("checkpoint", result.stderr)

    def test_a_checkpoint_with_no_validation_entry_is_reported(self):
        checkpoint = copy.deepcopy(CHECKPOINT)
        checkpoint["validation"] = []
        self._broken(checkpoint=checkpoint)

    def test_duplicate_decision_ids_are_reported(self):
        lines = [json.dumps(DECISION), json.dumps(DECISION)]
        result = self._broken(decision_lines=lines)
        self.assertIn("unique", result.stderr)

    def test_descending_decision_ids_are_reported(self):
        second = copy.deepcopy(DECISION)
        second["id"] = "DEC-002"
        lines = [json.dumps(second), json.dumps(DECISION)]
        result = self._broken(decision_lines=lines)
        self.assertIn("ascending", result.stderr)

    def test_a_malformed_decision_line_is_reported(self):
        lines = [json.dumps(DECISION), "{ not json"]
        self._broken(decision_lines=lines)

    def test_a_missing_registry_is_reported(self):
        result = self._broken(registries=("lifecycle.yaml", "authority.yaml", "gates.yaml"))
        self.assertIn("agents.yaml", result.stderr)

    def test_a_registry_with_no_version_is_reported(self):
        with tempfile.TemporaryDirectory() as directory:
            tmp = build(Path(directory))
            (tmp / "badf" / "gates.yaml").write_text("fixture: true\n", encoding="utf-8")
            result = run(tmp)
        self.assertEqual(result.returncode, 1)
        self.assertIn("version", result.stderr)

    # ---- the forgery a peer review used to get exit 0 ----------------------
    #
    # These six are the regression tests for the one hole found in the
    # fail-closed suite: `gates` and `authority` were declared as bare
    # `{"type": "object"}`, so the two most governance-relevant blocks in the
    # repository were unconstrained. Every gate could be erased and a grant
    # forged, and the validator said PASS.

    def test_a_forged_implementation_grant_is_reported(self):
        state = copy.deepcopy(STATE)
        state["authority"]["p0_implementation"] = "GRANTED"
        result = self._broken(state=state)
        self.assertEqual(result.returncode, 1)
        self.assertIn("p0_implementation", result.stderr)

    def test_a_forged_self_acceptance_is_reported(self):
        state = copy.deepcopy(STATE)
        state["authority"]["wp_001_acceptance"] = "ACCEPTED_BY_SELF"
        self._broken(state=state)

    def test_a_forged_production_grant_is_reported(self):
        state = copy.deepcopy(STATE)
        state["authority"]["production_deployment"] = "GRANTED"
        self._broken(state=state)

    def test_an_invented_authority_key_is_reported(self):
        state = copy.deepcopy(STATE)
        state["authority"]["arbitrary_junk"] = [1, 2, 3]
        result = self._broken(state=state)
        self.assertIn("arbitrary_junk", result.stderr)

    def test_erasing_every_gate_is_reported(self):
        state = copy.deepcopy(STATE)
        state["gates"] = {}
        result = self._broken(state=state)
        self.assertIn("BT-G0", result.stderr)

    def test_recording_a_delivery_gate_from_a_data_file_is_reported(self):
        """A gate is a human decision, so it cannot be a one-word data edit."""
        state = copy.deepcopy(STATE)
        state["gates"]["BT-G0"] = "PASSED"
        result = self._broken(state=state)
        self.assertIn("BT-G0", result.stderr)

    def test_a_latest_checkpoint_that_is_not_a_checkpoint_is_reported(self):
        """Existence alone accepted README.md as the latest checkpoint."""
        state = copy.deepcopy(STATE)
        state["latest_checkpoint"] = "README.md"
        self._broken(state=state)

    def test_a_credential_in_the_tree_is_reported(self):
        result = self._broken(
            extra_files={"docs/leak.md": "token: ghp_" + "A" * 36 + "\n"}
        )
        self.assertIn("leak.md", result.stderr)

    def test_a_credential_inside_a_binary_file_is_reported(self):
        """The scan skipped anything that was not valid UTF-8.

        A peer review found a tracked .pyc holding an assembled token literal,
        which proved the blind spot. A secret does not stop being a secret
        because the file around it does not decode.
        """
        with tempfile.TemporaryDirectory() as directory:
            tmp = build(Path(directory))
            blob = tmp / "docs" / "blob.bin"
            blob.parent.mkdir(parents=True, exist_ok=True)
            payload = b"\x00\x01\xff\xfe" + b"ghp_" + b"B" * 36 + b"\x00\xff"
            blob.write_bytes(payload)
            result = run(tmp)
        self.assertEqual(
            result.returncode, 1,
            f"a credential in a binary must be reported:\n{result.stdout}{result.stderr}",
        )
        self.assertIn("blob.bin", result.stderr)

    # ---- a schema defect must be exit 2, not a quiet pass ------------------

    def test_an_unimplemented_schema_keyword_is_a_validator_defect(self):
        with tempfile.TemporaryDirectory() as directory:
            tmp = build(Path(directory))
            path = tmp / "schemas" / "current-state.schema.json"
            schema = json.loads(path.read_text(encoding="utf-8"))
            # oneOf is real JSON Schema that this checker does not implement.
            schema["properties"]["repository"] = {"oneOf": [{"type": "string"}]}
            path.write_text(json.dumps(schema, indent=2), encoding="utf-8")
            result = run(tmp)
        self.assertEqual(
            result.returncode, 2,
            "a schema keyword the checker cannot enforce must be a VALIDATOR defect "
            f"(exit 2), never a silent pass:\n{result.stdout}{result.stderr}",
        )
        self.assertIn("oneOf", result.stderr)

    def test_an_unreadable_schema_is_a_validator_defect(self):
        with tempfile.TemporaryDirectory() as directory:
            tmp = build(Path(directory))
            (tmp / "schemas" / "next-actions.schema.json").write_text("{ broken", encoding="utf-8")
            result = run(tmp)
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)


class ValidatorRunsAgainstThisRepository(unittest.TestCase):
    def test_the_real_records_pass(self):
        result = subprocess.run(
            [sys.executable, str(VALIDATOR)],
            capture_output=True, text=True, cwd=ROOT, check=False,
        )
        self.assertEqual(
            result.returncode, 0,
            f"this repository's own records must validate:\n{result.stdout}{result.stderr}",
        )


if __name__ == "__main__":
    unittest.main()
