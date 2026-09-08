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

#: A minimal but STRUCTURALLY REAL authority registry.
#:
#: The other four registries can be stubs. This one cannot: it is the source of
#: record for what is granted, and it is cross-checked against the state file,
#: so it has to carry the same keys the state file asserts. Hardening only the
#: state file left this one checked for nothing but a version line, and a
#: review appended a forged section to it and got a pass.
AUTHORITY_YAML = """version: "0.1.0"
updated_at: "2026-01-01T00:00:00Z"

not_granted:
  architecture_contract_freeze:
    status: NOT_GRANTED
  p0_implementation:
    status: NOT_GRANTED
  adr_acceptance:
    status: NOT_GRANTED
  production_deployment:
    status: NOT_GRANTED
  main_branch_protection:
    status: NOT_RECORDED
  wp_001_acceptance:
    status: NOT_GRANTED

granted:
  repository_scaffold:
    status: GRANTED
    granted_by: "operator, direct instruction"
    recorded_by: "agent"
    expires_at: "UNBOUNDED_PENDING_REVIEW"
"""

#: The gate registry, which AGENTS.md section 4 makes authoritative for gate
#: results. A stub left it checked for a version line, so a review set every
#: gate to PASSED and deleted the whole delivery_gates section, both with a
#: pass. It has to carry the same five ids the state file mirrors.
GATES_YAML = """version: "0.1.0"

delivery_gates:
  - id: BT-G0
    status: UNRECORDED
  - id: BT-G1
    status: UNRECORDED
  - id: BT-G2
    status: UNRECORDED
  - id: BT-G3
    status: UNRECORDED
  - id: BT-G4
    status: UNRECORDED
"""

#: Only the two statements the acceptance check stands on. A rule an agent can
#: edit is a rule an agent does not have, and a review rewrote this transition
#: to requires_human: false and got a pass.
LIFECYCLE_YAML = """version: "0.1.0"

transitions:
  - from: ENGINEERING_READY
    to: ACCEPTED
    role: "verifier, who is not the implementer"
    requires_human: true

forbidden:
  - "Any transition into ACCEPTED made by the implementing agent"
"""

#: A minimal but STRUCTURALLY REAL capability registry. Task 6: badf/skills.yaml
#: used to be checked for a version: line and nothing else, so record-a-gate and
#: grant-authority could be set to AVAILABLE with nothing objecting. This has to
#: carry both, pinned FORBIDDEN_TO_AGENTS, for the pin to mean anything.
SKILLS_YAML = """version: "0.1.0"

skills:
  - id: read-records
    what: "fixture"
    authority_required: none
    status: AVAILABLE

  - id: record-a-gate
    what: "fixture"
    authority_required: "the human role the gate names"
    status: FORBIDDEN_TO_AGENTS

  - id: grant-authority
    what: "fixture"
    authority_required: "business-authority or repository-administrator"
    status: FORBIDDEN_TO_AGENTS
"""

#: A minimal but STRUCTURALLY REAL role registry. Task 6: badf/agents.yaml had
#: no field capable of recording who holds a seat, and may_be_an_agent could be
#: flipped to true on all four human-only seats with nothing objecting. This
#: carries all four, each false with a held_by field, plus one agent-eligible
#: role and one routing entry, so both pins have something to bind to.
AGENTS_YAML = """version: "0.1.0"

roles:
  - id: platform-engineer
    owns: ["fixture"]
    may_be_an_agent: true
    held_by: null

  - id: repository-administrator
    owns: ["fixture"]
    may_be_an_agent: false
    held_by: null

  - id: architecture-authority
    owns: ["fixture"]
    may_be_an_agent: false
    held_by: null

  - id: business-authority
    owns: ["fixture"]
    may_be_an_agent: false
    held_by: null

  - id: legal-compliance-reviewer
    owns: ["fixture"]
    may_be_an_agent: false
    held_by: null

routing:
  - path: "modules/**"
    owner: platform-engineer
    verifier: peer-reviewer
"""


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
        content = {
            "authority.yaml": AUTHORITY_YAML,
            "gates.yaml": GATES_YAML,
            "lifecycle.yaml": LIFECYCLE_YAML,
            "agents.yaml": AGENTS_YAML,
            "skills.yaml": SKILLS_YAML,
        }.get(name, REGISTRY_STUB)
        (badf / name).write_text(content, encoding="utf-8")

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

    # ---- the authority REGISTRY, not just its mirror -----------------------
    #
    # The state file was hardened first, which left the source of record
    # checked for nothing but a version line. A review appended a forged
    # section to badf/authority.yaml and the validator passed.

    def _with_authority(self, extra: str, mutate_state=None):
        with tempfile.TemporaryDirectory() as directory:
            tmp = build(Path(directory), state=mutate_state)
            authority = tmp / "badf" / "authority.yaml"
            authority.write_text(AUTHORITY_YAML + extra, encoding="utf-8")
            result = run(tmp)
        return result

    def test_the_authority_fixture_passes(self):
        result = self._with_authority("")
        self.assertEqual(
            result.returncode, 0,
            f"the authority baseline must pass:\n{result.stdout}{result.stderr}",
        )

    def test_a_forged_section_in_the_authority_registry_is_reported(self):
        result = self._with_authority(
            "\ngranted_extra:\n"
            "  p0_implementation: GRANTED_BY_NOBODY\n"
            "  production_deployment: GRANTED\n"
        )
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("granted_extra", result.stderr)

    def test_a_key_under_both_granted_and_not_granted_is_reported(self):
        result = self._with_authority(
            "\ngranted:\n  p0_implementation:\n    status: GRANTED\n"
        )
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("p0_implementation", result.stderr)

    def test_a_withheld_grant_that_does_not_read_as_withheld_is_reported(self):
        text = AUTHORITY_YAML.replace(
            "  p0_implementation:\n    status: NOT_GRANTED",
            "  p0_implementation:\n    status: GRANTED",
        )
        with tempfile.TemporaryDirectory() as directory:
            tmp = build(Path(directory))
            (tmp / "badf" / "authority.yaml").write_text(text, encoding="utf-8")
            result = run(tmp)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("not_granted", result.stderr)

    def test_a_state_authority_key_the_registry_does_not_record_is_reported(self):
        text = AUTHORITY_YAML.replace(
            "  production_deployment:\n    status: NOT_GRANTED\n", ""
        )
        with tempfile.TemporaryDirectory() as directory:
            tmp = build(Path(directory))
            (tmp / "badf" / "authority.yaml").write_text(text, encoding="utf-8")
            result = run(tmp)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("production_deployment", result.stderr)

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



class RoundThreeForgeries(unittest.TestCase):
    """Every forgery peer review round three got a pass with.

    Round two hardened the state file's authority enum and left the registry it
    mirrors readable only by two regexes. Round three walked through the gap
    five different ways, and through three registries nothing read at all. Each
    test below is one of those, kept so the hole cannot reopen quietly.
    """

    def _run(self, *, authority=None, gates=None, lifecycle=None, state=None,
             checkpoint=None):
        with tempfile.TemporaryDirectory() as directory:
            tmp = build(Path(directory), state=state, checkpoint=checkpoint)
            if authority is not None:
                (tmp / "badf" / "authority.yaml").write_text(authority, encoding="utf-8")
            if gates is not None:
                (tmp / "badf" / "gates.yaml").write_text(gates, encoding="utf-8")
            if lifecycle is not None:
                (tmp / "badf" / "lifecycle.yaml").write_text(lifecycle, encoding="utf-8")
            return run(tmp)

    def _refused(self, needle, **kwargs):
        result = self._run(**kwargs)
        self.assertEqual(
            result.returncode, 1,
            f"this forgery must be refused:\n{result.stdout}{result.stderr}",
        )
        self.assertIn(needle, result.stderr)

    # ---- the reader itself -------------------------------------------------

    def test_a_flow_style_grant_is_reported(self):
        """One line of valid YAML forged the grant this repository withholds.

        An entry was required to have nothing after its colon, so this was
        invisible and the granted/not_granted overlap check never fired.
        """
        self._refused(
            "inline value",
            authority=AUTHORITY_YAML.replace(
                "granted:\n  repository_scaffold:",
                "granted:\n  p0_implementation: {status: GRANTED}\n  repository_scaffold:",
            ),
        )

    def test_an_uppercase_forged_section_is_reported(self):
        """`GRANTED_EXTRA:` walked past a `^[a-z0-9_]+:` section sniffer."""
        self._refused(
            "GRANTED_EXTRA",
            authority=AUTHORITY_YAML + "\nGRANTED_EXTRA:\n  p0_override:\n    status: GRANTED\n",
        )

    def test_a_tab_indented_block_is_reported(self):
        self._refused(
            "tab",
            authority=AUTHORITY_YAML + "\ngranted:\n\tp0_implementation:\n\t\tstatus: GRANTED\n",
        )

    def test_an_unexpected_indent_is_reported(self):
        self._refused(
            "indented 3 spaces",
            authority=AUTHORITY_YAML + "\ngranted:\n   p0_implementation:\n      status: GRANTED\n",
        )

    # ---- what the reader is asked ------------------------------------------

    def test_a_granted_entry_with_no_status_is_reported(self):
        """Membership used to be established by the key alone."""
        self._refused(
            "records no status",
            authority=AUTHORITY_YAML + "  p0_implementation_for_wp002:\n    what: \"anything\"\n",
        )

    def test_an_expired_grant_is_reported(self):
        """AGENTS.md section 11 makes expired authority a stop condition.

        Nothing enforced `expires_at`, so back-dating it to 2020 passed.
        """
        self._refused(
            "expired on 2020-01-01",
            authority=AUTHORITY_YAML.replace(
                'expires_at: "UNBOUNDED_PENDING_REVIEW"', 'expires_at: "2020-01-01"'
            ),
        )

    def test_a_grant_present_only_in_the_registry_is_reported(self):
        """The state/registry relation was one-directional.

        Only keys the state file already named were examined, so a grant ADDED
        to the registry agreed with nothing and passed.
        """
        self._refused(
            "no matching key",
            authority=AUTHORITY_YAML + (
                "  p0_2_implementation:\n"
                "    status: GRANTED\n"
                '    granted_by: "business authority seat"\n'
                '    recorded_by: "business-authority"\n'
                '    expires_at: "2099-01-01"\n'
            ),
        )

    def test_a_grant_recorded_by_an_agent_is_reported(self):
        self._refused(
            'recorded_by "agent"',
            authority=AUTHORITY_YAML + (
                "  p0_2_implementation:\n"
                "    status: GRANTED\n"
                '    granted_by: "business authority seat"\n'
                '    recorded_by: "agent"\n'
                '    expires_at: "2099-01-01"\n'
            ),
        )

    # ---- the three registries nothing read ---------------------------------

    def test_a_recorded_gate_in_the_registry_is_reported(self):
        """AGENTS.md section 4 makes gates.yaml authoritative, and it was the
        unvalidated copy. Setting BT-G0 to PASSED there passed."""
        self._refused(
            "BT-G0", gates=GATES_YAML.replace(
                "  - id: BT-G0\n    status: UNRECORDED",
                "  - id: BT-G0\n    status: PASSED",
            ),
        )

    def test_deleting_the_delivery_gates_is_reported(self):
        self._refused("BT-G0 is missing", gates='version: "0.1.0"\n')

    def test_rewriting_the_acceptance_transition_is_reported(self):
        self._refused(
            "requires_human",
            lifecycle=LIFECYCLE_YAML.replace(
                '    role: "verifier, who is not the implementer"\n    requires_human: true',
                '    role: "owner"\n    requires_human: false',
            ),
        )

    def test_deleting_the_forbidden_self_acceptance_line_is_reported(self):
        self._refused(
            "forbidden list",
            lifecycle=LIFECYCLE_YAML.replace(
                '  - "Any transition into ACCEPTED made by the implementing agent"\n', ""
            ),
        )

    # ---- an agent accepting its own work -----------------------------------

    def test_a_work_package_cannot_accept_itself(self):
        """The state ran ahead of the acceptance record and nothing objected."""
        state = copy.deepcopy(STATE)
        state["active_work_package"]["state"] = "ACCEPTED"
        checkpoint = copy.deepcopy(CHECKPOINT)
        checkpoint["state"] = "ACCEPTED"
        self._refused("may not run ahead of the acceptance record",
                      state=state, checkpoint=checkpoint)

    def test_a_checkpoint_that_describes_other_work_is_reported(self):
        """A forged checkpoint conformed to the schema and was bound to nothing."""
        checkpoint = copy.deepcopy(CHECKPOINT)
        checkpoint["branch"] = "no-such-branch"
        self._refused("branch", checkpoint=checkpoint)

class SkillsAndAgentsRegistriesClosed(unittest.TestCase):
    """Task 6: badf/skills.yaml and badf/agents.yaml were each checked for
    existence, non-emptiness and a version: line and nothing else.

    An agent could set record-a-gate or grant-authority to AVAILABLE in
    skills.yaml, or flip may_be_an_agent to true on all four human-only seats
    in agents.yaml, and `pnpm validate:records` returned exit 0. agents.yaml
    also had no field capable of recording who holds a seat, so NS-001's
    acceptance ("a named human holds the seat") could not be recorded in the
    record it names. Every test below is one of those, kept so the hole
    cannot reopen quietly.
    """

    def _run(self, *, skills=None, agents=None):
        with tempfile.TemporaryDirectory() as directory:
            tmp = build(Path(directory))
            if skills is not None:
                (tmp / "badf" / "skills.yaml").write_text(skills, encoding="utf-8")
            if agents is not None:
                (tmp / "badf" / "agents.yaml").write_text(agents, encoding="utf-8")
            return run(tmp)

    def _refused(self, needle, **kwargs):
        result = self._run(**kwargs)
        self.assertEqual(
            result.returncode, 1,
            f"this forgery must be refused:\n{result.stdout}{result.stderr}",
        )
        self.assertIn(needle, result.stderr)

    # ---- the baselines must pass, or every test below is meaningless -------

    def test_the_skills_fixture_passes(self):
        result = self._run(skills=SKILLS_YAML)
        self.assertEqual(
            result.returncode, 0,
            f"the skills baseline must pass:\n{result.stdout}{result.stderr}",
        )

    def test_the_agents_fixture_passes(self):
        result = self._run(agents=AGENTS_YAML)
        self.assertEqual(
            result.returncode, 0,
            f"the agents baseline must pass:\n{result.stdout}{result.stderr}",
        )

    # ---- badf/skills.yaml: record-a-gate and grant-authority -------------

    def test_making_record_a_gate_available_is_reported(self):
        text = SKILLS_YAML.replace(
            "  - id: record-a-gate\n"
            '    what: "fixture"\n'
            '    authority_required: "the human role the gate names"\n'
            "    status: FORBIDDEN_TO_AGENTS",
            "  - id: record-a-gate\n"
            '    what: "fixture"\n'
            '    authority_required: "the human role the gate names"\n'
            "    status: AVAILABLE",
        )
        self.assertNotEqual(text, SKILLS_YAML, "the replace target did not match")
        self._refused("record-a-gate", skills=text)

    def test_making_grant_authority_available_is_reported(self):
        text = SKILLS_YAML.replace(
            "  - id: grant-authority\n"
            '    what: "fixture"\n'
            '    authority_required: "business-authority or repository-'
            'administrator"\n'
            "    status: FORBIDDEN_TO_AGENTS",
            "  - id: grant-authority\n"
            '    what: "fixture"\n'
            '    authority_required: "business-authority or repository-'
            'administrator"\n'
            "    status: AVAILABLE",
        )
        self.assertNotEqual(text, SKILLS_YAML, "the replace target did not match")
        self._refused("grant-authority", skills=text)

    def test_deleting_record_a_gate_is_reported(self):
        """Deleting the row is another way to stop it being FORBIDDEN_TO_AGENTS."""
        text = SKILLS_YAML.replace(
            "\n  - id: record-a-gate\n"
            '    what: "fixture"\n'
            '    authority_required: "the human role the gate names"\n'
            "    status: FORBIDDEN_TO_AGENTS\n",
            "\n",
        )
        self.assertNotEqual(text, SKILLS_YAML, "the replace target did not match")
        self._refused("record-a-gate", skills=text)

    def test_a_skill_status_outside_the_closed_set_is_reported(self):
        text = SKILLS_YAML.replace(
            "    status: AVAILABLE\n\n  - id: record-a-gate",
            "    status: PROBABLY_FINE\n\n  - id: record-a-gate",
        )
        self.assertNotEqual(text, SKILLS_YAML, "the replace target did not match")
        self._refused("PROBABLY_FINE", skills=text)

    # ---- badf/agents.yaml: may_be_an_agent and held_by ---------------------

    def test_flipping_may_be_an_agent_true_on_a_human_seat_is_reported(self):
        text = AGENTS_YAML.replace(
            "  - id: repository-administrator\n"
            '    owns: ["fixture"]\n'
            "    may_be_an_agent: false\n"
            "    held_by: null",
            "  - id: repository-administrator\n"
            '    owns: ["fixture"]\n'
            "    may_be_an_agent: true\n"
            "    held_by: null",
        )
        self.assertNotEqual(text, AGENTS_YAML, "the replace target did not match")
        self._refused("repository-administrator", agents=text)

    def test_flipping_all_four_human_seats_to_agent_true_is_reported(self):
        """The peer-review finding, verbatim: all four seats, one edit."""
        text = AGENTS_YAML.replace("may_be_an_agent: false", "may_be_an_agent: true")
        self.assertNotEqual(text, AGENTS_YAML, "the replace target did not match")
        result = self._run(agents=text)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        for role in (
            "architecture-authority",
            "business-authority",
            "repository-administrator",
            "legal-compliance-reviewer",
        ):
            self.assertIn(role, result.stderr)

    def test_deleting_a_human_only_role_is_reported(self):
        """Deleting the row is another way to stop a seat being human-only."""
        text = AGENTS_YAML.replace(
            "\n  - id: legal-compliance-reviewer\n"
            '    owns: ["fixture"]\n'
            "    may_be_an_agent: false\n"
            "    held_by: null\n",
            "\n",
        )
        self.assertNotEqual(text, AGENTS_YAML, "the replace target did not match")
        self._refused("legal-compliance-reviewer", agents=text)

    def test_a_missing_held_by_field_is_reported(self):
        text = AGENTS_YAML.replace(
            "  - id: platform-engineer\n"
            '    owns: ["fixture"]\n'
            "    may_be_an_agent: true\n"
            "    held_by: null",
            "  - id: platform-engineer\n"
            '    owns: ["fixture"]\n'
            "    may_be_an_agent: true",
        )
        self.assertNotEqual(text, AGENTS_YAML, "the replace target did not match")
        self._refused("held_by", agents=text)

    def test_a_non_boolean_may_be_an_agent_is_reported(self):
        text = AGENTS_YAML.replace(
            "    may_be_an_agent: true\n    held_by: null\n\n  - id: repository-administrator",
            "    may_be_an_agent: PROBABLY\n    held_by: null\n\n  - id: repository-administrator",
        )
        self.assertNotEqual(text, AGENTS_YAML, "the replace target did not match")
        self._refused("PROBABLY", agents=text)


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
