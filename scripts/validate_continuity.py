#!/usr/bin/env python3
"""Continuity validation for the BizTrust platform repository.

Validates the three records under ``badf/`` and every session checkpoint
against ``schemas/*.schema.json``, and enforces the cross-record rules a schema
cannot express. Also confirms that the five ``badf/`` registries parse and
declare a version.

FAIL-CLOSED on malformed input. A wrong-typed field, an unreadable file or an
unforeseen exception always produces exactly one ``CONTINUITY_VALIDATION`` line
and a non-zero exit, never a traceback and silence, which reads as success.

The JSON Schema checker here is a stdlib subset. It REFUSES any keyword, or any
``format`` value, that it does not implement, so a schema edit cannot silently
go unenforced: an unimplemented keyword is a validator defect (exit 2), not a
quiet pass.

Exit codes:
    0    PASS - every check ran and none recorded an error
    1    FAIL - a data defect: the records under validation are wrong
    2    FAIL - a validator defect: this script cannot check what it was given
    130  FAIL - interrupted

A consumer that treats any non-zero as failure is correct; 1 and 2 differ so a
reader knows which artifact to debug.
"""

from __future__ import annotations

import json
import re
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMAS = ROOT / "schemas"
BADF = ROOT / "badf"
CHECKPOINTS = ROOT / "sessions" / "checkpoints"

RFC3339 = re.compile(
    r"^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$"
)

REGISTRIES = ("lifecycle.yaml", "authority.yaml", "gates.yaml", "agents.yaml", "skills.yaml")

# Every keyword this checker implements. A schema using anything else is a
# validator defect, not a data defect.
SUPPORTED = {
    "$schema", "$id", "title", "description", "type", "properties",
    "additionalProperties", "required", "items", "minItems", "minLength",
    "pattern", "enum", "minimum", "format",
}
SUPPORTED_FORMATS = {"date-time"}


class ValidatorDefect(Exception):
    """The schema asks for something this checker does not implement."""


def _type_ok(value, expected) -> bool:
    names = expected if isinstance(expected, list) else [expected]
    for name in names:
        if name == "object" and isinstance(value, dict):
            return True
        if name == "array" and isinstance(value, list):
            return True
        if name == "string" and isinstance(value, str):
            return True
        # bool is a subclass of int in Python; an integer field must not
        # accept True, and a boolean field must not accept 1.
        if name == "integer" and isinstance(value, int) and not isinstance(value, bool):
            return True
        if name == "number" and isinstance(value, (int, float)) and not isinstance(value, bool):
            return True
        if name == "boolean" and isinstance(value, bool):
            return True
        if name == "null" and value is None:
            return True
    return False


def check(value, schema: dict, path: str, errors: list[str]) -> None:
    """Validates ``value`` against ``schema``, appending human-readable errors."""
    if not isinstance(schema, dict):
        raise ValidatorDefect(f"{path}: schema is not an object")

    unknown = set(schema) - SUPPORTED
    if unknown:
        raise ValidatorDefect(
            f"{path}: schema uses keyword(s) this checker does not implement: "
            f"{', '.join(sorted(unknown))}"
        )

    if "type" in schema and not _type_ok(value, schema["type"]):
        errors.append(
            f"{path}: expected type {schema['type']}, found "
            f"{type(value).__name__}"
        )
        return

    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: {value!r} is not one of {schema['enum']}")
        return

    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            errors.append(f"{path}: shorter than minLength {schema['minLength']}")
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errors.append(f"{path}: {value!r} does not match {schema['pattern']}")
        if "format" in schema:
            fmt = schema["format"]
            if fmt not in SUPPORTED_FORMATS:
                raise ValidatorDefect(f"{path}: unimplemented format {fmt!r}")
            if fmt == "date-time" and not RFC3339.match(value):
                errors.append(f"{path}: {value!r} is not an RFC 3339 timestamp")

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{path}: below minimum {schema['minimum']}")

    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{path}: missing required field {key!r}")
        properties = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            for key in value:
                if key not in properties:
                    errors.append(f"{path}: unexpected field {key!r}")
        for key, sub in properties.items():
            if key in value:
                check(value[key], sub, f"{path}.{key}", errors)

    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            errors.append(f"{path}: fewer than minItems {schema['minItems']}")
        if "items" in schema:
            for index, item in enumerate(value):
                check(item, schema["items"], f"{path}[{index}]", errors)


def load_json(relative: str, errors: list[str]):
    """Reads a JSON file. A read or parse failure is a data defect."""
    path = ROOT / relative
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        # ValueError covers JSONDecodeError and UnicodeDecodeError; a single
        # bad byte must not abort the whole run.
        errors.append(f"{relative}: cannot load valid JSON: {exc}")
        return None


def load_schema(name: str):
    path = SCHEMAS / name
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValidatorDefect(f"schemas/{name}: cannot load: {exc}") from exc


def validate_records(errors: list[str]) -> None:
    state = load_json("badf/current-state.json", errors)
    actions = load_json("badf/next-actions.json", errors)

    if state is not None:
        check(state, load_schema("current-state.schema.json"), "badf/current-state.json", errors)
    if actions is not None:
        check(actions, load_schema("next-actions.schema.json"), "badf/next-actions.json", errors)

    # --- the decision log, one JSON object per line -------------------------
    decisions = []
    log = ROOT / "badf" / "decision-log.jsonl"
    try:
        lines = log.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        errors.append(f"badf/decision-log.jsonl: cannot read: {exc}")
        lines = []
    schema = load_schema("decision-record.schema.json")
    for number, line in enumerate(lines, start=1):
        if line.strip() == "":
            continue
        try:
            record = json.loads(line)
        except ValueError as exc:
            errors.append(f"badf/decision-log.jsonl line {number}: not valid JSON: {exc}")
            continue
        check(record, schema, f"badf/decision-log.jsonl line {number}", errors)
        decisions.append(record)

    # --- every committed checkpoint ----------------------------------------
    checkpoint_schema = load_schema("session-checkpoint.schema.json")
    checkpoints = sorted(CHECKPOINTS.glob("*.json")) if CHECKPOINTS.is_dir() else []
    if not checkpoints:
        errors.append("sessions/checkpoints/: no checkpoint is committed")
    for path in checkpoints:
        relative = path.relative_to(ROOT).as_posix()
        record = load_json(relative, errors)
        if record is not None:
            check(record, checkpoint_schema, relative, errors)

    # --- handoffs, if any ---------------------------------------------------
    handoff_dir = ROOT / "sessions" / "handoffs"
    if handoff_dir.is_dir():
        handoff_schema = load_schema("handoff.schema.json")
        for path in sorted(handoff_dir.glob("*.json")):
            relative = path.relative_to(ROOT).as_posix()
            record = load_json(relative, errors)
            if record is not None:
                check(record, handoff_schema, relative, errors)

    cross_record_rules(state, actions, decisions, errors)


def cross_record_rules(state, actions, decisions, errors: list[str]) -> None:
    """The rules a schema cannot express."""
    if isinstance(actions, dict) and isinstance(actions.get("actions"), list):
        items = [a for a in actions["actions"] if isinstance(a, dict)]

        primaries = [a for a in items if a.get("primary") is True]
        if len(primaries) != 1:
            errors.append(
                f"badf/next-actions.json: exactly one action must be primary, found {len(primaries)}"
            )

        priorities = sorted(a.get("priority") for a in items if isinstance(a.get("priority"), int))
        if priorities != list(range(1, len(items) + 1)):
            errors.append(
                f"badf/next-actions.json: priorities must run 1 to {len(items)} with no gap "
                f"and no repeat, found {priorities}"
            )

        ids = [a.get("id") for a in items]
        if len(set(ids)) != len(ids):
            errors.append("badf/next-actions.json: action ids are not unique")

        known = set(ids)
        for action in items:
            for blocker in action.get("blocked_by", []) or []:
                if blocker not in known:
                    errors.append(
                        f"badf/next-actions.json: action {action.get('id')} is blocked by "
                        f"{blocker!r}, which is not an action in this file"
                    )

        if isinstance(state, dict):
            named = state.get("primary_next_action_id")
            if primaries and primaries[0].get("id") != named:
                errors.append(
                    f"badf/current-state.json: primary_next_action_id is {named!r} but the "
                    f"primary action is {primaries[0].get('id')!r}"
                )
            state_wp = (state.get("active_work_package") or {}).get("id")
            if state_wp != actions.get("work_package"):
                errors.append(
                    f"one work package id must span both records: current-state says "
                    f"{state_wp!r}, next-actions says {actions.get('work_package')!r}"
                )

    if isinstance(state, dict):
        latest = state.get("latest_checkpoint")
        if latest is not None and not (ROOT / latest).is_file():
            errors.append(
                f"badf/current-state.json: latest_checkpoint {latest!r} does not exist"
            )
        latest_handoff = state.get("latest_handoff")
        if latest_handoff is not None and not (ROOT / latest_handoff).is_file():
            errors.append(
                f"badf/current-state.json: latest_handoff {latest_handoff!r} does not exist"
            )

    # Decision ids unique and ascending.
    numbers = []
    for record in decisions:
        identifier = record.get("id")
        if isinstance(identifier, str) and identifier.startswith("DEC-"):
            try:
                numbers.append(int(identifier[4:]))
            except ValueError:
                errors.append(f"badf/decision-log.jsonl: {identifier!r} has no numeric suffix")
    if len(set(numbers)) != len(numbers):
        errors.append("badf/decision-log.jsonl: decision ids are not unique")
    if numbers != sorted(numbers):
        errors.append("badf/decision-log.jsonl: decision ids are not ascending")


#: The only top-level sections badf/authority.yaml may carry.
AUTHORITY_SECTIONS = ("version", "updated_at", "not_granted", "granted", "tool_authority")

#: The only statuses a withheld entry may carry, and the only one a grant may.
#: A prefix test let `NOT_GRANTED_BUT_ACTUALLY_FINE_TO_PROCEED` through, and the
#: suffix is where a reader's conclusion actually lives.
WITHHELD_STATUSES = {"NOT_GRANTED", "NOT_RECORDED", "UNRECORDED"}
GRANTED_STATUSES = {"GRANTED"}

#: A grant either expires on a date or says in as many words that it does not.
UNBOUNDED = "UNBOUNDED_PENDING_REVIEW"

#: The one entry allowed to carry `recorded_by: agent`. Every other grant is a
#: human decision, and a human decision recorded by an agent is not one.
AGENT_RECORDABLE = "repository_scaffold"

#: Where the children of a refused section go, so one bad line is one error.
QUARANTINE = "__refused_section__"


def parse_authority(text: str) -> tuple[dict[str, dict[str, dict[str, str]]], list[str]]:
    """Reads badf/authority.yaml, refusing every line it cannot classify.

    This replaces a reader that SKIPPED what it did not recognise, and the
    difference is the whole point. Peer review round three defeated the earlier
    version three ways in one sitting, each of them ordinary, legal YAML:

        p0_implementation: {status: GRANTED, granted_by: "business authority"}

    was invisible, because an entry was required to have nothing after its
    colon, so the granted/not_granted overlap check never fired.
    `GRANTED_EXTRA:` was invisible, because the section pattern was
    `^[a-z0-9_]+:` and one uppercase letter matched nothing at all - no section
    opened, no unknown-section error fired, and its children were attributed to
    whatever section came before. A tab-indented block was invisible for the
    same reason. Each of those forged `p0_implementation`, the grant this whole
    repository exists to withhold, and `pnpm validate:records` returned exit 0.

    The lesson of round two was to invert the default rather than extend the
    list. Round three found that lesson written down in the records and NOT
    applied to the fix round two shipped: an allow-list of five section names
    sitting on top of a reader whose default was `continue`. So the default here
    is an error. A line that is not blank, not a comment and not one of the four
    shapes below is a problem, whatever it happens to look like.

    Returns {section: {entry: {field: value}}}.
    """
    sections: dict[str, dict[str, dict[str, str]]] = {}
    problems: list[str] = []
    section: str | None = None
    key: str | None = None
    block_indent: int | None = None

    for number, raw in enumerate(text.splitlines(), start=1):
        if raw.strip() == "" or raw.lstrip().startswith("#"):
            continue

        indent = len(raw) - len(raw.lstrip(" "))

        # A folded or literal scalar's body is anything indented past the field
        # that opened it. It is prose, and it is not read for meaning.
        if block_indent is not None:
            if indent >= block_indent:
                continue
            block_indent = None

        if "\t" in raw:
            problems.append(
                f"badf/authority.yaml line {number}: contains a tab; this file is "
                f"space-indented, and a tab made a whole block invisible to the "
                f"reader this one replaces"
            )
            continue

        if indent == 0:
            match = re.match(r"^(\S+):\s*(.*)$", raw)
            if match is None:
                problems.append(
                    f"badf/authority.yaml line {number}: neither a top-level key nor "
                    f"indented under one: {raw.strip()!r}"
                )
                continue
            section, rest = match.group(1), match.group(2).strip()
            key = None
            if section not in AUTHORITY_SECTIONS:
                problems.append(
                    f"badf/authority.yaml line {number}: unknown top-level section "
                    f"{section!r}; a section nothing validates is where a forged "
                    f"grant lives"
                )
                # The section is already refused. Park its children somewhere
                # harmless so each one does not raise a second, vaguer error.
                section = QUARANTINE
                sections.setdefault(section, {})
                continue
            sections.setdefault(section, {})
            if rest and section not in ("version", "updated_at"):
                problems.append(
                    f"badf/authority.yaml line {number}: section {section!r} carries "
                    f"an inline value; its entries must be written as a block"
                )
            continue

        if section is None:
            problems.append(
                f"badf/authority.yaml line {number}: indented content before any "
                f"section: {raw.strip()!r}"
            )
            continue

        if indent == 2:
            match = re.match(r"^ {2}(\S+):\s*(.*)$", raw)
            if match is None:
                problems.append(
                    f"badf/authority.yaml line {number}: not an entry under "
                    f"{section!r}: {raw.strip()!r}"
                )
                continue
            key, rest = match.group(1), match.group(2).strip()
            sections[section].setdefault(key, {})
            if rest:
                problems.append(
                    f"badf/authority.yaml line {number}: entry {section}.{key} carries "
                    f"the inline value {rest!r}. A flow-style mapping written exactly "
                    f"this way forged a grant the previous reader could not see"
                )
            continue

        if indent == 4:
            if raw.lstrip().startswith("- "):
                if section != "tool_authority":
                    problems.append(
                        f"badf/authority.yaml line {number}: a list item under "
                        f"{section!r}, which takes named fields, not a list"
                    )
                continue
            match = re.match(r"^ {4}(\S+):\s*(.*)$", raw)
            if match is None or key is None:
                problems.append(
                    f"badf/authority.yaml line {number}: not a field of an entry: "
                    f"{raw.strip()!r}"
                )
                continue
            field, value = match.group(1), match.group(2).strip()
            if value in (">", ">-", "|", "|-", ""):
                block_indent = 6
                value = ""
            sections[section][key][field] = value
            continue

        problems.append(
            f"badf/authority.yaml line {number}: indented {indent} spaces, which is "
            f"neither a section, an entry nor a field: {raw.strip()!r}"
        )

    return sections, problems


def validate_registries(errors: list[str]) -> None:
    """The five registries must exist, be non-empty and declare a version."""
    for name in REGISTRIES:
        path = BADF / name
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:
            errors.append(f"badf/{name}: cannot read: {exc}")
            continue
        if text.strip() == "":
            errors.append(f"badf/{name}: is empty")
            continue
        if not re.search(r"^version:\s*\S+", text, re.MULTILINE):
            errors.append(f"badf/{name}: declares no version")


def _expiry_problem(key: str, entry: dict[str, str], now: str) -> str | None:
    """An expiring grant that never expires is a grant.

    AGENTS.md section 5 makes the EXPIRING implementation grant the entire
    mechanism for implementation authority, and section 11 makes expired
    authority a stop condition. Peer review round three asked what enforced
    `expires_at` and the answer was nothing at all: back-dating it to 2020 and
    widening `scope_limit` to cover every P0 epic passed with exit 0. The
    checkpoint declared that gap honestly, but a declared gap in the one field
    that separates "an expiring grant" from "a grant" is load-bearing.
    """
    expires = entry.get("expires_at", "").strip().strip('"')
    if expires == "":
        return f"badf/authority.yaml: granted.{key} records no expires_at"
    if expires == UNBOUNDED:
        return None
    if not re.match(r"^\d{4}-\d{2}-\d{2}", expires):
        return (
            f"badf/authority.yaml: granted.{key} has expires_at {expires!r}, which is "
            f"neither a date nor the literal {UNBOUNDED}"
        )
    if expires[:10] < now[:10]:
        return (
            f"badf/authority.yaml: granted.{key} expired on {expires[:10]}, and the "
            f"records were updated on {now[:10]}. An expired grant is a stop "
            f"condition (AGENTS.md section 11), not a live one"
        )
    return None


def validate_authority_registry(state, errors: list[str]) -> None:
    """The authority REGISTRY, and its agreement with the state file.

    ``badf/authority.yaml`` is the source of record: the P0.2 design calls it
    the place a Work Package's implementation grant, with its expiry, is
    recorded before any code lands. Round two hardened its MIRROR in
    ``current-state.json`` and checked the source for nothing but a ``version:``
    line. Round three then showed the relation was one-directional as well as
    thin: only keys the state file already named were examined, so a grant ADDED
    to the registry agreed with nothing and passed. The relation below is total
    in both directions, which is what makes the schema enum on the state side
    actually cost something.
    """
    try:
        text = (BADF / "authority.yaml").read_text(encoding="utf-8")
    except OSError as exc:
        errors.append(f"badf/authority.yaml: cannot read: {exc}")
        return

    sections, problems = parse_authority(text)
    errors.extend(problems)

    not_granted = sections.get("not_granted", {})
    granted = sections.get("granted", {})

    if not not_granted:
        errors.append("badf/authority.yaml: has no not_granted section")
    if not granted:
        errors.append("badf/authority.yaml: has no granted section")

    for key in sorted(set(not_granted) & set(granted)):
        errors.append(
            f"badf/authority.yaml: {key!r} appears under both granted and "
            f"not_granted; one of them is a lie"
        )

    now = ""
    if isinstance(state, dict):
        now = str(state.get("updated_at") or "")

    # Every entry carries a status, and the status comes from a closed set. An
    # entry with NO status line used to count as a recorded grant, because
    # membership was established by the key alone.
    for section_name, allowed in (("not_granted", WITHHELD_STATUSES), ("granted", GRANTED_STATUSES)):
        for key, entry in sorted(sections.get(section_name, {}).items()):
            status = entry.get("status", "").strip().strip('"')
            if status == "":
                errors.append(
                    f"badf/authority.yaml: {section_name}.{key} records no status; an "
                    f"entry with no status used to count as a recorded grant"
                )
                continue
            if status not in allowed:
                errors.append(
                    f"badf/authority.yaml: {section_name}.{key} has status {status!r}, "
                    f"which is not one of {sorted(allowed)}"
                )

    for key, entry in sorted(granted.items()):
        problem = _expiry_problem(key, entry, now)
        if problem is not None:
            errors.append(problem)
        recorded_by = entry.get("recorded_by", "").strip().strip('"')
        if recorded_by == "":
            errors.append(
                f"badf/authority.yaml: granted.{key} records no recorded_by. Leaving "
                f"the field out was a way to avoid the rule below without stating "
                f"anything untrue"
            )
        if entry.get("granted_by", "").strip().strip('"') == "":
            errors.append(
                f"badf/authority.yaml: granted.{key} records no granted_by, so no seat "
                f"is named as having decided it"
            )
        if recorded_by == "agent" and key != AGENT_RECORDABLE:
            errors.append(
                f"badf/authority.yaml: granted.{key} is recorded_by \"agent\". Only "
                f"{AGENT_RECORDABLE!r} may be, because it records an operator "
                f"instruction rather than a seat's decision. Every other grant is a "
                f"human decision, and a human decision recorded by an agent is not one"
            )

    if not isinstance(state, dict):
        return
    authority = state.get("authority")
    if not isinstance(authority, dict):
        return

    # Direction one: the state file may not name what the registry does not record.
    for key, value in sorted(authority.items()):
        in_not_granted = key in not_granted
        in_granted = key in granted
        if not in_not_granted and not in_granted:
            errors.append(
                f"badf/current-state.json: authority.{key} has no entry in "
                f"badf/authority.yaml, so the state file asserts something the "
                f"registry does not record"
            )
            continue
        withheld = isinstance(value, str) and value.startswith(("NOT_", "REVISION_REQUIRED"))
        if in_not_granted and not withheld:
            errors.append(
                f"authority.{key}: badf/authority.yaml records it under not_granted "
                f"but badf/current-state.json says {value!r}"
            )
        if in_granted and withheld:
            errors.append(
                f"authority.{key}: badf/authority.yaml records it under granted "
                f"but badf/current-state.json says {value!r}"
            )

    # Direction two, the half round three walked through. A grant present only
    # in the registry answered to nothing, so adding one cost a single edit to a
    # data file. It now requires the schema-pinned enum on the state side too.
    for section_name in ("granted", "not_granted"):
        for key in sorted(sections.get(section_name, {})):
            if key not in authority:
                errors.append(
                    f"badf/authority.yaml: {section_name}.{key} has no matching key in "
                    f"badf/current-state.json authority, so it is recorded in the "
                    f"registry while the schema-pinned mirror never sees it"
                )


#: The closed set of statuses a skill entry in badf/skills.yaml may declare.
SKILL_STATUSES = {"AVAILABLE", "BLOCKED", "FORBIDDEN_TO_AGENTS"}

#: These two skills grant or record authority. AGENTS.md section 4 makes a
#: gate result and an authority grant human decisions, never inferred and
#: never an agent's to set, whatever the registry's prose column says.
FORBIDDEN_TO_AGENTS_SKILLS = ("record-a-gate", "grant-authority")

#: The fields a skill entry may carry. Unknown to this set is refused, not
#: skipped, in the same doctrine parse_authority documents at length: a
#: capability registry with a status a reader silently skips is a capability
#: an agent can set to AVAILABLE with nothing objecting.
SKILL_FIELDS = {"what", "authority_required", "status", "why", "note"}


def parse_skills(text: str) -> tuple[dict[str, dict[str, str]], list[str]]:
    """Reads badf/skills.yaml, refusing every line it cannot classify.

    Same doctrine as parse_authority below: the default is an error. Returns
    {skill_id: {field: value}}.
    """
    entries: dict[str, dict[str, str]] = {}
    problems: list[str] = []
    in_skills = False
    current: str | None = None
    block_indent: int | None = None

    for number, raw in enumerate(text.splitlines(), start=1):
        if raw.strip() == "" or raw.lstrip().startswith("#"):
            continue

        indent = len(raw) - len(raw.lstrip(" "))

        if block_indent is not None:
            if indent >= block_indent:
                continue
            block_indent = None

        if "\t" in raw:
            problems.append(
                f"badf/skills.yaml line {number}: contains a tab; this file is "
                f"space-indented"
            )
            continue

        if indent == 0:
            match = re.match(r"^(\S+):\s*(.*)$", raw)
            if match is None:
                problems.append(
                    f"badf/skills.yaml line {number}: neither a top-level key nor "
                    f"indented under one: {raw.strip()!r}"
                )
                continue
            key, rest = match.group(1), match.group(2).strip()
            current = None
            if key == "skills":
                if rest != "":
                    problems.append(
                        f"badf/skills.yaml line {number}: 'skills' carries an "
                        f"inline value; its entries must be written as a block"
                    )
                in_skills = True
                continue
            if key in ("version", "updated_at"):
                in_skills = False
                continue
            problems.append(
                f"badf/skills.yaml line {number}: unknown top-level key {key!r}"
            )
            in_skills = False
            continue

        if not in_skills:
            problems.append(
                f"badf/skills.yaml line {number}: indented content outside the "
                f"skills: block: {raw.strip()!r}"
            )
            continue

        if indent == 2:
            match = re.match(r"^ {2}- id:\s*(\S.*)$", raw)
            if match is None:
                problems.append(
                    f"badf/skills.yaml line {number}: a skill entry must open "
                    f"with '- id: <value>': {raw.strip()!r}"
                )
                current = None
                continue
            current = match.group(1).strip()
            if current in entries:
                problems.append(
                    f"badf/skills.yaml line {number}: duplicate skill id "
                    f"{current!r}"
                )
            entries.setdefault(current, {})
            continue

        if indent == 4:
            if current is None:
                problems.append(
                    f"badf/skills.yaml line {number}: a field outside any skill "
                    f"entry: {raw.strip()!r}"
                )
                continue
            match = re.match(r"^ {4}(\S+):\s*(.*)$", raw)
            if match is None:
                problems.append(
                    f"badf/skills.yaml line {number}: not a field of a skill "
                    f"entry: {raw.strip()!r}"
                )
                continue
            field, value = match.group(1), match.group(2).strip()
            if field not in SKILL_FIELDS:
                problems.append(
                    f"badf/skills.yaml line {number}: unknown field {field!r} on "
                    f"skill {current!r}"
                )
                continue
            if value in (">", ">-", "|", "|-", ""):
                block_indent = 6
                value = ""
            entries[current][field] = value
            continue

        problems.append(
            f"badf/skills.yaml line {number}: indented {indent} spaces, which is "
            f"neither an entry nor a field: {raw.strip()!r}"
        )

    return entries, problems


def validate_skills_registry(errors: list[str]) -> None:
    """The capability registry: statuses from a closed set, with the two
    authority-shaped skills pinned FORBIDDEN_TO_AGENTS.

    badf/skills.yaml was validated for existence, non-emptiness and a
    version: line only (validate_registries above). Nothing stopped an agent
    setting record-a-gate or grant-authority to AVAILABLE: the registry lists
    what a skill claims to need, but the claim is prose an agent could edit to
    say anything at all, and nothing read the status column.
    """
    try:
        text = (BADF / "skills.yaml").read_text(encoding="utf-8")
    except OSError as exc:
        errors.append(f"badf/skills.yaml: cannot read: {exc}")
        return

    entries, problems = parse_skills(text)
    errors.extend(problems)

    if not entries:
        errors.append("badf/skills.yaml: no skill is recorded")

    for skill_id, entry in sorted(entries.items()):
        status = entry.get("status", "").strip().strip('"')
        if status == "":
            errors.append(f"badf/skills.yaml: {skill_id} records no status")
            continue
        if status not in SKILL_STATUSES:
            errors.append(
                f"badf/skills.yaml: {skill_id} has status {status!r}, which is "
                f"not one of {sorted(SKILL_STATUSES)}"
            )

    for skill_id in FORBIDDEN_TO_AGENTS_SKILLS:
        if skill_id not in entries:
            errors.append(
                f"badf/skills.yaml: {skill_id!r} is missing, so its "
                f"FORBIDDEN_TO_AGENTS pin cannot be checked. Deleting a skill is "
                f"how a forbidden capability stops being forbidden without "
                f"anyone recording that"
            )
            continue
        status = entries[skill_id].get("status", "").strip().strip('"')
        if status != "FORBIDDEN_TO_AGENTS":
            errors.append(
                f"badf/skills.yaml: {skill_id} has status {status!r}. "
                f"AGENTS.md section 4 makes this a human decision, so it is "
                f"pinned FORBIDDEN_TO_AGENTS and cannot become AVAILABLE from "
                f"a data edit"
            )


#: The four seats badf/authority.yaml and AGENTS.md section 4 name as
#: human-only. An agent may occupy every other seat for a Work Package, never
#: these, and never the verifier seat for its own work.
AGENT_FORBIDDEN_ROLES = (
    "architecture-authority",
    "business-authority",
    "repository-administrator",
    "legal-compliance-reviewer",
)

ROLE_FIELDS = {"owns", "may_be_an_agent", "note", "held_by"}
ROUTING_FIELDS = {"owner", "verifier", "note"}
BOOLEAN_LITERALS = {"true", "false"}


def parse_agents(
    text: str,
) -> tuple[dict[str, dict[str, str]], list[dict[str, str]], list[str]]:
    """Reads badf/agents.yaml, refusing every line it cannot classify.

    Same doctrine as parse_authority and parse_skills: the default is an
    error, not a skip. Returns (roles, routing, problems):

        roles   {role_id: {field: value}}
        routing [{field: value}, ...] in file order, each carrying "path"
    """
    roles: dict[str, dict[str, str]] = {}
    routing: list[dict[str, str]] = []
    problems: list[str] = []
    section: str | None = None  # "roles" or "routing" once opened
    current_role: str | None = None
    current_route: dict[str, str] | None = None
    block_indent: int | None = None

    for number, raw in enumerate(text.splitlines(), start=1):
        if raw.strip() == "" or raw.lstrip().startswith("#"):
            continue

        indent = len(raw) - len(raw.lstrip(" "))

        if block_indent is not None:
            if indent >= block_indent:
                continue
            block_indent = None

        if "\t" in raw:
            problems.append(
                f"badf/agents.yaml line {number}: contains a tab; this file is "
                f"space-indented"
            )
            continue

        if indent == 0:
            match = re.match(r"^(\S+):\s*(.*)$", raw)
            if match is None:
                problems.append(
                    f"badf/agents.yaml line {number}: neither a top-level key "
                    f"nor indented under one: {raw.strip()!r}"
                )
                continue
            key, rest = match.group(1), match.group(2).strip()
            current_role = None
            current_route = None
            if key == "roles":
                if rest != "":
                    problems.append(
                        f"badf/agents.yaml line {number}: 'roles' carries an "
                        f"inline value; its entries must be written as a block"
                    )
                section = "roles"
                continue
            if key == "routing":
                if rest != "":
                    problems.append(
                        f"badf/agents.yaml line {number}: 'routing' carries an "
                        f"inline value; its entries must be written as a block"
                    )
                section = "routing"
                continue
            if key in ("version", "updated_at"):
                section = None
                continue
            problems.append(
                f"badf/agents.yaml line {number}: unknown top-level key {key!r}"
            )
            section = None
            continue

        if section is None:
            problems.append(
                f"badf/agents.yaml line {number}: indented content outside "
                f"roles: or routing:: {raw.strip()!r}"
            )
            continue

        if indent == 2:
            if section == "roles":
                match = re.match(r"^ {2}- id:\s*(\S.*)$", raw)
                if match is None:
                    problems.append(
                        f"badf/agents.yaml line {number}: a role entry must "
                        f"open with '- id: <value>': {raw.strip()!r}"
                    )
                    current_role = None
                    continue
                current_role = match.group(1).strip()
                if current_role in roles:
                    problems.append(
                        f"badf/agents.yaml line {number}: duplicate role id "
                        f"{current_role!r}"
                    )
                roles.setdefault(current_role, {})
            else:
                match = re.match(r"^ {2}- path:\s*(\S.*)$", raw)
                if match is None:
                    problems.append(
                        f"badf/agents.yaml line {number}: a routing entry must "
                        f"open with '- path: <value>': {raw.strip()!r}"
                    )
                    current_route = None
                    continue
                current_route = {"path": match.group(1).strip()}
                routing.append(current_route)
            continue

        if indent == 4:
            match = re.match(r"^ {4}(\S+):\s*(.*)$", raw)
            if match is None:
                problems.append(
                    f"badf/agents.yaml line {number}: not a field of an entry: "
                    f"{raw.strip()!r}"
                )
                continue
            field, value = match.group(1), match.group(2).strip()
            if section == "roles":
                if current_role is None:
                    problems.append(
                        f"badf/agents.yaml line {number}: a field outside any "
                        f"role entry: {raw.strip()!r}"
                    )
                    continue
                if field not in ROLE_FIELDS:
                    problems.append(
                        f"badf/agents.yaml line {number}: unknown field "
                        f"{field!r} on role {current_role!r}"
                    )
                    continue
                if value in (">", ">-", "|", "|-", ""):
                    block_indent = 6
                    value = ""
                roles[current_role][field] = value
            else:
                if current_route is None:
                    problems.append(
                        f"badf/agents.yaml line {number}: a field outside any "
                        f"routing entry: {raw.strip()!r}"
                    )
                    continue
                if field not in ROUTING_FIELDS:
                    problems.append(
                        f"badf/agents.yaml line {number}: unknown field "
                        f"{field!r} on a routing entry"
                    )
                    continue
                if value in (">", ">-", "|", "|-", ""):
                    block_indent = 6
                    value = ""
                current_route[field] = value
            continue

        problems.append(
            f"badf/agents.yaml line {number}: indented {indent} spaces, which "
            f"is neither a section, an entry nor a field: {raw.strip()!r}"
        )

    return roles, routing, problems


def validate_agents_registry(errors: list[str]) -> None:
    """The role registry: may_be_an_agent pinned for the four human seats, and
    every role recording a held_by field so NS-001's acceptance ("a named
    human holds the seat") has somewhere in this registry to be recorded.

    badf/agents.yaml was validated for existence, non-emptiness and a
    version: line only. Nothing stopped an agent flipping may_be_an_agent to
    true on all four authority seats, and no field could record who holds one
    even honestly, so NS-001's acceptance criterion could not be recorded in
    the record it names. held_by defaults to null on every seat here: filling
    one is a human act this validator does not perform and does not pin.
    """
    try:
        text = (BADF / "agents.yaml").read_text(encoding="utf-8")
    except OSError as exc:
        errors.append(f"badf/agents.yaml: cannot read: {exc}")
        return

    roles, routing, problems = parse_agents(text)
    errors.extend(problems)

    if not roles:
        errors.append("badf/agents.yaml: no role is recorded")
    if not routing:
        errors.append("badf/agents.yaml: no routing entry is recorded")

    for role_id, entry in sorted(roles.items()):
        may_be_agent = entry.get("may_be_an_agent", "").strip().strip('"')
        if may_be_agent == "":
            errors.append(
                f"badf/agents.yaml: role {role_id} records no may_be_an_agent"
            )
        elif may_be_agent not in BOOLEAN_LITERALS:
            errors.append(
                f"badf/agents.yaml: role {role_id} has may_be_an_agent "
                f"{may_be_agent!r}, which is neither true nor false"
            )
        if "held_by" not in entry:
            errors.append(
                f"badf/agents.yaml: role {role_id} records no held_by field, "
                f"so NS-001's acceptance (\"a named human holds the seat\") "
                f"has nowhere in this registry to be recorded"
            )

    for role_id in AGENT_FORBIDDEN_ROLES:
        if role_id not in roles:
            errors.append(
                f"badf/agents.yaml: role {role_id!r} is missing, so its "
                f"may_be_an_agent pin cannot be checked. Deleting a role is "
                f"how a human-only seat stops being human-only without anyone "
                f"recording that"
            )
            continue
        may_be_agent = roles[role_id].get("may_be_an_agent", "").strip().strip('"')
        if may_be_agent != "false":
            errors.append(
                f"badf/agents.yaml: role {role_id} has may_be_an_agent "
                f"{may_be_agent!r}. This is a human-only seat and it is "
                f"pinned false; AGENTS.md section 4 and badf/authority.yaml "
                f"record why"
            )

    for index, route in enumerate(routing, start=1):
        for field in ("path", "owner", "verifier"):
            if field not in route or route[field].strip() == "":
                errors.append(
                    f"badf/agents.yaml: routing entry {index} records no "
                    f"{field}"
                )


#: The delivery gates, and the states no agent may move a Work Package into
#: without a recorded acceptance by someone who is not its implementer.
DELIVERY_GATES = ("BT-G0", "BT-G1", "BT-G2", "BT-G3", "BT-G4")
TERMINAL_STATES = ("ACCEPTED", "CLOSED")


def validate_gates_registry(state, errors: list[str]) -> None:
    """The gate REGISTRY, and its agreement with the state file.

    Round one pinned the ``gates`` block of ``current-state.json`` to
    ``UNRECORDED`` in the schema. Round three found the registry that block
    mirrors - and which AGENTS.md section 4 names as the source of truth for
    gate results, not the state file - validated for a ``version:`` line and
    nothing else. Setting every gate to ``PASSED`` passed. Deleting the whole
    ``delivery_gates:`` section passed. Recording BT-G0 in the registry while
    the mirror still read UNRECORDED passed, which is the worse case: the
    AUTHORITATIVE copy was the unvalidated one.

    Requiring the two to agree makes recording a gate a change to a schema file,
    because the state side is enum-pinned. That is what an authority record
    should cost, and it is the same mechanism DEC-007 chose one file over.
    """
    try:
        text = (BADF / "gates.yaml").read_text(encoding="utf-8")
    except OSError as exc:
        errors.append(f"badf/gates.yaml: cannot read: {exc}")
        return

    recorded: dict[str, str] = {}
    current: str | None = None
    for number, raw in enumerate(text.splitlines(), start=1):
        identifier = re.match(r"^\s*-\s+id:\s*(\S+)\s*$", raw)
        if identifier is not None:
            current = identifier.group(1)
            continue
        status = re.match(r"^\s*status:\s*(\S+)\s*$", raw)
        if status is not None and current is not None:
            if current in recorded:
                errors.append(
                    f"badf/gates.yaml line {number}: {current} carries a second status"
                )
            recorded[current] = status.group(1)

    for gate in DELIVERY_GATES:
        if gate not in recorded:
            errors.append(
                f"badf/gates.yaml: {gate} is missing, or carries no status. Deleting a "
                f"gate is how a gate stops being unrecorded without anyone recording it"
            )

    if not isinstance(state, dict):
        return
    gates = state.get("gates")
    if not isinstance(gates, dict):
        return

    for gate in DELIVERY_GATES:
        in_registry = recorded.get(gate)
        in_state = gates.get(gate)
        if in_registry is None or in_state is None:
            continue
        if in_registry != in_state:
            errors.append(
                f"{gate}: badf/gates.yaml says {in_registry!r} and "
                f"badf/current-state.json says {in_state!r}. AGENTS.md section 4 makes "
                f"the registry authoritative, so the two disagreeing means the "
                f"authoritative copy is the one nothing checks"
            )


def validate_acceptance_is_not_self_awarded(state, errors: list[str]) -> None:
    """A Work Package cannot accept itself.

    ``badf/lifecycle.yaml`` records ``ENGINEERING_READY -> ACCEPTED`` as
    ``requires_human: true``, with the role "verifier, who is not the
    implementer", and forbids "any transition into ACCEPTED made by the
    implementing agent". No code path read that file. Round three set the work
    package state to ACCEPTED, ``resume_decision`` to COMPLETE and the
    checkpoint to ACCEPTED, left the authority registry untouched, and the
    validator returned exit 0 - then did it again with all three records made
    mutually consistent and a forged grant, and got exit 0 again.

    So the state now has to be paid for out of the authority record, which the
    schema pins and which the registry cross-check above makes total.
    """
    if not isinstance(state, dict):
        return
    package = state.get("active_work_package")
    if not isinstance(package, dict):
        return
    package_state = package.get("state")
    if package_state not in TERMINAL_STATES:
        return

    identifier = str(package.get("id") or "")
    match = re.match(r"^BIZTRUST-WP-(\d{3})$", identifier)
    if match is None:
        errors.append(
            f"badf/current-state.json: work package id {identifier!r} is not a shape "
            f"this check can bind an acceptance grant to"
        )
        return
    key = f"wp_{match.group(1)}_acceptance"

    authority = state.get("authority")
    value = authority.get(key) if isinstance(authority, dict) else None
    if value != "ACCEPTED_BY_INDEPENDENT_VERIFIER":
        errors.append(
            f"badf/current-state.json: active_work_package.state is {package_state!r} "
            f"while authority.{key} is {value!r}. badf/lifecycle.yaml records this "
            f"transition as requires_human with the role \"verifier, who is not the "
            f"implementer\", so the state may not run ahead of the acceptance record"
        )
        return

    try:
        text = (BADF / "authority.yaml").read_text(encoding="utf-8")
    except OSError:
        return
    sections, _ = parse_authority(text)
    if key not in sections.get("granted", {}):
        errors.append(
            f"badf/authority.yaml: the state file records {key} as accepted, but the "
            f"registry does not record it under granted:"
        )


def validate_lifecycle_pins(errors: list[str]) -> None:
    """The acceptance transition stays human, and stays forbidden to the builder.

    A rule an agent can edit is a rule an agent does not have. Round three
    rewrote this transition to ``requires_human: false`` with role "owner",
    deleted the matching ``forbidden:`` line, and the validator passed. This
    pins only the two statements the acceptance check above depends on; the rest
    of the registry is recorded as non-coverage rather than silently trusted.
    """
    try:
        text = (BADF / "lifecycle.yaml").read_text(encoding="utf-8")
    except OSError as exc:
        errors.append(f"badf/lifecycle.yaml: cannot read: {exc}")
        return

    transition = re.search(
        r"-\s+from:\s*ENGINEERING_READY\s*\n\s*to:\s*ACCEPTED\s*\n"
        r"\s*role:\s*(?P<role>.+?)\s*\n\s*requires_human:\s*(?P<human>\S+)",
        text,
    )
    if transition is None:
        errors.append(
            "badf/lifecycle.yaml: records no ENGINEERING_READY -> ACCEPTED transition; "
            "the acceptance check has nothing to stand on"
        )
        return
    if transition.group("human").strip() != "true":
        errors.append(
            "badf/lifecycle.yaml: ENGINEERING_READY -> ACCEPTED is recorded as "
            "requires_human: "
            f"{transition.group('human')!r}. Only a human accepts work (AGENTS.md "
            "section 5)"
        )
    if "not the implementer" not in transition.group("role"):
        errors.append(
            "badf/lifecycle.yaml: the ENGINEERING_READY -> ACCEPTED role no longer "
            "excludes the implementer"
        )
    if "Any transition into ACCEPTED made by the implementing agent" not in text:
        errors.append(
            "badf/lifecycle.yaml: the forbidden list no longer refuses a transition "
            "into ACCEPTED made by the implementing agent"
        )


def validate_checkpoint_agrees(state, errors: list[str]) -> None:
    """The checkpoint the state file points at must describe the same work.

    Round three wrote a checkpoint naming a branch that does not exist, a
    baseline commit of `deadbeef...`, files that are not files, a command that
    was never run, and the state CLOSED - and it validated, because conforming
    to the schema was the whole test. These three agreements are cheap and
    catch the case that matters: a checkpoint claiming a state or a package the
    records do not.
    """
    if not isinstance(state, dict):
        return
    relative_path = state.get("latest_checkpoint")
    if not isinstance(relative_path, str):
        return
    checkpoint = load_json(relative_path, [])
    if not isinstance(checkpoint, dict):
        return
    package = state.get("active_work_package")
    if not isinstance(package, dict):
        return

    for field, expected, where in (
        ("work_package", package.get("id"), "active_work_package.id"),
        ("state", package.get("state"), "active_work_package.state"),
        ("branch", (state.get("source") or {}).get("branch"), "source.branch"),
    ):
        actual = checkpoint.get(field)
        if actual != expected:
            errors.append(
                f"{relative_path}: {field} is {actual!r} but badf/current-state.json "
                f"{where} is {expected!r}"
            )


def validate_no_secrets(errors: list[str]) -> None:
    """AGENTS.md section 5: no secret, token or credential in this repository."""
    # No leading \b. Scanning bytes means a token can sit next to a byte that
    # Unicode considers a word character, and a word boundary there does not
    # match: the credential is present and the scan says nothing. A secret does
    # not stop being a secret because of the byte in front of it.
    patterns = [
        (re.compile(r"ghp_[A-Za-z0-9]{20,}"), "a GitHub personal access token"),
        (re.compile(r"gho_[A-Za-z0-9]{20,}"), "a GitHub OAuth token"),
        (re.compile(r"github_pat_[A-Za-z0-9_]{20,}"), "a GitHub fine-grained token"),
        (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"), "a private key"),
        (re.compile(r"AKIA[0-9A-Z]{16}"), "an AWS access key id"),
        (re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}"), "a Slack token"),
    ]
    # Build output and dependencies are not repository content. Everything else
    # is scanned, binaries included.
    skip_prefixes = (".git/", "node_modules/", "dist/", ".pnpm-store/")
    skip_segments = ("__pycache__",)
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(ROOT).as_posix()
        if relative.startswith(skip_prefixes):
            continue
        if any(segment in relative.split("/") for segment in skip_segments):
            continue
        if relative == "scripts/validate_continuity.py":
            continue  # this file names the patterns it searches for
        # Read BYTES, not text. Skipping anything that is not valid UTF-8 made
        # the scan blind to every binary in the tree, and a peer review found a
        # tracked .pyc containing an assembled token literal that the source
        # deliberately avoids spelling. latin-1 maps every byte to a character,
        # so nothing is skipped and the patterns still apply.
        try:
            text = path.read_bytes().decode("latin-1")
        except OSError:
            continue
        for pattern, what in patterns:
            if pattern.search(text):
                errors.append(f"{relative}: contains what looks like {what}")


def main() -> int:
    errors: list[str] = []
    validate_records(errors)
    validate_registries(errors)
    state = load_json("badf/current-state.json", [])
    validate_authority_registry(state, errors)
    validate_gates_registry(state, errors)
    validate_skills_registry(errors)
    validate_agents_registry(errors)
    validate_lifecycle_pins(errors)
    validate_acceptance_is_not_self_awarded(state, errors)
    validate_checkpoint_agrees(state, errors)
    validate_no_secrets(errors)

    if errors:
        for error in errors:
            print(f"CONTINUITY_VALIDATION ERROR {error}", file=sys.stderr)
        print(
            f"CONTINUITY_VALIDATION FAIL {len(errors)} error(s)",
            file=sys.stderr,
        )
        return 1
    print("CONTINUITY_VALIDATION PASS")
    return 0


if __name__ == "__main__":
    # The exit call is OUTSIDE the try, so that the catch-all below cannot
    # swallow the SystemExit it raises and turn a clean pass into a reported
    # validator defect.
    try:
        code = main()
    except KeyboardInterrupt:
        print("CONTINUITY_VALIDATION FAIL interrupted", file=sys.stderr)
        code = 130
    except ValidatorDefect as defect:
        print(f"CONTINUITY_VALIDATION FAIL validator defect: {defect}", file=sys.stderr)
        code = 2
    except BaseException:  # noqa: BLE001 - fail closed on anything at all
        print(
            "CONTINUITY_VALIDATION FAIL validator defect: "
            + " | ".join(traceback.format_exc().splitlines()[-3:]),
            file=sys.stderr,
        )
        code = 2
    sys.exit(code)
