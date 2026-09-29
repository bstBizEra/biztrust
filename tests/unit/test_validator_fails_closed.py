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
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VALIDATOR = ROOT / "scripts" / "validate_continuity.py"

#: A newline, named. The signing-policy fixtures below edit YAML by string
#: replacement, and a literal escape inside those calls is one more thing that
#: has to survive being read, copied and re-quoted correctly.
NL = chr(10)

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
    "bootstrap": {
        "record": "badf/bootstrap.yaml",
        "state": "AWAITING_OPERATOR_INSTRUCTION",
        "act_id": "BOOTSTRAP-001",
        "seats": [],
        "historical_digest": None,
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
REGISTRIES = (
    "lifecycle.yaml",
    "authority.yaml",
    "gates.yaml",
    "agents.yaml",
    "skills.yaml",
    "signing-policy.yaml",
    "bootstrap.yaml",
)

#: A minimal but STRUCTURALLY REAL authority registry.
#:
#: The other four registries can be stubs. This one cannot: it is the source of
#: record for what is granted, and it is cross-checked against the state file,
#: so it has to carry the same keys the state file asserts. Hardening only the
#: state file left this one checked for nothing but a version line, and a
#: review appended a forged section to it and got a pass.
#: What an agent may and may not do, copied VERBATIM from badf/authority.yaml
#: and deliberately not imported from the validator: a fixture that took the
#: pinned list from the code under test would prove the list equals itself.
TOOL_MAY = (
    "Read every file",
    "Run the validators, the lint, the boundary check and the test suite",
    "Open a branch and a pull request under a Work Package",
    "Append to badf/decision-log.jsonl",
    "Write a session checkpoint",
)
TOOL_MAY_NOT = (
    "Push to main",
    "Record a gate result",
    "Mark a design or an ADR ACCEPTED",
    "Grant, extend or infer authority, including its own",
    "Create a domain table or implement a P0 epic",
    "Claim that any capability is implemented, secure, compliant or production-ready",
    "Place a secret, a credential, client data or regulated data in this repository",
)


def tool_authority_yaml(may=TOOL_MAY, may_not=TOOL_MAY_NOT) -> str:
    """A tool_authority block with the given lists."""
    text = "tool_authority:" + NL + "  may:" + NL
    for item in may:
        text += "    - " + chr(34) + item + chr(34) + NL
    text += "  may_not:" + NL
    for item in may_not:
        text += "    - " + chr(34) + item + chr(34) + NL
    return text


#: The block sits BEFORE not_granted in the fixture, unlike the shipped file.
#: Several tests below append text to the end of AUTHORITY_YAML expecting to
#: land inside `granted`, so the last section has to stay `granted`.
AUTHORITY_YAML = """version: "0.1.0"
updated_at: "2026-01-01T00:00:00Z"

""" + tool_authority_yaml() + """
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

#: A capability registry carrying the COMPLETE roster PINNED_SKILL_STATUS
#: pins in scripts/validate_continuity.py, at the status each is pinned at.
#:
#: It carries every id, not a representative sample, because round four
#: finding I8 made the check two-way: every pinned id must be recorded at or
#: above its pin, AND every recorded id must be pinned. A fixture missing an
#: id would fail the first half; one carrying an extra would fail the second -
#: which is exactly the property under test, and the reason the roster and
#: this fixture move together in one reviewed change.
SKILLS_YAML = """version: "0.1.0"

skills:
  - id: read-records
    what: "fixture"
    authority_required: none
    status: AVAILABLE

  - id: run-validators
    what: "fixture"
    authority_required: none
    status: AVAILABLE

  - id: write-a-checkpoint
    what: "fixture"
    authority_required: none
    status: AVAILABLE

  - id: append-a-decision
    what: "fixture"
    authority_required: none
    status: AVAILABLE

  - id: register-a-module
    what: "fixture"
    authority_required: "architecture-authority, through a Work Package"
    status: BLOCKED

  - id: create-a-module-package
    what: "fixture"
    authority_required: "an expiring implementation grant"
    status: BLOCKED

  - id: write-a-migration
    what: "fixture"
    authority_required: "an expiring implementation grant, plus ADR-004 ACCEPTED"
    status: BLOCKED

  - id: implement-a-contract
    what: "fixture"
    authority_required: "an expiring implementation grant for that epic"
    status: BLOCKED

  - id: record-a-gate
    what: "fixture"
    authority_required: "the human role the gate names"
    status: FORBIDDEN_TO_AGENTS

  - id: grant-authority
    what: "fixture"
    authority_required: "business-authority or repository-administrator"
    status: FORBIDDEN_TO_AGENTS

  - id: deploy
    what: "fixture"
    authority_required: "repository-administrator and business-authority"
    status: FORBIDDEN_TO_AGENTS

  - id: enroll-a-signing-key
    what: "fixture"
    authority_required: "repository-administrator, holding the key material"
    status: FORBIDDEN_TO_AGENTS
"""

#: The two sentences of the succession rule, pinned in
#: scripts/validate_continuity.py (SUCCESSION_PINS) and written into the
#: fixture below from the same constants, so a test that deletes one deletes
#: exactly the sentence the validator pins and not an approximation of it.
SUCCESSION_FIRST_FILL = (
    "  The first fill of a seat whose may_be_an_agent is false is verified by a"
    + NL
    + "  different seat whose may_be_an_agent is false."
    + NL
)
SUCCESSION_SUBSEQUENT = (
    "  Every subsequent change to that seat's occupancy is verified normally by the"
    + NL
    + "  routing table above."
    + NL
)

#: A minimal but STRUCTURALLY REAL role registry. Task 6: badf/agents.yaml had
#: no field capable of recording who holds a seat, and may_be_an_agent could be
#: flipped to true on all four human-only seats with nothing objecting. This
#: carries all four, each false with held_by: null (pinned to the literal
#: null, not merely present), plus the agent-eligible roles the routing block
#: names and every routing entry PINNED_ROUTING pins, so every pin has
#: something to bind to. The "modules/**" owner is prose on purpose: it is the
#: one routing value that names no fixed seat, and round four finding I7's
#: role-shape check must leave it alone.
AGENTS_YAML = """version: "0.1.0"

roles:
  - id: platform-engineer
    owns: ["fixture"]
    may_be_an_agent: true
    held_by: null

  - id: peer-reviewer
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
    owner: "the owner_role of the module in modules/modules.yaml"
    verifier: peer-reviewer
  - path: "badf/authority.yaml"
    owner: business-authority
    verifier: repository-administrator
  - path: "badf/gates.yaml"
    owner: architecture-authority
    verifier: repository-administrator
  - path: "badf/agents.yaml"
    owner: architecture-authority
    verifier: repository-administrator
  - path: "badf/skills.yaml"
    owner: architecture-authority
    verifier: repository-administrator
  - path: "badf/signing-policy.yaml"
    owner: repository-administrator
    verifier: architecture-authority
  - path: "badf/bootstrap.yaml"
    owner: architecture-authority
    verifier: legal-compliance-reviewer

succession: >-
  How the FIRST occupant of a human-only seat is seated, as a rule of this
  file and not as an exception to it.

""" + SUCCESSION_FIRST_FILL + """
""" + SUCCESSION_SUBSEQUENT + """
  The rule is deterministic: the next vacancy in a human-only seat needs no
  further operator instruction.
"""


#: A FICTIONAL human, and the only place in this repository where a name
#: appears in a seat at all. It is written into a temporary directory, never
#: into badf/agents.yaml, whose every held_by is the literal null: seating a
#: human is an operator's act, and an agent that wrote one here would be
#: rehearsing the forgery the whole record exists to refuse.
PRINCIPAL = "A Fixture Human <fixture@example.invalid>"
OTHER_PRINCIPAL = "Another Fixture Human <other@example.invalid>"

ADMIN_SEAT = ("repository-administrator", PRINCIPAL)
BUSINESS_SEAT = ("business-authority", PRINCIPAL)
OTHER_BUSINESS_SEAT = ("business-authority", OTHER_PRINCIPAL)


def bootstrap_record(
    *,
    state="AWAITING_OPERATOR_INSTRUCTION",
    act_id="BOOTSTRAP-001",
    seatings=(("repository-administrator", None),),
    dual="false",
    exception="null",
    expiry="null",
    trigger="null",
) -> str:
    """A minimal but STRUCTURALLY REAL bootstrap record.

    A stub would leave this file checked for a version line only, which is the
    state authority.yaml, gates.yaml, skills.yaml and agents.yaml were each
    found in by a later review. It carries the frozen-region markers, the
    pinned literals and the establishment statement verbatim, because every
    one of those is a rule and a fixture that omits one exercises nothing.

    The DEFAULT is the shipped shape: awaiting an operator, principal null.
    """
    entries = ""
    for seat, principal in seatings:
        who = "null" if principal is None else chr(34) + principal + chr(34)
        entries += "  - seat: " + seat + NL + "    principal: " + who + NL
    return (
        'version: "0.1.0"' + NL
        + 'updated_at: "2026-01-01T00:00:00Z"' + NL
        + NL
        + "# ---- BEGIN HISTORICAL RECORD ----" + NL
        + "act_id: " + act_id + NL
        + "state: " + state + NL
        + "established_by: OPERATOR_INSTRUCTION_ADOPTING_THE_SUCCESSION_RULE" + NL
        + "standing_authority_path: false" + NL
        + "instruction_date: null" + NL
        + "instruction_origin: null" + NL
        + "temporary_dual_seat: " + dual + NL
        + "exception_type: " + exception + NL
        + "expiry: " + expiry + NL
        + "separation_trigger: " + trigger + NL
        + "establishment_statement: >-" + NL
        + "  THE OPERATOR INSTRUCTION RECORDED HERE IS THE MECHANISM THAT ADOPTED THE" + NL
        + "  SUCCESSION RULE IN badf/agents.yaml. IT IS NOT A STANDING ALTERNATIVE" + NL
        + "  AUTHORITY PATH, AND IT IS SPENT BY ITS OWN USE." + NL
        + "seatings:" + NL
        + entries
        + "# ---- END HISTORICAL RECORD ----" + NL
    )


BOOTSTRAP_YAML = bootstrap_record()


def digest_of(record: str) -> str:
    """The sha256 of the frozen region, computed INDEPENDENTLY of the validator.

    Three lines, written out here rather than imported, so that a fixture
    proving a seating valid is not proving it valid by asking the code under
    test what the answer should be.
    """
    lines = record.replace(chr(13) + NL, NL).split(NL)
    start = lines.index("# ---- BEGIN HISTORICAL RECORD ----")
    end = lines.index("# ---- END HISTORICAL RECORD ----")
    return hashlib.sha256(NL.join(lines[start + 1:end]).encode("utf-8")).hexdigest()


def agents_seated(*pairs, human_only=True) -> str:
    """badf/agents.yaml with held_by filled in for each (seat, principal)."""
    text = AGENTS_YAML
    flag = "false" if human_only else "true"
    for seat, principal in pairs:
        old = (
            "  - id: " + seat + NL
            + '    owns: ["fixture"]' + NL
            + "    may_be_an_agent: " + flag + NL
            + "    held_by: null" + NL
        )
        assert old in text, "no such seat in the agents fixture: " + seat
        text = text.replace(
            old, old.replace("held_by: null", 'held_by: "' + principal + '"'), 1
        )
    return text


def state_for(record: str, *, seats=()) -> dict:
    """badf/current-state.json's consumption ledger for a given record."""
    is_seated = (NL + "state: SEATED" + NL) in record
    act = re.search(r"^act_id: (\S+)$", record, re.MULTILINE)
    state = copy.deepcopy(STATE)
    state["bootstrap"] = {
        "record": "badf/bootstrap.yaml",
        "state": "SEATED" if is_seated else "AWAITING_OPERATOR_INSTRUCTION",
        "act_id": act.group(1) if act else "BOOTSTRAP-001",
        "seats": list(seats),
        "historical_digest": digest_of(record) if is_seated else None,
    }
    return state


#: A minimal but STRUCTURALLY REAL signature policy.
#:
#: A stub would leave it checked for a version line only, which is exactly the
#: state authority.yaml, gates.yaml, skills.yaml and agents.yaml were each
#: found in by a later review. It has to carry every path pinned in
#: PINNED_PROTECTED_PATHS, because that pin is a FLOOR: a policy missing one is
#: a governance record no signature is ever required for.
#:
#: accepted_keys is NONE_ENROLLED here for the same reason it is in the real
#: file - enrolling a key is a human act, and a fixture that enrolled one would
#: be a fixture asserting something no agent may bring about.
SIGNING_POLICY_YAML = """version: "0.1.0"
updated_at: "2026-01-01T00:00:00Z"
enforcement_point: FIRST_COMMIT_OF_THIS_POLICY

protected_paths:
  - badf/authority.yaml
  - badf/gates.yaml
  - badf/current-state.json
  - badf/lifecycle.yaml
  - badf/agents.yaml
  - badf/bootstrap.yaml
  - badf/skills.yaml
  - badf/signing-policy.yaml
  - sessions/checkpoints

accepted_keys: NONE_ENROLLED
"""

#: The same policy with one key enrolled, for the three rules that can only be
#: exercised once accepted_keys is a block. It is a FIXTURE, and the identity
#: in it is not a key: no agent may enrol one, and this file materialises a
#: temporary directory, never this repository.
SIGNING_POLICY_WITH_KEY = SIGNING_POLICY_YAML.replace(
    "accepted_keys: NONE_ENROLLED\n",
    "accepted_keys:\n"
    '  - identity: "A Human <human@example.invalid>"\n'
    "    kind: gpg\n"
    "    enrolled_by: repository-administrator\n",
)


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
            "signing-policy.yaml": SIGNING_POLICY_YAML,
            "bootstrap.yaml": BOOTSTRAP_YAML,
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


BOOTSTRAP_PIN_NAMES = ("ACT", "STATE", "SEATS", "DIGEST")


def bootstrap_pins_for(record: str, seats=("repository-administrator",)) -> dict:
    """The four bootstrap pins a validator would carry for THIS spent act."""
    is_seated = (NL + "state: SEATED" + NL) in record
    act = re.search(r"^act_id: (\S+)$", record, re.MULTILINE)
    return {
        "ACT": act.group(1) if act else "BOOTSTRAP-001",
        "STATE": "SEATED" if is_seated else "AWAITING_OPERATOR_INSTRUCTION",
        "SEATS": list(seats),
        "DIGEST": digest_of(record) if is_seated else None,
    }


def _pins_following_the_fixture(tmp: Path) -> dict | None:
    """Pins that simply agree with whatever bootstrap fixture is on disk.

    The bootstrap pins in scripts/validate_continuity.py name ONE real act. The
    older tests here exercise the record's other rules against many invented
    acts, and would otherwise all trip the pin. So the copy of the validator
    they run has its pins set to what the fixture itself records, which makes
    the pin trivially satisfied there. Tests of the pin itself pass explicit
    pins instead (see BootstrapIsSingleUse), and never rely on this.
    """
    try:
        record = (tmp / "badf" / "bootstrap.yaml").read_text(encoding="utf-8")
        ledger = json.loads((tmp / "badf" / "current-state.json").read_text(encoding="utf-8"))
        seats = ledger["bootstrap"]["seats"]
        digest = ledger["bootstrap"]["historical_digest"]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    pins = bootstrap_pins_for(record, seats if isinstance(seats, list) else [])
    pins["DIGEST"] = digest
    return pins


def patch_bootstrap_pins(tmp: Path, pins: dict) -> None:
    """Rewrites the four single-line pin constants in the temporary copy."""
    path = tmp / "scripts" / "validate_continuity.py"
    text = path.read_text(encoding="utf-8")
    for name in BOOTSTRAP_PIN_NAMES:
        pattern = re.compile(r"^BOOTSTRAP_PINNED_" + name + r" = .*$", re.MULTILINE)
        assert len(pattern.findall(text)) == 1, (
            "the validator must define BOOTSTRAP_PINNED_" + name + " exactly once, on one line"
        )
        replacement = "BOOTSTRAP_PINNED_" + name + " = " + repr(pins[name])
        text = pattern.sub(lambda _match: replacement, text)
    path.write_text(text, encoding="utf-8")


def run(tmp: Path, pins: dict | None = None) -> subprocess.CompletedProcess:
    pins = _pins_following_the_fixture(tmp) if pins is None else pins
    if pins is not None:
        patch_bootstrap_pins(tmp, pins)
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

    # ---- a grant written into the registry ALONE ---------------------------
    #
    # Review finding M2. `badf/authority.yaml` is the source of record, so a
    # grant written there while badf/current-state.json still reads NOT_* is
    # the cheapest P0 forgery there is: one file. Exactly one rule stops it,
    # and deleting that rule left every test green.

    def test_a_registry_grant_the_state_file_still_reads_as_withheld_is_reported(self):
        text = AUTHORITY_YAML.replace(
            "  p0_implementation:\n    status: NOT_GRANTED\n", ""
        ) + (
            "  p0_implementation:\n"
            "    status: GRANTED\n"
            '    granted_by: "business authority seat"\n'
            '    recorded_by: "business-authority"\n'
            '    expires_at: "2099-01-01"\n'
        )
        with tempfile.TemporaryDirectory() as directory:
            tmp = build(Path(directory))
            (tmp / "badf" / "authority.yaml").write_text(text, encoding="utf-8")
            result = run(tmp)
        self.assertEqual(
            result.returncode, 1,
            f"a P0 grant in the registry alone must be refused:\n{result.stdout}{result.stderr}",
        )
        self.assertIn(
            "authority.p0_implementation: badf/authority.yaml records it under granted "
            "but badf/current-state.json says 'NOT_GRANTED'",
            result.stderr,
        )

    # ---- tool_authority: what an agent may NOT do is pinned ----------------
    #
    # Review finding M1. The block was never read: list items under it were
    # skipped, so moving "Grant, extend or infer authority, including its own"
    # from may_not into may passed, with one file edited.

    def _with_tool_authority(self, may=TOOL_MAY, may_not=TOOL_MAY_NOT):
        text = AUTHORITY_YAML.replace(
            tool_authority_yaml(), tool_authority_yaml(may, may_not)
        )
        with tempfile.TemporaryDirectory() as directory:
            tmp = build(Path(directory))
            (tmp / "badf" / "authority.yaml").write_text(text, encoding="utf-8")
            return run(tmp)

    def test_the_tool_authority_fixture_passes(self):
        result = self._with_tool_authority()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_a_forbidden_tool_power_moved_into_may_is_reported(self):
        item = "Grant, extend or infer authority, including its own"
        result = self._with_tool_authority(
            may=TOOL_MAY + (item,),
            may_not=tuple(entry for entry in TOOL_MAY_NOT if entry != item),
        )
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(item, result.stderr)

    def test_a_pinned_tool_power_missing_from_may_not_is_reported(self):
        for item in TOOL_MAY_NOT:
            with self.subTest(item=item):
                result = self._with_tool_authority(
                    may_not=tuple(entry for entry in TOOL_MAY_NOT if entry != item)
                )
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn(
                    "tool_authority.may_not no longer lists " + repr(item), result.stderr
                )

    def test_a_pinned_tool_power_listed_under_may_is_reported(self):
        for item in TOOL_MAY_NOT:
            with self.subTest(item=item):
                # Still present under may_not: only the may-side rule can fire.
                result = self._with_tool_authority(may=TOOL_MAY + (item,))
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn(
                    "tool_authority.may lists " + repr(item), result.stderr
                )

    def test_a_pinned_tool_power_under_may_with_other_case_is_reported(self):
        result = self._with_tool_authority(may=TOOL_MAY + ("  PUSH  to   MAIN ",))
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("tool_authority.may lists", result.stderr)

    def test_a_registry_with_no_tool_authority_block_is_reported(self):
        text = AUTHORITY_YAML.replace(tool_authority_yaml(), "")
        self.assertNotEqual(text, AUTHORITY_YAML)
        with tempfile.TemporaryDirectory() as directory:
            tmp = build(Path(directory))
            (tmp / "badf" / "authority.yaml").write_text(text, encoding="utf-8")
            result = run(tmp)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("tool_authority.may_not no longer lists", result.stderr)

    def test_a_forbidden_tool_power_added_beyond_the_pinned_ones_is_allowed(self):
        """The pin is a floor. Forbidding MORE is never a loosening."""
        result = self._with_tool_authority(
            may_not=TOOL_MAY_NOT + ("Deploy to any environment",)
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

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
            "    status: AVAILABLE\n\n  - id: run-validators",
            "    status: PROBABLY_FINE\n\n  - id: run-validators",
        )
        self.assertNotEqual(text, SKILLS_YAML, "the replace target did not match")
        self._refused("PROBABLY_FINE", skills=text)

    def test_making_a_third_forbidden_skill_available_is_reported(self):
        """The floor is not just the two skills review round one named.

        A prior version of FORBIDDEN_TO_AGENTS_SKILLS named only
        record-a-gate and grant-authority, populated by recognising a
        pattern rather than by reading badf/skills.yaml end to end. `deploy`
        - "repository-administrator and business-authority", the same
        severity - was missed, and flipping it to AVAILABLE passed. This is
        the third skill, not one of the two originally named, proving the
        floor is now derived from the whole file rather than curated by eye.
        """
        text = SKILLS_YAML.replace(
            "  - id: deploy\n"
            '    what: "fixture"\n'
            '    authority_required: "repository-administrator and '
            'business-authority"\n'
            "    status: FORBIDDEN_TO_AGENTS",
            "  - id: deploy\n"
            '    what: "fixture"\n'
            '    authority_required: "repository-administrator and '
            'business-authority"\n'
            "    status: AVAILABLE",
        )
        self.assertNotEqual(text, SKILLS_YAML, "the replace target did not match")
        self._refused("deploy", skills=text)

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

    def test_a_named_occupant_in_held_by_is_reported(self):
        """The exact forgery a coordinator review confirmed empirically:
        writing a name into held_by on a human-only seat, honestly or not,
        still passes if held_by is checked only for presence. held_by is
        pinned to the literal null; only a reviewed change to
        validate_agents_registry may let a seat carry anything else.
        """
        text = AGENTS_YAML.replace(
            "  - id: architecture-authority\n"
            '    owns: ["fixture"]\n'
            "    may_be_an_agent: false\n"
            "    held_by: null",
            "  - id: architecture-authority\n"
            '    owns: ["fixture"]\n'
            "    may_be_an_agent: false\n"
            '    held_by: "Agent-Claude-Session-1"',
        )
        self.assertNotEqual(text, AGENTS_YAML, "the replace target did not match")
        self._refused("architecture-authority", agents=text)

    def test_a_quoted_null_in_held_by_is_accepted(self):
        """held_by: "null" (a quoted string) is semantically the same null
        this pin requires, not a forgery, and must not be refused.
        """
        text = AGENTS_YAML.replace(
            "  - id: platform-engineer\n"
            '    owns: ["fixture"]\n'
            "    may_be_an_agent: true\n"
            "    held_by: null",
            "  - id: platform-engineer\n"
            '    owns: ["fixture"]\n'
            "    may_be_an_agent: true\n"
            '    held_by: "null"',
        )
        self.assertNotEqual(text, AGENTS_YAML, "the replace target did not match")
        result = self._run(agents=text)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    # ---- round four finding I8: the skills registry could still be widened

    def test_making_a_blocked_skill_available_is_reported(self):
        """The floor was three FORBIDDEN_TO_AGENTS ids and nothing else, so
        `write-a-migration: BLOCKED -> AVAILABLE` passed - leaving the entry's
        own `why:` text ("ADR-004 is DRAFT_REQUIRED and BT-G0 is unrecorded")
        standing in flat contradiction of its own status.
        """
        text = SKILLS_YAML.replace(
            "  - id: write-a-migration\n"
            '    what: "fixture"\n'
            '    authority_required: "an expiring implementation grant, plus '
            'ADR-004 ACCEPTED"\n'
            "    status: BLOCKED",
            "  - id: write-a-migration\n"
            '    what: "fixture"\n'
            '    authority_required: "an expiring implementation grant, plus '
            'ADR-004 ACCEPTED"\n'
            "    status: AVAILABLE",
        )
        self.assertNotEqual(text, SKILLS_YAML, "the replace target did not match")
        self._refused("write-a-migration", skills=text)

    def test_appending_a_new_available_skill_is_reported(self):
        """A capability registry an agent can grow by one entry is not a
        governed one. Appending an AVAILABLE skill passed: the pin was a
        floor over three named ids, and a new id was simply outside it.
        """
        text = SKILLS_YAML + (
            "\n  - id: do-whatever-is-needed\n"
            '    what: "fixture"\n'
            "    authority_required: none\n"
            "    status: AVAILABLE\n"
        )
        self._refused("do-whatever-is-needed", skills=text)

    def test_a_forbidden_skill_the_validator_does_not_pin_is_reported(self):
        """The superset half, and the reason this is not merely a floor.

        A skill the FILE marks FORBIDDEN_TO_AGENTS but the validator pins
        nowhere is unprotected: the next edit can widen it with nothing
        objecting. Renaming an id is the cheapest way to produce exactly that
        state, and it must be refused for the NEW id specifically, not only
        because the old one went missing.
        """
        text = SKILLS_YAML.replace("  - id: deploy\n", "  - id: deploy-anywhere\n")
        self.assertNotEqual(text, SKILLS_YAML, "the replace target did not match")
        result = self._run(skills=text)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("deploy-anywhere", result.stderr)
        self.assertIn("pinned nowhere", result.stderr)

    def test_widening_a_forbidden_skill_to_blocked_is_reported(self):
        """FORBIDDEN_TO_AGENTS -> BLOCKED is still a widening: BLOCKED says
        "an agent may do this once the authority exists", and AGENTS.md
        section 4 says an agent may never record a gate at all.
        """
        text = SKILLS_YAML.replace(
            "  - id: record-a-gate\n"
            '    what: "fixture"\n'
            '    authority_required: "the human role the gate names"\n'
            "    status: FORBIDDEN_TO_AGENTS",
            "  - id: record-a-gate\n"
            '    what: "fixture"\n'
            '    authority_required: "the human role the gate names"\n'
            "    status: BLOCKED",
        )
        self.assertNotEqual(text, SKILLS_YAML, "the replace target did not match")
        self._refused("record-a-gate", skills=text)

    # ---- round four finding I7: the routing block generates CODEOWNERS -----

    def test_rerouting_a_governance_path_to_agent_occupiable_seats_is_reported(self):
        """The finding verbatim, and the reason the pin exists.

        badf/authority.yaml routed to platform-engineer / peer-reviewer - both
        may_be_an_agent: true - passed BOTH `validate:records` and
        `codeowners:check`, and generated a CODEOWNERS naming two seats an
        agent may occupy as the reviewers of the file AGENTS.md section 4 says
        an agent may read and may never widen.
        """
        text = AGENTS_YAML.replace(
            '  - path: "badf/authority.yaml"\n'
            "    owner: business-authority\n"
            "    verifier: repository-administrator",
            '  - path: "badf/authority.yaml"\n'
            "    owner: platform-engineer\n"
            "    verifier: peer-reviewer",
        )
        self.assertNotEqual(text, AGENTS_YAML, "the replace target did not match")
        self._refused("badf/authority.yaml", agents=text)

    def test_deleting_a_governance_routing_entry_is_reported(self):
        """Deleting the entry is the other way to stop a path having a
        required reviewer: CODEOWNERS then names nobody for it, and the
        generated file is, correctly, current.
        """
        text = AGENTS_YAML.replace(
            '  - path: "badf/authority.yaml"\n'
            "    owner: business-authority\n"
            "    verifier: repository-administrator\n",
            "",
        )
        self.assertNotEqual(text, AGENTS_YAML, "the replace target did not match")
        self._refused("badf/authority.yaml", agents=text)

    def test_deleting_the_skills_registry_routing_entry_is_reported(self):
        """badf/skills.yaml and badf/agents.yaml had no routing entry at all
        before this round: the registry of what an agent may do, and the
        registry of who may hold a seat, routed to nobody.
        """
        text = AGENTS_YAML.replace(
            '  - path: "badf/skills.yaml"\n'
            "    owner: architecture-authority\n"
            "    verifier: repository-administrator\n",
            "",
        )
        self.assertNotEqual(text, AGENTS_YAML, "the replace target did not match")
        self._refused("badf/skills.yaml", agents=text)

    def test_a_routing_verifier_naming_no_declared_role_is_reported(self):
        """owner and verifier were checked for PRESENCE only, so a routing
        entry could name a seat that does not exist. The generator emits a
        CODEOWNERS line only for a value that IS a declared role, so such an
        entry leaves the path unreviewed while reading as though it were
        routed.
        """
        text = AGENTS_YAML.replace(
            '  - path: "modules/**"\n'
            '    owner: "the owner_role of the module in modules/modules.yaml"\n'
            "    verifier: peer-reviewer",
            '  - path: "modules/**"\n'
            '    owner: "the owner_role of the module in modules/modules.yaml"\n'
            "    verifier: peer-revewier",
        )
        self.assertNotEqual(text, AGENTS_YAML, "the replace target did not match")
        self._refused("peer-revewier", agents=text)

    def test_a_prose_owner_that_names_no_fixed_seat_is_accepted(self):
        """The one routing value that genuinely names no seat - it varies per
        module - must NOT be refused by the role-shape check above, or the
        pins become the only thing standing and the check fails the real
        repository.
        """
        result = self._run(agents=AGENTS_YAML)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    # ---- round four finding I6: six refusals witnessed by nothing ---------
    #
    # Each of the six below could be neutered - the loop emptied, the guard
    # turned off - and `pnpm test:validator` stayed green at 64 tests. They are
    # the load-bearing half of the "refuses every line it cannot classify"
    # doctrine both readers of these registries state at length: a parser that
    # silently SKIPS a line it does not recognise is how a forged grant walked
    # past three registries that checked for a version: line and nothing else.

    def test_a_routing_entry_with_no_verifier_is_reported(self):
        """The routing presence loop. An entry with no verifier generates a
        CODEOWNERS line naming one seat where the design names two, and the
        path is half-reviewed with nothing saying so. Uses the UNPINNED
        "modules/**" entry on purpose: a pinned governance path would be
        refused by PINNED_ROUTING instead, and this test would then pass
        without the loop it exists to witness.
        """
        text = AGENTS_YAML.replace(
            '  - path: "modules/**"\n'
            '    owner: "the owner_role of the module in modules/modules.yaml"\n'
            "    verifier: peer-reviewer\n",
            '  - path: "modules/**"\n'
            '    owner: "the owner_role of the module in modules/modules.yaml"\n',
        )
        self.assertNotEqual(text, AGENTS_YAML, "the replace target did not match")
        self._refused("records no verifier", agents=text)

    def test_a_skills_registry_with_no_skill_is_reported(self):
        """An empty registry is not a registry with nothing forbidden; it is a
        registry that says nothing, which a caller reads as permission.
        """
        self._refused("no skill is recorded", skills='version: "0.1.0"\n\nskills:\n')

    def test_an_agents_registry_with_no_role_is_reported(self):
        """Same shape, the other file: no seats recorded at all."""
        text = AGENTS_YAML[: AGENTS_YAML.index("  - id: platform-engineer")]
        text += AGENTS_YAML[AGENTS_YAML.index("routing:") :]
        self._refused("no role is recorded", agents=text)

    def test_an_unknown_field_on_a_skill_is_reported(self):
        """parse_skills refuses every line it cannot classify. Without this,
        a field the reader does not model is silently dropped - which is how
        `status:` itself could be renamed to something the reader ignores
        while a human reading the file sees a status.
        """
        text = SKILLS_YAML.replace(
            "  - id: read-records\n",
            "  - id: read-records\n    granted: yes\n",
        )
        self.assertNotEqual(text, SKILLS_YAML, "the replace target did not match")
        self._refused("unknown field 'granted'", skills=text)

    def test_an_unknown_field_on_a_role_is_reported(self):
        text = AGENTS_YAML.replace(
            "  - id: platform-engineer\n",
            "  - id: platform-engineer\n    occupied_by: someone\n",
        )
        self.assertNotEqual(text, AGENTS_YAML, "the replace target did not match")
        self._refused("unknown field 'occupied_by'", agents=text)

    def test_an_unknown_field_on_a_routing_entry_is_reported(self):
        text = AGENTS_YAML.replace(
            '  - path: "badf/gates.yaml"\n',
            '  - path: "badf/gates.yaml"\n    approver: platform-engineer\n',
        )
        self.assertNotEqual(text, AGENTS_YAML, "the replace target did not match")
        self._refused("unknown field 'approver'", agents=text)

    def test_a_non_boolean_may_be_an_agent_is_reported(self):
        text = AGENTS_YAML.replace(
            "    may_be_an_agent: true\n    held_by: null\n\n  - id: repository-administrator",
            "    may_be_an_agent: PROBABLY\n    held_by: null\n\n  - id: repository-administrator",
        )
        self.assertNotEqual(text, AGENTS_YAML, "the replace target did not match")
        self._refused("PROBABLY", agents=text)


class SigningPolicyClosed(unittest.TestCase):
    """badf/signing-policy.yaml: the record that says WHO must have written a
    governance record, rather than what it may say.

    Every other class in this file breaks a record and requires the break to be
    reported. This one breaks the record that decides which records need a
    human signature at all - and it needs a class of its own because a defect
    here is invisible in exactly the way the other classes exist to refuse. A
    policy that quietly stops protecting badf/authority.yaml still parses,
    still declares a version, and still makes scripts/check-signing.mjs print a
    status line. It simply asks git about nothing.

    NOTHING HERE ENROLS A KEY IN THIS REPOSITORY. Every fixture is written into
    a temporary directory. The one that enrols an identity enrols a fictional
    one, into a copy, to exercise three rules that cannot fire at all while
    accepted_keys says NONE_ENROLLED.
    """

    def _run(self, policy):
        with tempfile.TemporaryDirectory() as directory:
            tmp = build(Path(directory))
            (tmp / "badf" / "signing-policy.yaml").write_text(policy, encoding="utf-8")
            return run(tmp)

    def _refused(self, needle, policy):
        result = self._run(policy)
        self.assertEqual(
            result.returncode, 1,
            f"this policy defect must be refused:{NL}{result.stdout}{result.stderr}",
        )
        self.assertIn(needle, result.stderr)

    # ---- the baselines must pass, or every test below is meaningless -------

    def test_the_signing_policy_fixture_passes(self):
        result = self._run(SIGNING_POLICY_YAML)
        self.assertEqual(
            result.returncode, 0,
            f"the signing policy baseline must pass:{NL}{result.stdout}{result.stderr}",
        )

    def test_the_signing_policy_fixture_with_an_enrolled_key_passes(self):
        result = self._run(SIGNING_POLICY_WITH_KEY)
        self.assertEqual(
            result.returncode, 0,
            f"a well-formed enrolled key must pass, or the three rules below prove "
            f"nothing:{NL}{result.stdout}{result.stderr}",
        )

    # ---- the reader: the default is an error -------------------------------

    def test_a_line_the_signing_policy_grammar_cannot_classify_is_reported(self):
        # Three spaces. Not a section, not an entry, not a field - and the
        # reader this one is written after would have SKIPPED it, which is how
        # a tab-indented block became invisible in badf/authority.yaml.
        self._refused(
            "matches no rule of this policy's grammar",
            SIGNING_POLICY_YAML.replace("  - badf/gates.yaml", "   - badf/gates.yaml", 1),
        )

    def test_an_unknown_top_level_key_in_the_signing_policy_is_reported(self):
        self._refused(
            "unknown top-level key",
            SIGNING_POLICY_YAML.replace(
                "protected_paths:",
                "signatures_required: false" + NL + NL + "protected_paths:",
                1,
            ),
        )

    def test_an_unknown_field_on_an_accepted_key_is_reported(self):
        self._refused(
            "unknown field",
            SIGNING_POLICY_WITH_KEY.replace(
                "    kind: gpg", "    kind: gpg" + NL + "    trusted: true", 1
            ),
        )

    # ---- the policy's shape ------------------------------------------------

    def test_an_enforcement_point_that_is_neither_a_sha_nor_the_literal_is_reported(self):
        self._refused(
            "neither the literal FIRST_COMMIT_OF_THIS_POLICY",
            SIGNING_POLICY_YAML.replace(
                "enforcement_point: FIRST_COMMIT_OF_THIS_POLICY",
                "enforcement_point: HEAD",
                1,
            ),
        )

    def test_dropping_a_pinned_protected_path_is_reported(self):
        # The forgery this task is about, in one deleted line:
        # badf/authority.yaml stops being a path a signature is ever required
        # for, and every other check in this repository stays green.
        self._refused(
            "is pinned in scripts/validate_continuity.py (PINNED_PROTECTED_PATHS)",
            SIGNING_POLICY_YAML.replace("  - badf/authority.yaml" + NL, "", 1),
        )

    def test_a_protected_path_git_would_read_as_an_option_is_reported(self):
        self._refused(
            "is not a plain relative path",
            SIGNING_POLICY_YAML.replace(
                "  - sessions/checkpoints", "  - sessions/checkpoints" + NL + "  - --all", 1
            ),
        )

    # ---- accepted_keys says exactly one thing: FOUR branches, four controls --
    #
    # One control used to cover all four, and the single mutation on the
    # aggregation (`if said is not None:`) was caught by it, so the sweep
    # printed a full house while three of the four branches were invisible.
    # Deleting the NONE_ENROLLED-and-then-lists-a-key branch left the whole
    # validator suite green - and a policy that says NONE_ENROLLED while
    # listing a live identity then PASSES, so a human greps the word the file
    # documents, reads "nobody is bound", and the signature check is enforcing
    # against an identity nobody enrolled while no longer printing
    # NOT_ENFORCED. That is the sixth instance of this branch's own defect
    # class, and the comment on ACCEPTED_KEY_RULES had already named it twenty
    # lines below the code carrying it.

    def test_a_policy_that_declares_no_accepted_keys_is_reported(self):
        # Not "no key is enrolled", which is the honest current state and
        # passes. This is the file never saying either way, and an unstated
        # answer is read as the convenient one.
        self._refused(
            "does not declare accepted_keys at all",
            SIGNING_POLICY_YAML.replace("accepted_keys: NONE_ENROLLED" + NL, "", 1),
        )

    def test_a_policy_that_says_none_enrolled_and_then_lists_a_key_is_reported(self):
        # SELF-ENROLMENT BEHIND THE WORD THAT MEANS THE OPPOSITE. The JS
        # reader decides enrolment from whether an entry parsed, never from
        # this word, and says so - so with this branch gone the two readers
        # disagree in the direction that matters: the file reads as unbound
        # and the check enforces against whoever wrote it.
        text = SIGNING_POLICY_YAML.replace(
            "accepted_keys: NONE_ENROLLED" + NL,
            "accepted_keys: NONE_ENROLLED" + NL
            + '  - identity: "agent-bot@biztrust.local"' + NL
            + "    kind: ssh" + NL
            + "    enrolled_by: repository-administrator" + NL,
            1,
        )
        self.assertNotEqual(text, SIGNING_POLICY_YAML, "the replace target did not match")
        self._refused("says NONE_ENROLLED and then lists 1 key(s)", text)

    def test_a_policy_that_opens_accepted_keys_and_lists_no_key_is_reported(self):
        # The other half of the same contradiction: a block header with
        # nothing under it. It is not NONE_ENROLLED - so nothing greps it as
        # unenforced - and it enrols nobody, so the check would report
        # NOT_ENFORCED under a file that does not say so.
        text = SIGNING_POLICY_YAML.replace("accepted_keys: NONE_ENROLLED", "accepted_keys:", 1)
        self.assertNotEqual(text, SIGNING_POLICY_YAML, "the replace target did not match")
        self._refused("opens accepted_keys as a block and lists no key in it", text)

    def test_a_policy_that_records_accepted_keys_as_some_other_word_is_reported(self):
        # A third word is the worst of the three, because it reads as an
        # answer. PENDING enrols nobody and announces nothing; the check would
        # print NOT_ENFORCED and a reader of the file would not know whether
        # that was the file's intent or the reader's guess.
        text = SIGNING_POLICY_YAML.replace(
            "accepted_keys: NONE_ENROLLED", "accepted_keys: PENDING", 1
        )
        self.assertNotEqual(text, SIGNING_POLICY_YAML, "the replace target did not match")
        self._refused("records accepted_keys as 'PENDING'", text)

    # ---- the rules on an enrolled key, one per ACCEPTED_KEY_RULES entry -----

    def test_an_accepted_key_with_no_identity_is_reported(self):
        self._refused(
            "records identity as ''",
            SIGNING_POLICY_WITH_KEY.replace(
                '  - identity: "A Human <human@example.invalid>"', '  - identity: ""', 1
            ),
        )

    def test_an_accepted_key_whose_kind_git_cannot_verify_is_reported(self):
        self._refused(
            "records kind as 'x509'",
            SIGNING_POLICY_WITH_KEY.replace("    kind: gpg", "    kind: x509", 1),
        )

    def test_a_key_enrolled_by_a_seat_an_agent_may_occupy_is_reported(self):
        # The self-enrolment forgery. platform-engineer is may_be_an_agent:
        # true, so a key that seat enrolled is a key the signer could also be.
        self._refused(
            "records enrolled_by as 'platform-engineer'",
            SIGNING_POLICY_WITH_KEY.replace(
                "    enrolled_by: repository-administrator",
                "    enrolled_by: platform-engineer",
                1,
            ),
        )

    # ---- review finding M4: the identity that signs every squash merge -----
    #
    # Main is written by GitHub's merge, signed by GitHub's web-flow key. Enrol
    # that key and the check would pass any change merged in the web UI,
    # including an agent-authored one: the signature binds nothing to a human.
    # Those two literals are typed here, not imported from the validator.

    WEB_FLOW_KEY_ID = "B5690EEEBB952194"

    def _enrolled(self, identity):
        return SIGNING_POLICY_WITH_KEY.replace(
            '  - identity: "A Human <human@example.invalid>"',
            '  - identity: "' + identity + '"',
            1,
        )

    def test_enrolling_githubs_web_flow_key_is_reported(self):
        for identity in (
            self.WEB_FLOW_KEY_ID,
            self.WEB_FLOW_KEY_ID.lower(),
            "0x" + self.WEB_FLOW_KEY_ID,
            "F" * 24 + self.WEB_FLOW_KEY_ID,  # a 40-hex fingerprint ending in it
        ):
            with self.subTest(identity=identity):
                self._refused("GitHub's web-flow signing key", self._enrolled(identity))

    def test_enrolling_githubs_web_flow_committer_identity_is_reported(self):
        for identity in (
            "GitHub <noreply@github.com>",
            "github <NOREPLY@GitHub.com>",
        ):
            with self.subTest(identity=identity):
                self._refused(
                    "GitHub's web-flow committer identity", self._enrolled(identity)
                )

    def test_a_key_that_merely_resembles_the_web_flow_key_is_allowed(self):
        """The refusal is not a blanket one: a different 16-hex key id passes."""
        result = self._run(self._enrolled("B5690EEEBB952195"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


class BootstrapSeatingClosed(unittest.TestCase):
    """badf/bootstrap.yaml: the one-time act that seats the first human-only seat.

    badf/agents.yaml routes changes to itself to
    ``verifier: repository-administrator``, so filling that seat required the
    seat to verify its own creation. The mechanism that breaks the loop is the
    single most dangerous thing in these records: it is the ONE place where a
    named human may legally appear in a seat, and every rule below exists so
    that appearing there costs a consistent, simultaneous edit to three
    governed files rather than one line.

    NOTHING HERE SEATS ANYONE IN THIS REPOSITORY. Every fixture is written into
    a temporary directory, the principal is fictional, and this repository's own
    badf/agents.yaml holds every seat at the literal null. The seated fixtures
    exist because most of the rules below cannot fire at all while the record is
    still awaiting an operator, and a rule that cannot fire is a rule that would
    pass if it were deleted - the defect five review rounds found five times.
    """

    def _run(self, *, bootstrap=None, agents=None, state=None):
        with tempfile.TemporaryDirectory() as directory:
            tmp = build(Path(directory), state=state)
            if bootstrap is not None:
                (tmp / "badf" / "bootstrap.yaml").write_text(bootstrap, encoding="utf-8")
            if agents is not None:
                (tmp / "badf" / "agents.yaml").write_text(agents, encoding="utf-8")
            return run(tmp)

    def _refused(self, needle, **kwargs):
        result = self._run(**kwargs)
        self.assertEqual(
            result.returncode, 1,
            f"this forgery must be refused:{NL}{result.stdout}{result.stderr}",
        )
        self.assertIn(needle, result.stderr)

    # ---- the baselines must pass, or every test below is meaningless -------

    def test_the_bootstrap_fixture_passes(self):
        result = self._run(bootstrap=BOOTSTRAP_YAML)
        self.assertEqual(
            result.returncode, 0,
            f"the bootstrap baseline must pass:{NL}{result.stdout}{result.stderr}",
        )

    def test_a_valid_seating_passes(self):
        """The POSITIVE control, and the one this class needs most.

        Every other test here requires a refusal. Without this one a validator
        that refused EVERY seating - which is a validator that has quietly
        re-pinned held_by to null and made the whole mechanism decorative -
        would pass all of them and look thorough doing it.
        """
        record = bootstrap_record(state="SEATED", seatings=(ADMIN_SEAT,))
        result = self._run(
            bootstrap=record,
            agents=agents_seated(ADMIN_SEAT),
            state=state_for(record, seats=("repository-administrator",)),
        )
        self.assertEqual(
            result.returncode, 0,
            f"a coherent seating must validate:{NL}{result.stdout}{result.stderr}",
        )

    # ---- the reader: refuse what it cannot classify, with a line number ----

    def test_a_bootstrap_line_the_reader_cannot_classify_is_reported(self):
        self._refused(
            "matches no rule of this record's grammar",
            bootstrap=BOOTSTRAP_YAML.replace(
                "act_id: BOOTSTRAP-001",
                "act_id: BOOTSTRAP-001" + NL + "   three_space_indent: true",
            ),
        )

    def test_an_unknown_top_level_key_in_the_bootstrap_record_is_reported(self):
        self._refused(
            "unknown top-level key",
            bootstrap=BOOTSTRAP_YAML.replace(
                "act_id: BOOTSTRAP-001",
                "already_approved: true" + NL + "act_id: BOOTSTRAP-001",
            ),
        )

    def test_an_unknown_field_on_a_seating_is_reported(self):
        self._refused(
            "unknown field",
            bootstrap=BOOTSTRAP_YAML.replace(
                "    principal: null" + NL,
                "    principal: null" + NL + "    approved_by_itself: true" + NL,
            ),
        )

    # ---- the pinned literals ----------------------------------------------

    def test_a_bootstrap_state_that_is_neither_awaiting_nor_seated_is_reported(self):
        self._refused(
            "records state as 'PROVISIONALLY_SEATED'",
            bootstrap=BOOTSTRAP_YAML.replace(
                "state: AWAITING_OPERATOR_INSTRUCTION", "state: PROVISIONALLY_SEATED"
            ),
        )

    def test_a_bootstrap_established_by_naming_another_mechanism_is_reported(self):
        """(c) established (a), and the record has to say which (c).

        With this rule gone the record reads as a standing operator path that
        stays available afterwards - which is the option
        docs/decisions/PROPOSAL-bootstrap-seating.md costed and rejected.
        """
        self._refused(
            "records established_by as 'STANDING_OPERATOR_AUTHORITY'",
            bootstrap=BOOTSTRAP_YAML.replace(
                "established_by: OPERATOR_INSTRUCTION_ADOPTING_THE_SUCCESSION_RULE",
                "established_by: STANDING_OPERATOR_AUTHORITY",
            ),
        )

    def test_a_bootstrap_record_declaring_itself_a_standing_path_is_reported(self):
        self._refused(
            "records standing_authority_path as 'true'",
            bootstrap=BOOTSTRAP_YAML.replace(
                "standing_authority_path: false", "standing_authority_path: true"
            ),
        )

    def test_a_reworded_establishment_statement_is_reported(self):
        self._refused(
            "does not carry the establishment statement verbatim",
            bootstrap=BOOTSTRAP_YAML.replace(
                "IT IS NOT A STANDING ALTERNATIVE", "IT IS ALSO A STANDING ALTERNATIVE"
            ),
        )

    def test_a_bootstrap_record_with_no_frozen_region_is_reported(self):
        """No markers, no digest, no immutability - and the file still reads
        exactly as authoritative as it did with them."""
        self._refused(
            "does not delimit a historical record",
            bootstrap=BOOTSTRAP_YAML.replace(
                "# ---- END HISTORICAL RECORD ----" + NL, ""
            ),
        )

    # ---- the seats ---------------------------------------------------------

    def test_a_seating_naming_the_same_seat_twice_is_reported(self):
        record = bootstrap_record(
            state="SEATED",
            seatings=(("repository-administrator", OTHER_PRINCIPAL), ADMIN_SEAT),
        )
        self._refused(
            "which an earlier seating in this record already names",
            bootstrap=record,
            agents=agents_seated(ADMIN_SEAT),
            state=state_for(record, seats=("repository-administrator",)),
        )

    def test_a_seating_naming_no_declared_role_is_reported(self):
        record = bootstrap_record(
            state="SEATED", seatings=(("supreme-administrator", PRINCIPAL),)
        )
        self._refused(
            "which is no role declared in badf/agents.yaml",
            bootstrap=record,
            state=state_for(record, seats=()),
        )

    def test_a_seating_naming_a_seat_an_agent_may_occupy_is_reported(self):
        """The mechanism exists for human-only seats.

        Without this rule an agent bootstraps a seat no loop ever blocked, and
        the held_by pin - the one thing stopping an occupant being written into
        this registry by whoever is editing it - opens for every
        agent-occupiable seat at once.
        """
        record = bootstrap_record(
            state="SEATED", seatings=(("peer-reviewer", PRINCIPAL),)
        )
        self._refused(
            "whose may_be_an_agent is not false",
            bootstrap=record,
            agents=agents_seated(("peer-reviewer", PRINCIPAL), human_only=False),
            state=state_for(record, seats=("peer-reviewer",)),
        )

    def test_a_principal_named_while_awaiting_the_operator_is_reported(self):
        self._refused(
            "while state is AWAITING_OPERATOR_INSTRUCTION",
            bootstrap=bootstrap_record(seatings=(ADMIN_SEAT,)),
        )

    def test_a_seating_with_no_principal_while_seated_is_reported(self):
        """The shipped record with nothing but the state word changed.

        This is the forgery the file is shaped to refuse: the act declared
        complete without an operator ever naming anyone.
        """
        record = bootstrap_record(state="SEATED")
        self._refused(
            "records no principal while state is SEATED",
            bootstrap=record,
            state=state_for(record, seats=()),
        )

    def test_a_seated_seat_whose_held_by_is_still_null_is_reported(self):
        record = bootstrap_record(state="SEATED", seatings=(ADMIN_SEAT,))
        self._refused(
            "The two records must agree in BOTH",
            bootstrap=record,
            state=state_for(record, seats=("repository-administrator",)),
        )

    def test_a_held_by_no_bootstrap_record_names_is_reported(self):
        """The other direction, and the one with a motive behind it: an
        occupant written into badf/agents.yaml with no act that seated them."""
        self._refused(
            "records no valid bootstrap seating naming that seat and that principal",
            agents=agents_seated(ADMIN_SEAT),
        )

    # ---- constraint 4: declared separation = actual separation -------------

    def test_one_principal_in_two_seats_without_the_exception_is_reported(self):
        record = bootstrap_record(state="SEATED", seatings=(ADMIN_SEAT, BUSINESS_SEAT))
        self._refused(
            "is recorded as the occupant of",
            bootstrap=record,
            agents=agents_seated(ADMIN_SEAT, BUSINESS_SEAT),
            state=state_for(
                record, seats=("repository-administrator", "business-authority")
            ),
        )

    def test_a_declared_dual_seat_with_no_dual_seat_is_reported(self):
        """A fictitious separation exception: the declaration is there, the
        expiry is there, nobody holds two seats, so nothing will ever trigger
        and nothing has to be restored."""
        record = bootstrap_record(
            state="SEATED",
            seatings=(ADMIN_SEAT,),
            dual="true",
            exception="BOOTSTRAP",
            expiry='"2999-01-01"',
            trigger='"a second human accepts the second seat"',
        )
        self._refused(
            "no principal in this record holds two seats",
            bootstrap=record,
            agents=agents_seated(ADMIN_SEAT),
            state=state_for(record, seats=("repository-administrator",)),
        )

    def test_a_dual_seat_whose_exception_type_is_not_bootstrap_is_reported(self):
        record = bootstrap_record(
            state="SEATED",
            seatings=(ADMIN_SEAT, BUSINESS_SEAT),
            dual="true",
            exception="OPERATIONAL_CONVENIENCE",
            expiry='"2999-01-01"',
            trigger='"a second human accepts the second seat"',
        )
        self._refused(
            "with exception_type 'OPERATIONAL_CONVENIENCE'",
            bootstrap=record,
            agents=agents_seated(ADMIN_SEAT, BUSINESS_SEAT),
            state=state_for(
                record, seats=("repository-administrator", "business-authority")
            ),
        )

    def test_a_dual_seat_with_no_expiry_or_trigger_is_reported(self):
        record = bootstrap_record(
            state="SEATED",
            seatings=(ADMIN_SEAT, BUSINESS_SEAT),
            dual="true",
            exception="BOOTSTRAP",
        )
        self._refused(
            "A dual seat records BOTH",
            bootstrap=record,
            agents=agents_seated(ADMIN_SEAT, BUSINESS_SEAT),
            state=state_for(
                record, seats=("repository-administrator", "business-authority")
            ),
        )

    def test_a_dual_seat_exception_that_has_already_expired_is_reported(self):
        record = bootstrap_record(
            state="SEATED",
            seatings=(ADMIN_SEAT, BUSINESS_SEAT),
            dual="true",
            exception="BOOTSTRAP",
            expiry='"2020-01-01"',
            trigger='"a second human accepts the second seat"',
        )
        self._refused(
            "the dual-seat exception expired on 2020-01-01",
            bootstrap=record,
            agents=agents_seated(ADMIN_SEAT, BUSINESS_SEAT),
            state=state_for(
                record, seats=("repository-administrator", "business-authority")
            ),
        )

    # ---- constraint 1: the capability is consumed by its own use -----------

    def test_a_ledger_disagreeing_about_whether_anyone_is_seated_is_reported(self):
        record = bootstrap_record(state="SEATED", seatings=(ADMIN_SEAT,))
        ledger = state_for(record, seats=("repository-administrator",))
        ledger["bootstrap"]["state"] = "AWAITING_OPERATOR_INSTRUCTION"
        self._refused(
            "records bootstrap.state 'AWAITING_OPERATOR_INSTRUCTION'",
            bootstrap=record,
            agents=agents_seated(ADMIN_SEAT),
            state=ledger,
        )

    def test_a_state_file_with_no_consumption_ledger_is_reported(self):
        """Deleting the ledger is how the record becomes its own only witness.

        schemas/current-state.schema.json requires the block, so the run fails
        either way - which is precisely why this refusal needs a control of its
        own. Without one it could be deleted and the sweep would still be
        green, and the fail-closed `return {}` underneath it would go with it.
        """
        state = copy.deepcopy(STATE)
        del state["bootstrap"]
        self._refused("records no bootstrap block", bootstrap=BOOTSTRAP_YAML, state=state)

    def test_a_second_bootstrap_act_is_reported(self):
        """The persistent bypass. One act was spent; this is a second one,
        written into the same file with the same ceremony and no operator
        anywhere near it."""
        record = bootstrap_record(
            state="SEATED", seatings=(BUSINESS_SEAT,), act_id="BOOTSTRAP-002"
        )
        ledger = state_for(record, seats=("business-authority",))
        ledger["bootstrap"]["act_id"] = "BOOTSTRAP-001"
        self._refused(
            "It is SINGLE-USE",
            bootstrap=record,
            agents=agents_seated(BUSINESS_SEAT),
            state=ledger,
        )

    def test_a_consumed_bootstrap_record_reused_for_another_seat_is_reported(self):
        """The same act, extended. The ledger records the one seat it was
        consumed seating; the record now seats a second one under it."""
        record = bootstrap_record(
            state="SEATED", seatings=(ADMIN_SEAT, OTHER_BUSINESS_SEAT)
        )
        self._refused(
            "may not be reused for another seat",
            bootstrap=record,
            agents=agents_seated(ADMIN_SEAT, OTHER_BUSINESS_SEAT),
            state=state_for(record, seats=("repository-administrator",)),
        )

    # ---- constraint 2: immutability, and non-self-amendment ----------------

    def test_a_digest_recorded_before_anyone_is_seated_is_reported(self):
        ledger = state_for(BOOTSTRAP_YAML, seats=())
        ledger["bootstrap"]["historical_digest"] = digest_of(BOOTSTRAP_YAML)
        self._refused(
            "records a bootstrap historical_digest while",
            bootstrap=BOOTSTRAP_YAML,
            state=ledger,
        )

    def test_an_edited_historical_record_is_reported(self):
        """The seated administrator rewriting the act that created it.

        The digest was recorded over the text that seated the seat; the record
        now says something else, and every OTHER check here still passes,
        because the record is entirely consistent with itself. That is the
        whole reason the digest lives in a second file.
        """
        record = bootstrap_record(state="SEATED", seatings=(ADMIN_SEAT,))
        ledger = state_for(record, seats=("repository-administrator",))
        rewritten = record.replace(
            "instruction_origin: null",
            'instruction_origin: "a different instruction entirely"',
        )
        self.assertNotEqual(rewritten, record, "the replace target did not match")
        self._refused(
            "hashes to",
            bootstrap=rewritten,
            agents=agents_seated(ADMIN_SEAT),
            state=ledger,
        )

    def test_routing_the_bootstrap_record_to_the_seat_it_seats_is_reported(self):
        """Non-self-amending, structurally. An administrator who may verify a
        change to badf/bootstrap.yaml may rewrite its own appointment."""
        agents = AGENTS_YAML.replace(
            "    verifier: legal-compliance-reviewer" + NL,
            "    verifier: repository-administrator" + NL,
        )
        self.assertNotEqual(agents, AGENTS_YAML, "the replace target did not match")
        self._refused(
            "which is a seat badf/bootstrap.yaml seats",
            bootstrap=BOOTSTRAP_YAML,
            agents=agents,
        )

    # ---- constraint 5: the succession rule, present and unmodified ---------

    def test_deleting_the_first_fill_succession_sentence_is_reported(self):
        agents = AGENTS_YAML.replace(SUCCESSION_FIRST_FILL, "  It depends." + NL)
        self.assertNotEqual(agents, AGENTS_YAML, "the replace target did not match")
        self._refused(
            "a human-only seat's FIRST occupant is verified by a DIFFERENT "
            "human-only seat",
            agents=agents,
        )

    def test_deleting_the_subsequent_change_succession_sentence_is_reported(self):
        """The half that makes it a RULE rather than a standing exception.

        Delete it and the file still reads as though it had a succession rule
        while saying nothing about how the SECOND change to a seat's occupancy
        is verified - which is the door the bootstrap path would then be left
        propped open behind.
        """
        agents = AGENTS_YAML.replace(SUCCESSION_SUBSEQUENT, "  It depends." + NL)
        self.assertNotEqual(agents, AGENTS_YAML, "the replace target did not match")
        self._refused(
            "once a seat is filled, its occupancy is routed like everything else",
            agents=agents,
        )

    # ---- round two: the frozen region has to enclose the record ------------

    def test_a_frozen_region_that_encloses_nothing_is_reported(self):
        """C-1, first half. BEGIN immediately followed by END hashes the empty
        string - e3b0c442... - and the digest is recorded at the one moment
        there is nothing to compare it against, so it would never be caught
        later either."""
        record = BOOTSTRAP_YAML.replace("# ---- BEGIN HISTORICAL RECORD ----" + NL, "")
        record = record.replace(
            "# ---- END HISTORICAL RECORD ----" + NL,
            "# ---- BEGIN HISTORICAL RECORD ----" + NL
            + "# ---- END HISTORICAL RECORD ----" + NL,
        )
        self.assertNotEqual(record, BOOTSTRAP_YAML, "the replace target did not match")
        self._refused("the frozen historical region encloses no content at all", bootstrap=record)

    def test_a_field_recorded_outside_the_frozen_region_is_reported(self):
        """C-1, second half, and the sharper attack.

        With END moved so the region held only act_id, a seating was recorded,
        the digest taken, and the principal then rewritten in BOTH
        badf/bootstrap.yaml and badf/agents.yaml with the ledger untouched -
        one forger, one pair of files, digest still matching. A digest over a
        region that encloses less than the record binds less than it appears
        to.
        """
        record = BOOTSTRAP_YAML.replace("# ---- END HISTORICAL RECORD ----" + NL, "")
        record = record.replace(
            "state: AWAITING_OPERATOR_INSTRUCTION" + NL,
            "# ---- END HISTORICAL RECORD ----" + NL
            + "state: AWAITING_OPERATOR_INSTRUCTION" + NL,
        )
        self.assertNotEqual(record, BOOTSTRAP_YAML, "the replace target did not match")
        self._refused("is recorded OUTSIDE the frozen historical region", bootstrap=record)

    # ---- round two: acts and readers that record nothing -------------------

    def test_a_completed_act_that_seats_nobody_is_reported(self):
        """The single-use capability recorded as spent having seated no one:
        the act is gone, no office is filled, and the next vacancy has neither
        an operator instruction nor an unspent one to reach for."""
        record = bootstrap_record(state="SEATED", seatings=())
        self._refused(
            "records state SEATED and no seating at all",
            bootstrap=record,
            state=state_for(record, seats=()),
        )

    def test_a_top_level_scalar_with_no_value_is_reported(self):
        """The reader's own docstring says it refuses what it cannot classify.

        An empty value used to open a folded block, and a block opened by
        accident swallows every line indented under it without classifying any
        of them. `expiry:` with no value between `seatings:` and its entries
        makes the whole block invisible: this record READS as seating a named
        human and parsed as no seating at all.
        """
        record = bootstrap_record(
            state="SEATED", seatings=(("repository-administrator", "Mallory Operator"),)
        )
        record = record.replace("seatings:" + NL, "seatings:" + NL + "expiry:" + NL)
        self.assertIn("Mallory Operator", record, "the fixture must read as a seating")
        self._refused(
            "carries no value and does not open a folded scalar",
            bootstrap=record,
            state=state_for(record, seats=()),
        )

    def test_dual_seat_fields_recorded_with_no_dual_seat_are_reported(self):
        """Only a PAST expiry was checked, so a future date sat here reading as
        a live exception that no rule above governs."""
        record = bootstrap_record(
            state="SEATED",
            seatings=(ADMIN_SEAT,),
            expiry='"2999-01-01"',
            trigger='"a second human accepts the second seat"',
        )
        self._refused(
            "and still carries exception_type",
            bootstrap=record,
            agents=agents_seated(ADMIN_SEAT),
            state=state_for(record, seats=("repository-administrator",)),
        )

    # ---- round two: the routing rule, and the succession KEY ---------------

    def test_deleting_the_bootstrap_routing_entry_is_reported(self):
        """A path with no row routes to peer-reviewer and stops - a seat an
        agent may occupy. Deleting the row is how the record of who was seated
        becomes agent-reviewable with nobody recording that."""
        agents = AGENTS_YAML.replace(
            '  - path: "badf/bootstrap.yaml"' + NL
            + "    owner: architecture-authority" + NL
            + "    verifier: legal-compliance-reviewer" + NL,
            "",
        )
        self.assertNotEqual(agents, AGENTS_YAML, "the replace target did not match")
        self._refused(
            "records no routing entry for 'badf/bootstrap.yaml'",
            bootstrap=BOOTSTRAP_YAML,
            agents=agents,
        )

    def test_routing_the_bootstrap_record_to_an_agent_occupiable_seat_is_reported(self):
        """Not the seat this record seats - just a seat an agent may hold.

        This rule and the self-amendment rule are now the WHOLE requirement for
        this path: the static PINNED_ROUTING entry is gone, because changing a
        static pin is a change to scripts/validate_continuity.py, which
        badf/agents.yaml routes to two seats an agent may occupy.
        """
        agents = AGENTS_YAML.replace(
            "    verifier: legal-compliance-reviewer" + NL,
            "    verifier: peer-reviewer" + NL,
        )
        self.assertNotEqual(agents, AGENTS_YAML, "the replace target did not match")
        self._refused(
            "which is not a seat pinned may_be_an_agent: false",
            bootstrap=BOOTSTRAP_YAML,
            agents=agents,
        )

    def test_demoting_the_succession_rule_to_comments_is_reported(self):
        """Constraint 5 was a byte-substring pin over the whole file, so
        deleting the succession: key and leaving both sentences as ordinary
        comments passed. A rule nothing parses is not a rule of the file."""
        block = AGENTS_YAML[AGENTS_YAML.index("succession: >-"):]
        commented = NL.join("# " + line for line in block.rstrip(NL).split(NL)) + NL
        agents = AGENTS_YAML.replace(block, commented)
        self.assertNotEqual(agents, AGENTS_YAML, "the replace target did not match")
        self.assertIn(
            " ".join(SUCCESSION_FIRST_FILL.split()),
            " ".join(agents.replace("#", " ").split()),
            "the sentences must still be PRESENT as prose, or this proves nothing",
        )
        self._refused("declares no top-level succession: key", agents=agents)


class BootstrapIsSingleUse(unittest.TestCase):
    """Review finding M3: the ledger is data, so the pin has to be code.

    Each test below is a forgery that is CONSISTENT across the three files
    (bootstrap.yaml, agents.yaml, current-state.json): the record, the
    held_by values and the ledger all agree, and the digest is recomputed. Only
    the pins in scripts/validate_continuity.py stand between it and a pass.

    The pins are passed EXPLICITLY, and each test moves exactly one of them
    out of agreement with the forgery while keeping the others in agreement
    with it. That is what lets deleting one pin turn exactly one test red: a
    forgery that also broke a second pin would leave the first unwitnessed.
    """

    SPENT = bootstrap_record(state="SEATED", seatings=(ADMIN_SEAT,))

    def _forged(self, record, agents, seats, pins):
        with tempfile.TemporaryDirectory() as directory:
            tmp = build(Path(directory), state=state_for(record, seats=seats))
            (tmp / "badf" / "bootstrap.yaml").write_text(record, encoding="utf-8")
            (tmp / "badf" / "agents.yaml").write_text(agents, encoding="utf-8")
            return run(tmp, pins=pins)

    def test_the_spent_act_passes_under_its_own_pins(self):
        """The positive control: the pins accept the one act they describe."""
        result = self._forged(
            self.SPENT, agents_seated(ADMIN_SEAT), ("repository-administrator",),
            bootstrap_pins_for(self.SPENT),
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_a_second_seating_by_the_spent_act_is_reported_even_when_the_ledger_agrees(self):
        """An agent identifier seated in human-only business-authority."""
        agent = ("business-authority", "claude-code/motor")
        record = bootstrap_record(state="SEATED", seatings=(ADMIN_SEAT, agent))
        pins = bootstrap_pins_for(record)  # act, state and digest follow the forgery
        pins["SEATS"] = ["repository-administrator"]
        result = self._forged(
            record, agents_seated(ADMIN_SEAT, agent),
            ("repository-administrator", "business-authority"), pins,
        )
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("seated exactly", result.stderr)
        self.assertIn("business-authority", result.stderr)

    def test_a_second_bootstrap_act_is_reported_even_when_the_ledger_agrees(self):
        record = bootstrap_record(
            state="SEATED", act_id="BOOTSTRAP-002",
            seatings=(("repository-administrator", OTHER_PRINCIPAL),),
        )
        pins = bootstrap_pins_for(record)
        pins["ACT"] = "BOOTSTRAP-001"
        result = self._forged(
            record, agents_seated(("repository-administrator", OTHER_PRINCIPAL)),
            ("repository-administrator",), pins,
        )
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("BOOTSTRAP-001 is the only bootstrap act", result.stderr)
        self.assertIn("BOOTSTRAP-002", result.stderr)

    def test_a_rewritten_historical_record_is_reported_even_when_the_ledger_digest_is_repaired(self):
        record = bootstrap_record(
            state="SEATED", seatings=(("repository-administrator", OTHER_PRINCIPAL),)
        )
        pins = bootstrap_pins_for(record)
        pins["DIGEST"] = digest_of(self.SPENT)
        result = self._forged(
            record, agents_seated(("repository-administrator", OTHER_PRINCIPAL)),
            ("repository-administrator",), pins,
        )
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("frozen historical region hashes to", result.stderr)
        self.assertIn("pinned in scripts/validate_continuity.py", result.stderr)

    def test_reverting_the_spent_act_to_awaiting_is_reported_even_when_the_ledger_agrees(self):
        """Un-spending the act makes every other pin vacuous."""
        record = bootstrap_record()
        pins = bootstrap_pins_for(record)
        pins["STATE"] = "SEATED"
        result = self._forged(record, AGENTS_YAML, (), pins)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("records state 'AWAITING_OPERATOR_INSTRUCTION'", result.stderr)
        self.assertIn("pinned as SEATED", result.stderr)


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
