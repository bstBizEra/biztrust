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
import importlib.util
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
  - scripts/check-signing.mjs
  - scripts/signing-policy.mjs
  - scripts/validate_continuity.py
  - schemas
  - package.json
  - .github
  - scripts/python.mjs
  - scripts/mutation-check.mjs
  - tests/unit
  - tests/signing
  - badf/decision-log.jsonl
  - badf/next-actions.json

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

    The pins follow the RECORD (bootstrap.yaml) and never the ledger in
    current-state.json. A pin that followed the ledger would duplicate the
    ledger rules it sits beside, so deleting one of THOSE rules would leave the
    pin to report the same defect and the older mutation would survive: the
    first sweep after these pins were added showed exactly that, for the
    historical-digest comparison.
    """
    try:
        record = (tmp / "badf" / "bootstrap.yaml").read_text(encoding="utf-8")
    except OSError:
        return None
    seats = re.findall(r"^  - seat: (\S+)[ ]*$", record, re.MULTILINE)
    pins = bootstrap_pins_for(record, seats)
    try:
        pins["DIGEST"] = digest_of(record) if pins["STATE"] == "SEATED" else None
    except ValueError:
        pins["DIGEST"] = None
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

    # ---- round nine R9-m3: control 8's own condition ------------------------
    #
    # "A record drifts from its schema" was witnessed by a checkpoint with an
    # EMPTY validation list and by a missing field in the state file - never by
    # a checkpoint missing a required field. Dropping `required` from the
    # checkpoint schema alone left the whole suite green.

    def test_a_checkpoint_missing_a_required_field_is_reported(self):
        checkpoint = copy.deepcopy(CHECKPOINT)
        del checkpoint["blockers"]
        result = self._broken(checkpoint=checkpoint)
        self.assertIn("missing required field 'blockers'", result.stderr)

    def test_a_checkpoint_in_a_subdirectory_is_reported(self):
        """`glob("*.json")` is not recursive: a malformed record below it passed."""
        result = self._broken(extra_files={"sessions/checkpoints/nested/x.json": "{}"})
        self.assertIn("sessions/checkpoints/nested/x.json", result.stderr)
        self.assertIn("is in a subdirectory of sessions/checkpoints/", result.stderr)

    def test_a_checkpoint_with_an_upper_case_extension_is_reported(self):
        """Windows matched `*.json` case-insensitively and Linux, where CI runs, does not."""
        result = self._broken(extra_files={"sessions/checkpoints/other.JSON": "{}"})
        self.assertIn("sessions/checkpoints/other.JSON", result.stderr)
        self.assertIn("its extension is not exactly '.json'", result.stderr)

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

    # ---- tool_authority: ordinary YAML must not get past the pin (round 7 N1) --
    #
    # The B1 refusal compared the text of each list item. A trailing comment
    # after a quoted item left the quotes and the comment in the compared
    # string, so a forbidden power written under `may` no longer matched its
    # pin, while PyYAML read exactly the pinned string. A second top-level
    # `tool_authority:` block was merged with the first, and PyYAML keeps the
    # LAST duplicate. Both are one-file edits.

    def _with_raw_tool_authority(self, block, *, append=""):
        text = AUTHORITY_YAML.replace(tool_authority_yaml(), block) + append
        with tempfile.TemporaryDirectory() as directory:
            tmp = build(Path(directory))
            (tmp / "badf" / "authority.yaml").write_text(text, encoding="utf-8")
            return run(tmp)

    def _may_item_lines(self, *lines):
        block = tool_authority_yaml()
        anchor = "  may_not:" + NL
        self.assertEqual(block.count(anchor), 1)
        return block.replace(anchor, "".join(line + NL for line in lines) + anchor)

    def test_a_tool_power_item_with_a_trailing_comment_is_refused_not_skipped(self):
        forbidden = "Grant, extend or infer authority, including its own"
        for label, line in (
            ("double-quoted", "    - " + chr(34) + forbidden + chr(34) + "  # per operator"),
            ("single-quoted", "    - " + chr(39) + forbidden + chr(39) + " # per operator"),
            ("plain", "    - " + forbidden + " # per operator"),
        ):
            with self.subTest(form=label):
                result = self._with_raw_tool_authority(self._may_item_lines(line))
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn(
                    "not exactly one quoted scalar or one plain scalar", result.stderr
                )

    def test_a_tool_power_item_with_a_comment_under_may_not_is_refused_too(self):
        block = tool_authority_yaml().replace(
            chr(34) + "Push to main" + chr(34) + NL,
            chr(34) + "Push to main" + chr(34) + "  # retired" + NL,
        )
        self.assertIn("# retired", block)
        result = self._with_raw_tool_authority(block)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("not exactly one quoted scalar or one plain scalar", result.stderr)

    def test_a_tool_power_item_that_is_not_a_scalar_is_refused(self):
        for label, line in (
            ("flow sequence", "    - [" + chr(34) + "Push to main" + chr(34) + "]"),
            ("flow mapping", "    - {a: b}"),
            ("anchor", "    - &pin Push to main"),
            ("empty", "    - "),
            ("unterminated quote", "    - " + chr(34) + "Push to main"),
            ("text after a closing quote", "    - " + chr(34) + "a" + chr(34) + " b"),
        ):
            with self.subTest(form=label):
                result = self._with_raw_tool_authority(self._may_item_lines(line))
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn(
                    "not exactly one quoted scalar or one plain scalar", result.stderr
                )

    def test_plain_and_single_quoted_tool_power_items_are_still_read(self):
        """The refusal is not a ban on YAML: an ordinary scalar still passes."""
        block = self._may_item_lines(
            "    - Read the audit trail",
            "    - " + chr(39) + "Open a branch, it" + chr(39) * 2 + "s under a Work Package" + chr(39),
            "    - " + chr(34) + "Say " + chr(92) + chr(34) + "no" + chr(92) + chr(34) + chr(34),
        )
        result = self._with_raw_tool_authority(block)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_a_tool_power_with_a_non_ascii_character_is_refused(self):
        """Round nine S-4. `_normalised` folds Unicode whitespace and YAML does not.

        `Push<NBSP>to main` satisfied the pin while a strict YAML consumer found
        `Push to main` absent from may_not. A homoglyph or a zero-width space
        under `may` is a power no pin can ever name. Refusing every non-ASCII
        character closes all three, and the escape spelling too: the item is
        judged AFTER it is decoded.
        """
        backslash = chr(92)
        nbsp, zero_width, cyrillic_a = chr(0xA0), chr(0x200B), chr(0x430)
        forbidden_may_not = TOOL_MAY_NOT[0]
        for label, block in (
            (
                "a no-break space replacing a space in may_not",
                tool_authority_yaml(may_not=(forbidden_may_not.replace(" ", nbsp),) + TOOL_MAY_NOT[1:]),
            ),
            (
                "a zero-width space in may",
                tool_authority_yaml(may=TOOL_MAY + ("Push to" + zero_width + " main",)),
            ),
            (
                "a Cyrillic homoglyph in may",
                tool_authority_yaml(may=TOOL_MAY + ("Push to m" + cyrillic_a + "in",)),
            ),
            (
                "a JSON escape that decodes to a no-break space",
                tool_authority_yaml().replace(
                    chr(34) + "Push to main" + chr(34),
                    chr(34) + "Push" + backslash + "u00a0to main" + chr(34),
                ),
            ),
        ):
            with self.subTest(form=label):
                result = self._with_raw_tool_authority(block)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn("non-ASCII character", result.stderr)

    def test_a_second_tool_authority_block_is_reported(self):
        second = (
            "tool_authority:" + NL
            + "  may:" + NL
            + "    - " + chr(34) + "Everything the operator can do" + chr(34) + NL
            + "  may_not:" + NL
            + "    - " + chr(34) + "Nothing" + chr(34) + NL
        )
        result = self._with_raw_tool_authority(tool_authority_yaml(), append=second)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("top-level key 'tool_authority' appears more than once", result.stderr)

    def test_a_second_list_of_the_same_name_inside_tool_authority_is_reported(self):
        """The same bypass one level down: YAML keeps the last `may_not`."""
        block = tool_authority_yaml() + (
            "  may_not:" + NL + "    - " + chr(34) + "Nothing" + chr(34) + NL
        )
        result = self._with_raw_tool_authority(block)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("tool_authority.may_not appears more than once", result.stderr)

    def test_a_second_top_level_section_of_any_kind_is_reported(self):
        result = self._with_raw_tool_authority(
            tool_authority_yaml(), append="not_granted:" + NL
        )
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("top-level key 'not_granted' appears more than once", result.stderr)

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

    # ---- credential shapes the scan used to miss (review finding m5) --------
    #
    # Every token below is assembled at RUN TIME from parts, so no literal with
    # the shape of a credential is committed: GitHub push protection would
    # refuse the push, and this scan would refuse the tree.

    def _leaks(self, token):
        return self._broken(extra_files={"docs/leak.md": "note: " + token + NL})

    def test_a_github_server_or_user_token_in_the_tree_is_reported(self):
        for prefix in ("ghs", "ghu"):
            with self.subTest(prefix=prefix):
                result = self._leaks(prefix + "_" + "A" * 36)
                self.assertIn("docs/leak.md: contains what looks like a GitHub", result.stderr)

    def test_a_github_refresh_token_in_the_tree_is_reported(self):
        # Round seven m2. `ghr_` is GitHub's refresh token, and the scan named
        # ghp, gho, ghs and ghu but not this one.
        result = self._leaks("gh" + "r_" + "A" * 36)
        self.assertIn("docs/leak.md: contains what looks like a GitHub refresh token", result.stderr)

    def test_a_stripe_restricted_key_in_the_tree_is_reported(self):
        # Round seven m2. `rk_live_` is Stripe's restricted key, and only
        # `sk_live_` was covered.
        result = self._leaks("rk" + "_live_" + "a1B2" * 6)
        self.assertIn("docs/leak.md: contains what looks like a Stripe restricted key", result.stderr)

    def test_a_credential_planted_in_the_validator_itself_is_reported(self):
        """Round seven m1. The whole validator file used to be exempt from the scan.

        It is the file that carries every pin, and an exemption for a file
        that "names the patterns" covered the file with the most room to hide a
        token in a comment or a string. The patterns are regexes, and a regex
        does not match itself, so the exemption bought nothing but the hole.
        """
        for label, token in (
            ("ghp", "gh" + "p_" + "A" * 36),
            ("sk_live", "sk" + "_live_" + "a1B2" * 6),
        ):
            with self.subTest(token=label):
                with tempfile.TemporaryDirectory() as directory:
                    tmp = build(Path(directory))
                    validator = tmp / "scripts" / "validate_continuity.py"
                    validator.write_text(
                        validator.read_text(encoding="utf-8") + NL + "# " + token + NL,
                        encoding="utf-8",
                    )
                    result = run(tmp)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn(
                    "scripts/validate_continuity.py: contains what looks like",
                    result.stderr,
                )

    def test_the_unmodified_validator_holds_no_credential_shape(self):
        """The other half of m1: with the exemption gone, the file must scan clean."""
        with tempfile.TemporaryDirectory() as directory:
            result = run(build(Path(directory)))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("validate_continuity.py: contains", result.stderr)

    def test_a_stripe_live_key_in_the_tree_is_reported(self):
        result = self._leaks("sk" + "_live_" + "a1B2" * 6)
        self.assertIn("docs/leak.md: contains what looks like a Stripe live key", result.stderr)

    def test_a_google_api_key_in_the_tree_is_reported(self):
        result = self._leaks("AI" + "za" + "Sy" + "A" * 33)
        self.assertIn("docs/leak.md: contains what looks like a Google API key", result.stderr)

    def test_an_npm_token_in_the_tree_is_reported(self):
        result = self._leaks("npm" + "_" + "a1B2c3" * 6)
        self.assertIn("docs/leak.md: contains what looks like an npm access token", result.stderr)

    # ---- round nine S-5: three more shapes a review planted and the scan missed ----

    def test_a_gitlab_token_in_the_tree_is_reported(self):
        result = self._leaks("glp" + "at-" + "A" * 24)
        self.assertIn("docs/leak.md: contains what looks like a GitLab access token", result.stderr)

    def test_an_anthropic_key_in_the_tree_is_reported(self):
        result = self._leaks("sk" + "-ant-" + "api03-" + "A" * 30)
        self.assertIn("docs/leak.md: contains what looks like an Anthropic API key", result.stderr)

    def test_a_stripe_test_restricted_key_in_the_tree_is_reported(self):
        result = self._leaks("rk" + "_test_" + "a1B2" * 6)
        self.assertIn("docs/leak.md: contains what looks like a Stripe test restricted key", result.stderr)

    # ---- round nine S-2: build directories are skipped only when git does not track them ----
    #
    # The scan skipped any path with a `__pycache__` segment and a top-level
    # `dist/` whether or not git tracked it. Both are gitignored, but
    # `git add -f` ships a file in CI's checkout, so a force-added file was the
    # one place a credential could sit unscanned.

    TOKEN = "gh" + "p_" + "A" * 36

    def _in_a_git_repository(self, path, *, track):
        with tempfile.TemporaryDirectory() as directory:
            tmp = build(Path(directory), extra_files={path: "note: " + self.TOKEN + NL})
            subprocess.run(["git", "init", "-q"], cwd=tmp, check=True)
            if track:
                subprocess.run(["git", "add", "-f", path], cwd=tmp, check=True)
            return run(tmp)

    def test_a_credential_in_a_tracked_pycache_directory_is_reported(self):
        result = self._in_a_git_repository("docs/__pycache__/notes.txt", track=True)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("docs/__pycache__/notes.txt: contains what looks like", result.stderr)

    def test_a_credential_in_a_tracked_top_level_dist_directory_is_reported(self):
        result = self._in_a_git_repository("dist/notes.txt", track=True)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("dist/notes.txt: contains what looks like", result.stderr)

    def test_an_untracked_build_directory_is_still_skipped(self):
        """The boundary of the fix: untracked build output is not repository content."""
        for path in ("docs/__pycache__/notes.txt", "dist/notes.txt"):
            with self.subTest(path=path):
                result = self._in_a_git_repository(path, track=False)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_a_build_directory_outside_any_git_repository_is_skipped(self):
        with tempfile.TemporaryDirectory() as directory:
            tmp = build(Path(directory), extra_files={"dist/notes.txt": "note: " + self.TOKEN + NL})
            result = run(tmp)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_words_that_only_resemble_a_credential_prefix_are_allowed(self):
        """The scan is not a substring ban: short and separated forms pass."""
        with tempfile.TemporaryDirectory() as directory:
            tmp = build(Path(directory), extra_files={
                "docs/prose.md": (
                    "npm_config_user_agent and ghs_short and sk_live_ and AIza are names, "
                    "not credentials." + NL
                ),
            })
            result = run(tmp)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

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

    # ---- review finding M5: the instrument is inside its own protected set --
    #
    # A one-line edit to scripts/check-signing.mjs (`|| true`) turned an
    # enforcing check into a false PASS, and that file was not a protected
    # path. Typed here rather than imported, so the test does not agree with
    # the pin by construction.

    INSTRUMENT_PATHS = (
        "scripts/check-signing.mjs",
        "scripts/signing-policy.mjs",
        "scripts/validate_continuity.py",
        "schemas",
        "package.json",
        ".github",
    )

    def test_dropping_a_pinned_instrument_path_is_reported(self):
        for path in self.INSTRUMENT_PATHS:
            with self.subTest(path=path):
                policy = SIGNING_POLICY_YAML.replace("  - " + path + NL, "", 1)
                self.assertNotEqual(policy, SIGNING_POLICY_YAML, "the replace target did not match")
                self._refused(
                    "'" + path + "' is pinned in scripts/validate_continuity.py "
                    "(PINNED_PROTECTED_PATHS)",
                    policy,
                )

    # ---- round seven N2: the launcher, the witnesses and two records --------
    #
    # `validate:records` and `test:validator` both run through
    # scripts/python.mjs, and neither it, tests/unit, tests/signing nor the
    # mutation sweep was a protected path: with a key enrolled, one injected
    # line in the launcher printed PASS for the validator, and the tests that
    # witness the signing check could be edited in the change they judge.
    # badf/decision-log.jsonl and badf/next-actions.json are records an agent
    # writes and a human is meant to be able to bind.
    LAUNCHER_AND_WITNESS_PATHS = (
        "scripts/python.mjs",
        "scripts/mutation-check.mjs",
        "tests/unit",
        "tests/signing",
        "badf/decision-log.jsonl",
        "badf/next-actions.json",
    )

    def test_dropping_a_pinned_launcher_or_witness_path_is_reported(self):
        for path in self.LAUNCHER_AND_WITNESS_PATHS:
            with self.subTest(path=path):
                policy = SIGNING_POLICY_YAML.replace("  - " + path + NL, "", 1)
                self.assertNotEqual(policy, SIGNING_POLICY_YAML, "the replace target did not match")
                self._refused(
                    "'" + path + "' is pinned in scripts/validate_continuity.py "
                    "(PINNED_PROTECTED_PATHS)",
                    policy,
                )

    def test_a_dot_directory_is_a_plain_protected_path(self):
        """`.github` has to be spellable, and the fixture carries it."""
        result = self._run(SIGNING_POLICY_YAML)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("  - .github" + NL, SIGNING_POLICY_YAML)

    def test_a_protected_path_that_is_only_a_dot_is_reported(self):
        """One leading dot is allowed when a name follows it. `.` is the whole tree."""
        for path in (".", ".."):
            with self.subTest(path=path):
                self._refused(
                    "is not a plain relative path",
                    SIGNING_POLICY_YAML.replace(
                        "  - sessions/checkpoints", "  - sessions/checkpoints" + NL + "  - " + path, 1
                    ),
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
    # A squash merge INTO main is written by GitHub's merge and signed by
    # GitHub's web-flow key (main itself still holds only its "Initial commit";
    # the five squash merges seen, #4 to #7 and #9, are on PR #1's branch). Enrol
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


class RegistryFieldsAreReadOnce(unittest.TestCase):
    """Round nine S-1: a hand reader must read the file YAML reads.

    The round-seven N1 attack was closed for tool_authority items and left
    open one level up. `parse_authority`, `parse_skills` and `parse_agents`
    took any text after `field:` as the value, so a value that opens a quote it
    does not close swallowed, for every ordinary YAML reader, everything up to a
    quote inside a later `# comment` line - lines these readers skip as
    comments. The last duplicate field won for the validator and, once a
    scalar had swallowed the lines between, for nobody else. One data-file edit
    then made PyYAML read the withheld P0 grant as GRANTED, `record-a-gate` as
    AVAILABLE, or `architecture-authority` as agent-occupiable, with
    `validate:records` printing PASS.

    Every test below breaks EXACTLY ONE of the two shapes (an unclosed quote,
    or a repeated field), so deleting one refusal turns its own test red and no
    other. The reviewer's own plants, which break both at once, are kept
    separately as regression tests and are deliberately not the witnesses.
    """

    QUOTE = "not one complete quoted scalar"
    REPEAT = "appears more than once in"
    OPEN = chr(34)  # an opening quote with no closing one on the line
    Q1 = chr(39)

    def _run(self, **files):
        with tempfile.TemporaryDirectory() as directory:
            tmp = build(Path(directory))
            for name, text in files.items():
                (tmp / "badf" / (name.replace("_", "-") + ".yaml")).write_text(
                    text, encoding="utf-8"
                )
            return run(tmp)

    def _refused(self, needle, **files):
        result = self._run(**files)
        self.assertEqual(
            result.returncode, 1,
            f"this forgery must be refused:{NL}{result.stdout}{result.stderr}",
        )
        self.assertIn(needle, result.stderr)

    def _replaced(self, base, old, new):
        self.assertIn(old, base, "the replace target is not in the fixture")
        return base.replace(old, new, 1)

    # ---- badf/authority.yaml ------------------------------------------------

    def test_an_authority_field_that_opens_a_quote_it_does_not_close_is_refused(self):
        for label, forged in (
            ("double quote, granted", AUTHORITY_YAML + "    see_also: " + self.OPEN + "the entries that follow" + NL),
            ("single quote, granted", AUTHORITY_YAML + "    see_also: " + self.Q1 + "the entries that follow" + NL),
            (
                "double quote, not_granted",
                self._replaced(
                    AUTHORITY_YAML,
                    "  p0_implementation:" + NL + "    status: NOT_GRANTED" + NL,
                    "  p0_implementation:" + NL + "    what: " + self.OPEN + "Authority to implement" + NL
                    + "    status: NOT_GRANTED" + NL,
                ),
            ),
        ):
            with self.subTest(form=label):
                self._refused(self.QUOTE, authority=forged)

    def test_an_authority_quote_that_swallows_the_tool_authority_header_is_refused(self):
        """Reviewer plant S3, without the second shape mixed in.

        A quoted field in `granted` is closed inside a comment line under
        `tool_authority:`. PyYAML then has no such section, and `may` and
        `may_not` become fields of `granted`.
        """
        block = tool_authority_yaml()
        base = AUTHORITY_YAML.replace(block, "")
        self.assertNotEqual(base, AUTHORITY_YAML)
        forged = (
            base
            + "    see_also: " + self.OPEN + "what follows" + NL
            + block.replace("tool_authority:" + NL, "tool_authority:" + NL + "  # is below" + self.OPEN + NL, 1)
        )
        self._refused(self.QUOTE, authority=forged)

    def test_an_authority_top_level_value_that_opens_a_quote_is_refused(self):
        forged = self._replaced(
            AUTHORITY_YAML,
            'updated_at: "2026-01-01T00:00:00Z"',
            'updated_at: "2026-01-01T00:00:00Z',
        )
        self._refused(self.QUOTE, authority=forged)

    def test_a_repeated_field_in_an_authority_entry_is_refused(self):
        forged = self._replaced(
            AUTHORITY_YAML,
            "  p0_implementation:" + NL + "    status: NOT_GRANTED" + NL,
            "  p0_implementation:" + NL + "    status: NOT_GRANTED" + NL + "    status: NOT_GRANTED" + NL,
        )
        self._refused("'status' " + self.REPEAT + " not_granted.p0_implementation", authority=forged)

    def test_a_repeated_entry_in_an_authority_section_is_refused(self):
        forged = self._replaced(
            AUTHORITY_YAML,
            "  p0_implementation:" + NL + "    status: NOT_GRANTED" + NL,
            "  p0_implementation:" + NL + "    status: NOT_GRANTED" + NL
            + "  p0_implementation:" + NL + '    what: "a second entry of the same name"' + NL,
        )
        # The second entry repeats no field, so only the ENTRY refusal can fire.
        self._refused("'p0_implementation' " + self.REPEAT + " not_granted", authority=forged)

    def test_a_quoted_field_name_that_repeats_a_plain_one_is_refused(self):
        """Round ten. YAML reads status, "status" and 'status' as one key and keeps the last.

        Found while auditing the repeated-field refusal, which compared keys as
        written: `"status": GRANTED` under a plain `status: NOT_GRANTED` was two
        fields here and one, GRANTED, to PyYAML. No quote is left open and
        nothing is swallowed, so neither shape of S-1 sees it.
        """
        plain = "  p0_implementation:" + NL + "    status: NOT_GRANTED" + NL
        for label, spelling in (
            ("double-quoted", self.OPEN + "status" + self.OPEN),
            ("single-quoted", self.Q1 + "status" + self.Q1),
        ):
            with self.subTest(form=label):
                forged = self._replaced(AUTHORITY_YAML, plain, plain + "    " + spelling + ": GRANTED" + NL)
                self._refused("is not a plain identifier", authority=forged)

    def test_a_quoted_entry_name_that_repeats_a_plain_one_is_refused(self):
        plain = "  p0_implementation:" + NL + "    status: NOT_GRANTED" + NL
        forged = self._replaced(
            AUTHORITY_YAML, plain,
            plain + "  " + self.OPEN + "p0_implementation" + self.OPEN + ":" + NL + '    what: "again"' + NL,
        )
        self._refused("is not a plain identifier", authority=forged)

    def test_the_reviewers_S1_plant_in_authority_is_refused(self):
        """S1: PyYAML reads status GRANTED, the validator's last `status:` reads NOT_GRANTED."""
        forged = self._replaced(
            AUTHORITY_YAML,
            "  p0_implementation:" + NL + "    status: NOT_GRANTED" + NL,
            "  p0_implementation:" + NL
            + "    status: GRANTED" + NL
            + "    what: " + self.OPEN + "Authority to implement any P0 epic" + NL
            + "    status: NOT_GRANTED" + NL
            + "    # " + self.OPEN + NL,
        )
        result = self._run(authority=forged)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)

    def test_the_reviewers_S2_plant_in_authority_is_refused(self):
        """S2: the granted block moved above not_granted, and P0 forged in place."""
        block = tool_authority_yaml()
        base = AUTHORITY_YAML.replace(block, "")
        granted_at = base.index("granted:" + NL + "  repository_scaffold:")
        not_granted_at = base.index("not_granted:" + NL)
        head, not_granted, granted = base[:not_granted_at], base[not_granted_at:granted_at], base[granted_at:]
        granted = granted.rstrip(NL) + NL + "    see_also: " + self.OPEN + "the entries that follow" + NL + NL
        not_granted = not_granted.replace(
            "not_granted:" + NL, "not_granted:" + NL + "  # are recorded below" + self.OPEN + NL, 1
        )
        not_granted = self._replaced(
            not_granted,
            "  p0_implementation:" + NL + "    status: NOT_GRANTED" + NL,
            "  p0_implementation:" + NL
            + "    status: GRANTED" + NL
            + '    granted_by: "business authority seat"' + NL
            + '    expires_at: "2027-12-31"' + NL
            + '    recorded_by: "business authority seat"' + NL
            + "    what: " + self.OPEN + "Authority to implement any P0 epic" + NL
            + "    status: NOT_GRANTED" + NL
            + "    # " + self.OPEN + NL,
        )
        result = self._run(authority=head + granted + not_granted + block)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)

    def test_a_well_formed_authority_field_is_still_read(self):
        """The refusals are not a ban on quotes: a complete scalar of either kind passes."""
        forged = (
            AUTHORITY_YAML
            + "    see_also: " + chr(34) + "it" + chr(39) + "s here" + chr(34) + NL
            + "    also_see: " + self.Q1 + "it" + self.Q1 * 2 + "s here" + self.Q1 + NL
        )
        result = self._run(authority=forged)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    # ---- badf/skills.yaml ---------------------------------------------------

    RECORD_A_GATE = (
        "  - id: record-a-gate" + NL
        + '    what: "fixture"' + NL
        + '    authority_required: "the human role the gate names"' + NL
        + "    status: FORBIDDEN_TO_AGENTS" + NL
    )

    def test_a_skills_field_that_opens_a_quote_it_does_not_close_is_refused(self):
        for label, forged in (
            (
                "double quote",
                self._replaced(
                    SKILLS_YAML, self.RECORD_A_GATE,
                    self.RECORD_A_GATE.replace('what: "fixture"', "what: " + self.OPEN + "fixture"),
                ),
            ),
            (
                "single quote",
                self._replaced(
                    SKILLS_YAML, self.RECORD_A_GATE,
                    self.RECORD_A_GATE.replace('what: "fixture"', "what: " + self.Q1 + "fixture"),
                ),
            ),
        ):
            with self.subTest(form=label):
                self._refused(self.QUOTE, skills=forged)

    def test_a_skills_id_that_opens_a_quote_is_refused(self):
        forged = self._replaced(
            SKILLS_YAML, "  - id: record-a-gate", "  - id: " + self.OPEN + "record-a-gate"
        )
        self._refused(self.QUOTE, skills=forged)

    def test_a_skills_top_level_value_that_opens_a_quote_is_refused(self):
        forged = self._replaced(SKILLS_YAML, 'version: "0.1.0"', 'version: "0.1.0')
        self._refused(self.QUOTE, skills=forged)

    def test_a_repeated_field_in_a_skill_entry_is_refused(self):
        forged = self._replaced(
            SKILLS_YAML, self.RECORD_A_GATE,
            self.RECORD_A_GATE + "    status: FORBIDDEN_TO_AGENTS" + NL,
        )
        self._refused(self.REPEAT, skills=forged)

    def test_a_repeated_top_level_section_in_skills_is_refused(self):
        """YAML keeps only the LAST `skills:` block, so the first one would be a decoy."""
        self._refused(self.REPEAT, skills=SKILLS_YAML + "skills:" + NL)

    def test_the_reviewers_K1_plant_in_skills_is_refused(self):
        """K1: PyYAML reads record-a-gate as AVAILABLE; the validator reads the last status."""
        forged = self._replaced(
            SKILLS_YAML, self.RECORD_A_GATE,
            "  - id: record-a-gate" + NL
            + "    status: AVAILABLE" + NL
            + "    what: " + self.OPEN + "Set a gate status" + NL
            + "    status: FORBIDDEN_TO_AGENTS" + NL
            + "    # " + self.OPEN + NL
            + '    authority_required: "the human role the gate names"' + NL,
        )
        result = self._run(skills=forged)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)

    # ---- badf/agents.yaml ---------------------------------------------------

    ARCHITECTURE = (
        "  - id: architecture-authority" + NL
        + '    owns: ["fixture"]' + NL
        + "    may_be_an_agent: false" + NL
        + "    held_by: null" + NL
    )
    GATES_ROUTE = (
        '  - path: "badf/gates.yaml"' + NL
        + "    owner: architecture-authority" + NL
        + "    verifier: repository-administrator" + NL
    )

    def test_a_role_field_that_opens_a_quote_it_does_not_close_is_refused(self):
        forged = self._replaced(
            AGENTS_YAML, self.ARCHITECTURE,
            self.ARCHITECTURE + "    note: " + self.OPEN + "Unfilled." + NL,
        )
        self._refused(self.QUOTE, agents=forged)

    def test_a_routing_field_that_opens_a_quote_it_does_not_close_is_refused(self):
        forged = self._replaced(
            AGENTS_YAML, self.GATES_ROUTE,
            self.GATES_ROUTE + "    note: " + self.Q1 + "reviewed" + NL,
        )
        self._refused(self.QUOTE, agents=forged)

    def test_a_role_id_that_opens_a_quote_is_refused(self):
        forged = self._replaced(
            AGENTS_YAML, "  - id: platform-engineer", "  - id: " + self.OPEN + "platform-engineer"
        )
        self._refused(self.QUOTE, agents=forged)

    def test_a_routing_path_that_opens_a_quote_is_refused(self):
        forged = self._replaced(
            AGENTS_YAML, '  - path: "badf/gates.yaml"', "  - path: " + self.OPEN + "badf/gates.yaml"
        )
        self._refused(self.QUOTE, agents=forged)

    def test_an_agents_top_level_value_that_opens_a_quote_is_refused(self):
        forged = self._replaced(AGENTS_YAML, 'version: "0.1.0"', 'version: "0.1.0')
        self._refused(self.QUOTE, agents=forged)

    def test_a_succession_value_that_opens_a_quote_is_refused(self):
        forged = self._replaced(AGENTS_YAML, "succession: >-", "succession: " + self.OPEN + "How")
        self._refused(self.QUOTE, agents=forged)

    def test_a_repeated_field_in_a_role_is_refused(self):
        forged = self._replaced(
            AGENTS_YAML, self.ARCHITECTURE, self.ARCHITECTURE + "    held_by: null" + NL
        )
        self._refused(self.REPEAT, agents=forged)

    def test_a_repeated_field_in_a_routing_entry_is_refused(self):
        forged = self._replaced(
            AGENTS_YAML, self.GATES_ROUTE, self.GATES_ROUTE + "    verifier: repository-administrator" + NL
        )
        self._refused(self.REPEAT, agents=forged)

    def test_a_repeated_top_level_section_in_agents_is_refused(self):
        """YAML keeps only the LAST `roles:` block, so the first one would be a decoy."""
        self._refused(self.REPEAT, agents=AGENTS_YAML + "roles:" + NL)

    def test_the_reviewers_A1_plant_in_agents_is_refused(self):
        """A1: PyYAML reads architecture-authority as agent-occupiable."""
        forged = self._replaced(
            AGENTS_YAML, self.ARCHITECTURE,
            "  - id: architecture-authority" + NL
            + '    owns: ["fixture"]' + NL
            + "    may_be_an_agent: true" + NL
            + "    note: " + self.OPEN + "Unfilled." + NL
            + "    may_be_an_agent: false" + NL
            + "    # " + self.OPEN + NL
            + "    held_by: null" + NL,
        )
        result = self._run(agents=forged)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)

    def test_a_well_formed_agents_flow_list_is_still_read(self):
        """`owns: ["a", "b"]` is how the shipped file writes it, and must keep passing."""
        forged = self._replaced(
            AGENTS_YAML, self.ARCHITECTURE,
            self.ARCHITECTURE.replace('["fixture"]', '["one", "it' + self.Q1 + 's two"]'),
        )
        result = self._run(agents=forged)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    # ---- badf/bootstrap.yaml and badf/signing-policy.yaml: the other readers -----

    def test_a_bootstrap_scalar_that_opens_a_quote_is_refused(self):
        forged = bootstrap_record(expiry=self.OPEN + "2999-01-01")
        self._refused(self.QUOTE, bootstrap=forged)

    def test_a_bootstrap_seating_field_that_opens_a_quote_is_refused(self):
        forged = self._replaced(
            bootstrap_record(), "    principal: null" + NL, "    principal: " + self.OPEN + "A Fixture Human" + NL
        )
        self._refused(self.QUOTE, bootstrap=forged)

    def test_a_bootstrap_seat_that_opens_a_quote_is_refused(self):
        forged = self._replaced(
            bootstrap_record(), "  - seat: repository-administrator", "  - seat: " + self.OPEN + "repository-administrator"
        )
        self._refused(self.QUOTE, bootstrap=forged)

    def test_a_repeated_scalar_in_the_bootstrap_record_is_refused(self):
        forged = self._replaced(
            bootstrap_record(), "expiry: null" + NL, "expiry: null" + NL + "expiry: null" + NL
        )
        self._refused(self.REPEAT, bootstrap=forged)

    def test_a_repeated_field_in_a_bootstrap_seating_is_refused(self):
        forged = self._replaced(
            bootstrap_record(), "    principal: null" + NL, "    principal: null" + NL + "    principal: null" + NL
        )
        self._refused(self.REPEAT, bootstrap=forged)

    def test_a_signing_policy_scalar_that_opens_a_quote_is_refused(self):
        forged = self._replaced(
            SIGNING_POLICY_YAML, "enforcement_point: FIRST_COMMIT_OF_THIS_POLICY",
            "enforcement_point: " + self.OPEN + "FIRST_COMMIT_OF_THIS_POLICY",
        )
        self._refused(self.QUOTE, signing_policy=forged)

    def test_a_repeated_scalar_in_the_signing_policy_is_refused(self):
        forged = self._replaced(
            SIGNING_POLICY_YAML, 'updated_at: "2026-01-01T00:00:00Z"' + NL,
            'updated_at: "2026-01-01T00:00:00Z"' + NL + 'updated_at: "2026-01-01T00:00:00Z"' + NL,
        )
        self._refused(self.REPEAT, signing_policy=forged)

    def test_a_signing_policy_path_that_opens_a_quote_is_refused(self):
        forged = self._replaced(SIGNING_POLICY_YAML, "  - schemas" + NL, "  - " + self.OPEN + "schemas" + NL)
        self._refused(self.QUOTE, signing_policy=forged)

    def test_a_signing_policy_accepted_keys_value_that_opens_a_quote_is_refused(self):
        forged = self._replaced(
            SIGNING_POLICY_YAML, "accepted_keys: NONE_ENROLLED", "accepted_keys: " + self.OPEN + "NONE_ENROLLED"
        )
        self._refused(self.QUOTE, signing_policy=forged)

    def test_a_signing_policy_key_identity_that_opens_a_quote_is_refused(self):
        forged = self._replaced(
            SIGNING_POLICY_WITH_KEY, '  - identity: "A Human <human@example.invalid>"',
            "  - identity: " + self.OPEN + "A Human <human@example.invalid>",
        )
        self._refused(self.QUOTE, signing_policy=forged)

    def test_a_signing_policy_key_field_that_opens_a_quote_is_refused(self):
        forged = self._replaced(SIGNING_POLICY_WITH_KEY, "    kind: gpg", "    kind: " + self.OPEN + "gpg")
        self._refused(self.QUOTE, signing_policy=forged)

    def test_a_repeated_field_in_a_signing_policy_key_is_refused(self):
        forged = self._replaced(SIGNING_POLICY_WITH_KEY, "    kind: gpg" + NL, "    kind: gpg" + NL + "    kind: gpg" + NL)
        self._refused(self.REPEAT, signing_policy=forged)

    # ---- badf/gates.yaml and badf/lifecycle.yaml ---------------------------------
    #
    # Both were read by patterns, and a pattern reader accepts anything it does
    # not match. A differential fuzz against PyYAML found the gates registry
    # taking `status:` with its value on the next line as no status at all
    # (PyYAML reads the LAST duplicate: a recorded gate) and a top-level key
    # inserted mid-list as harmless (PyYAML moves the rest of the list under
    # it). Both are now read by the same refusing grammar as their siblings.

    BT_G0 = "  - id: BT-G0" + NL + "    status: UNRECORDED" + NL
    ACCEPT = (
        "  - from: ENGINEERING_READY" + NL
        + "    to: ACCEPTED" + NL
        + '    role: "verifier, who is not the implementer"' + NL
        + "    requires_human: true" + NL
    )

    def test_a_gates_field_that_opens_a_quote_is_refused(self):
        forged = self._replaced(
            GATES_YAML, self.BT_G0, self.BT_G0 + "    name: " + self.OPEN + "x" + NL
        )
        self._refused(self.QUOTE, gates=forged)

    def test_a_gates_top_level_value_that_opens_a_quote_is_refused(self):
        forged = self._replaced(GATES_YAML, 'version: "0.1.0"', 'version: "0.1.0')
        self._refused(self.QUOTE, gates=forged)

    def test_a_gate_id_that_opens_a_quote_is_refused(self):
        forged = self._replaced(GATES_YAML, "  - id: BT-G0", "  - id: " + self.OPEN + "BT-G0")
        self._refused(self.QUOTE, gates=forged)

    def test_a_gate_status_repeated_with_its_value_on_the_next_line_is_refused(self):
        """The fuzz's find: `status:` with no value on its line was no status to the pattern."""
        forged = self._replaced(
            GATES_YAML, self.BT_G0, self.BT_G0 + "    status:" + NL + "      GRANTED" + NL
        )
        self._refused("'status' " + self.REPEAT, gates=forged)

    def test_a_gates_registry_split_by_a_top_level_key_is_refused(self):
        forged = self._replaced(
            GATES_YAML, "  - id: BT-G2" + NL, "forbidden:" + NL + "  - id: BT-G2" + NL
        )
        self._refused("unknown top-level key 'forbidden'", gates=forged)

    def test_a_gates_top_level_key_repeated_is_refused(self):
        self._refused("'delivery_gates' " + self.REPEAT, gates=GATES_YAML + "delivery_gates:" + NL)

    def test_a_gate_recorded_twice_is_refused(self):
        forged = GATES_YAML + "  - id: BT-G0" + NL + "    status: UNRECORDED" + NL
        self._refused("duplicate id 'BT-G0'", gates=forged)

    def test_a_gate_recorded_again_under_a_quoted_id_is_refused(self):
        """The fuzz's other find: "BT-G0" and BT-G0 are one id to YAML and two to a raw compare."""
        forged = GATES_YAML + "  - id: " + self.OPEN + "BT-G0" + self.OPEN + NL + "    status: UNRECORDED" + NL
        self._refused("duplicate id 'BT-G0'", gates=forged)

    def test_an_unknown_field_on_a_gate_is_refused(self):
        forged = self._replaced(
            GATES_YAML, self.BT_G0, self.BT_G0 + "    approved_by: nobody" + NL
        )
        self._refused("unknown field 'approved_by'", gates=forged)

    def test_a_gates_list_with_an_inline_value_is_refused(self):
        forged = self._replaced(GATES_YAML, "delivery_gates:", "delivery_gates: []")
        self._refused("inline value", gates=forged)

    def test_a_gates_entry_that_does_not_open_with_its_key_is_refused(self):
        forged = self._replaced(GATES_YAML, "  - id: BT-G1", "  - name: BT-G1")
        self._refused("must open with '- id:", gates=forged)

    def test_a_tab_in_the_gates_registry_is_refused(self):
        forged = self._replaced(GATES_YAML, "    status: UNRECORDED", "\tstatus: UNRECORDED")
        self._refused("contains a tab", gates=forged)

    def test_a_lifecycle_field_that_opens_a_quote_is_refused(self):
        forged = self._replaced(
            LIFECYCLE_YAML, self.ACCEPT, self.ACCEPT + "    condition: " + self.OPEN + "x" + NL
        )
        self._refused(self.QUOTE, lifecycle=forged)

    def test_a_lifecycle_list_item_that_opens_a_quote_is_refused(self):
        forged = LIFECYCLE_YAML + "  - " + self.OPEN + "Any transition" + NL
        self._refused(self.QUOTE, lifecycle=forged)

    def test_the_acceptance_transition_recorded_twice_is_refused(self):
        """A decoy first, the real requires_human: false second: PyYAML sees both."""
        forged = self._replaced(
            LIFECYCLE_YAML, self.ACCEPT,
            self.ACCEPT + "  - from: ENGINEERING_READY" + NL + "    to: ACCEPTED" + NL
            + '    role: "owner"' + NL + "    requires_human: false" + NL,
        )
        self._refused("more than once", lifecycle=forged)

    def test_requires_human_repeated_in_the_acceptance_transition_is_refused(self):
        forged = self._replaced(
            LIFECYCLE_YAML, self.ACCEPT, self.ACCEPT + "    requires_human: false" + NL
        )
        self._refused("'requires_human' " + self.REPEAT, lifecycle=forged)

    def test_the_forbidden_sentence_only_in_a_comment_is_not_the_forbidden_list(self):
        forged = self._replaced(
            LIFECYCLE_YAML,
            '  - "Any transition into ACCEPTED made by the implementing agent"' + NL,
            "  # Any transition into ACCEPTED made by the implementing agent" + NL,
        )
        self._refused("forbidden list", lifecycle=forged)

    def test_a_lifecycle_top_level_key_repeated_is_refused(self):
        self._refused("'forbidden' " + self.REPEAT, lifecycle=LIFECYCLE_YAML + "forbidden:" + NL)

    def test_an_unknown_top_level_key_in_the_lifecycle_registry_is_refused(self):
        self._refused("unknown top-level key 'shortcuts'", lifecycle=LIFECYCLE_YAML + "shortcuts:" + NL)


def load_validator():
    """The validator as a module, so a rule can be witnessed without a whole repository.

    Importing is safe: everything at module level is a constant or a function,
    and the entry point sits under `if __name__ == "__main__"`.
    """
    spec = importlib.util.spec_from_file_location("validate_continuity_under_test", VALIDATOR)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ScalarRefusalReadsOneLine(unittest.TestCase):
    """`scalar_refusal` branch by branch, each with a witness of its own.

    The registry-level tests above prove a refusal is CALLED; these prove what
    it refuses. They are separate so that loosening one branch turns exactly
    one control red rather than every quoted-value test at once.
    """

    D = chr(34)
    S = chr(39)
    BACKSLASH = chr(92)

    def setUp(self):
        self.refusal = load_validator().scalar_refusal

    def test_a_double_quoted_scalar_with_text_after_its_closing_quote_is_not_read_whole(self):
        self.assertIsNone(self.refusal(self.D + "it" + self.S + "s fine" + self.D))
        self.assertIsNone(
            self.refusal(self.D + "say " + self.BACKSLASH + self.D + "no" + self.BACKSLASH + self.D + self.D)
        )
        for value in (
            self.D + "a" + self.D + " b",
            self.D + "a" + self.D + " # per operator",
            self.D + "never closed",
            self.D + "closes only an escape" + self.BACKSLASH + self.D,
        ):
            with self.subTest(value=value):
                self.assertIn("not one complete quoted scalar", self.refusal(value) or "")

    def test_a_single_quoted_scalar_with_text_after_its_closing_quote_is_not_read_whole(self):
        self.assertIsNone(self.refusal(self.S + "it" + self.S * 2 + "s fine" + self.S))
        for value in (
            self.S + "a" + self.S + " b",
            self.S + "never closed",
            self.S + "an odd quote" + self.S * 2,
        ):
            with self.subTest(value=value):
                self.assertIn("not one complete quoted scalar", self.refusal(value) or "")

    def test_a_flow_collection_holding_an_unclosed_quote_is_not_read_whole(self):
        self.assertIsNone(self.refusal("[" + self.D + "one" + self.D + ", " + self.D + "it" + self.S + "s two" + self.D + "]"))
        self.assertIsNone(self.refusal("[it" + self.S + "s plain]"))
        for value in ("[" + self.D + "one]", "{a: " + self.S + "one}", "[" + self.D + "a" + self.D + ", " + self.D + "b]"):
            with self.subTest(value=value):
                self.assertIn("not one complete quoted scalar", self.refusal(value) or "")

    def test_a_flow_collection_that_does_not_close_on_its_line_is_not_read_whole(self):
        self.assertIsNone(self.refusal("[]"))
        self.assertIsNone(self.refusal("{a: b}"))
        for value in ("[a, b", "{a: b", "[a, b] # trailing", "{a: b}}x"):
            with self.subTest(value=value):
                self.assertIn("does not close on its line", self.refusal(value) or "")

    def test_an_anchor_an_alias_and_a_tag_are_not_read(self):
        for value in ("&pin GRANTED", "*pin", "!!str GRANTED"):
            with self.subTest(value=value):
                self.assertIn("anchor, an alias or a tag", self.refusal(value) or "")

    def test_a_plain_scalar_is_read(self):
        for value in ("", "GRANTED", "null", "true", "NOT_GRANTED # a comment is not the value's business", ">-"):
            with self.subTest(value=value):
                self.assertIsNone(self.refusal(value))


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
