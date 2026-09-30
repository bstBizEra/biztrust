#!/usr/bin/env python3
"""Continuity validation for the BizTrust platform repository.

Validates the three records under ``badf/`` and every session checkpoint
against ``schemas/*.schema.json``, and enforces the cross-record rules a schema
cannot express. Also confirms that the six ``badf/`` registries parse and
declare a version, and that ``badf/signing-policy.yaml`` - the record that says
which paths a human signature is required for - is intact.

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

import hashlib
import json
import re
import subprocess
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

#: The registries under badf/ that must exist, be non-empty and declare a
#: version. signing-policy.yaml joined them in the task that added
#: validate_signing_policy below: it is read by scripts/check-signing.mjs as
#: well, and a policy that has silently vanished would make that check govern
#: nothing while still printing a status line.
REGISTRIES = (
    "lifecycle.yaml",
    "authority.yaml",
    "gates.yaml",
    "agents.yaml",
    "skills.yaml",
    "signing-policy.yaml",
    "bootstrap.yaml",
)

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


def record_files(directory: Path, errors: list[str]) -> list[Path]:
    """The `*.json` files directly in `directory`, refusing what a glob misses.

    Round nine R9-m3. `directory.glob("*.json")` is not recursive and is
    case-sensitive on Linux (where CI runs) and not on Windows, so a malformed
    record in a subdirectory, or one named `x.JSON`, was validated by nobody on
    one platform and by somebody on the other. Both shapes are refused here
    rather than guessed at.
    """
    if not directory.is_dir():
        return []
    label = directory.relative_to(ROOT).as_posix()
    found: list[Path] = []
    for path in sorted(directory.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(ROOT).as_posix()
        if path.parent != directory:
            errors.append(
                f"{relative}: is in a subdirectory of {label}/, which nothing reads, so "
                f"a record there is validated by nobody. Move it up or delete it"
            )
            continue
        if path.suffix == ".json":
            found.append(path)
        elif path.suffix.lower() == ".json":
            errors.append(
                f"{relative}: its extension is not exactly '.json', so a case-sensitive "
                f"read (Linux, where CI runs) skips it while Windows reads it"
            )
    return found


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
    checkpoints = record_files(CHECKPOINTS, errors)
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
        for path in record_files(handoff_dir, errors):
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

#: A double-quoted YAML scalar and nothing after its closing quote. An escape is
#: a backslash and any one character, so `\"` does not close it. Round nine S-1.
_DOUBLE_QUOTED_SCALAR = re.compile(r'^"(?:[^"\\]|\\.)*"$')

#: A single-quoted YAML scalar, and nothing after its closing quote. A doubled
#: quote inside it is one literal quote.
_SINGLE_QUOTED_SCALAR = re.compile(r"^'(?:[^']|'')*'$")


def _open_quote_in_flow(value: str) -> bool:
    """Whether a flow collection on one line holds a quote it does not close.

    A quote only OPENS a scalar at the start of a token (after `[`, `{`, `,`
    or `:`), so `[it's]` is not one, and `["it's"]` is a complete double-quoted
    scalar with an apostrophe inside.
    """
    quote = None
    index = 0
    previous = ""
    while index < len(value):
        char = value[index]
        if quote == '"':
            if char == "\\":
                index += 2
                continue
            if char == '"':
                quote = None
        elif quote == "'":
            if char == "'":
                if value[index + 1 : index + 2] == "'":
                    index += 2
                    continue
                quote = None
        elif char in "\"'" and previous in ("", "[", "{", ",", ":"):
            quote = char
        if not char.isspace() and quote is None:
            previous = char
        index += 1
    return quote is not None


def scalar_refusal(value: str) -> str | None:
    """Why a field value is not one line this reader reads whole, or None.

    Round nine S-1. The hand readers took any text after `field:` as the value,
    so a value that OPENS a quote it does not close swallowed, for every
    ordinary YAML reader, all the lines up to a quote inside a later comment
    line - lines these readers skip as comments. That is the round-seven N1
    attack (`_tool_authority_item`) one level up, and it made PyYAML read the
    withheld P0 grant as GRANTED while this reader read NOT_GRANTED. The rule
    is the same one: a value that opens a quote is exactly one complete quoted
    scalar on its line, and a flow collection closes on its line. An anchor, an
    alias and a tag are refused too, because this reader resolves none of them.
    """
    if value.startswith('"'):
        if _DOUBLE_QUOTED_SCALAR.match(value) is None:
            return "a double-quoted scalar that is not one complete quoted scalar on its line"
        return None
    if value.startswith("'"):
        if _SINGLE_QUOTED_SCALAR.match(value) is None:
            return "a single-quoted scalar that is not one complete quoted scalar on its line"
        return None
    if value.startswith(("[", "{")):
        if _open_quote_in_flow(value):
            return "a flow collection holding a quote that is not one complete quoted scalar on its line"
        if not value.endswith("]" if value.startswith("[") else "}"):
            return "a flow collection that does not close on its line"
        return None
    if value.startswith(("&", "*", "!")):
        return "an anchor, an alias or a tag, none of which this reader resolves"
    return None


def refuse_value(name: str, number: int, field: str, value: str, problems: list[str]) -> bool:
    """Records a problem, and returns True, when `value` is not read whole."""
    why = scalar_refusal(value)
    if why is None:
        return False
    problems.append(
        f"{name} line {number}: the value of {field!r} is {why}: {value!r}. A quote "
        f"left open swallows every line up to the next quote, comment lines "
        f"included, so YAML reads a different file from the one this reader read"
    )
    return True


#: A key a free-form registry may carry: a plain identifier.
_PLAIN_KEY = re.compile(r"^[A-Za-z0-9_]+$")


def refuse_key(name: str, number: int, key: str, problems: list[str]) -> bool:
    """Records a problem, and returns True, when `key` is not a plain identifier.

    Round ten. The repeated-field refusal compares keys as WRITTEN, and YAML
    does not: `status`, `"status"` and `'status'` are one key, and the last of
    them wins. badf/authority.yaml lets its entries carry any field name, so
    `"status": GRANTED` written under a plain `status: NOT_GRANTED` was two
    fields to this reader and one, GRANTED, to PyYAML: a repeat the check for
    repeats never saw, with no quote left open and nothing swallowed. The other
    readers accept only the field names they list, so a quoted spelling is
    already refused there; this closes the one reader with no such list.
    """
    if _PLAIN_KEY.match(key):
        return False
    problems.append(
        f"{name} line {number}: the key {key!r} is not a plain identifier. YAML reads "
        f"status, \"status\" and 'status' as ONE key and keeps the last, and this reader "
        f"would read three, so a quoted repeat of a key is a second value that the "
        f"check for repeats never sees"
    )
    return True


def refuse_repeat(
    name: str, number: int, field: str, where: str, seen, problems: list[str]
) -> bool:
    """Records a problem, and returns True, when `field` is already in `seen`.

    Round nine S-1. YAML keeps the last of two equal keys and these readers
    used to keep the last too - until a scalar opened between them hid one from
    every other reader. A repeated key is two files, so it is refused.
    """
    if field not in seen:
        return False
    problems.append(
        f"{name} line {number}: {field!r} appears more than once in {where}. YAML "
        f"keeps only the last of two equal keys, and a quote opened between them "
        f"can hide either one from a reader that keeps the other"
    )
    return True


def parse_lists(
    name: str,
    text: str,
    *,
    scalars: set[str],
    entry_lists: dict[str, tuple[str, set[str]]],
    scalar_lists: set[str],
) -> tuple[dict, list[str]]:
    """Reads a registry made of top-level scalars and block lists, refusing what it cannot classify.

    badf/gates.yaml and badf/lifecycle.yaml were read by patterns, and a pattern
    reader accepts anything it does not match. A differential fuzz against
    PyYAML found the gates registry taking `status:` with its value on the next
    line as NO status (PyYAML keeps the last duplicate: a recorded gate), and a
    top-level key inserted mid-list as harmless (PyYAML moves the rest of the
    list under it). This is the same doctrine as parse_skills, once, for both:
    the default is an error.

    `scalars` are the top-level keys that carry one value. `entry_lists` maps a
    list name to (the key each entry opens with, the fields it may carry).
    `scalar_lists` are lists of bare values. Returns

        {"scalars": {key: value},
         "entries": {list: [{field: value, "__line__": str}, ...]},
         "items":   {list: [value, ...]}}

    and the problems found.
    """
    parsed: dict = {
        "scalars": {},
        "entries": {key: [] for key in entry_lists},
        "items": {key: [] for key in scalar_lists},
    }
    problems: list[str] = []
    current: str | None = None
    entry: dict[str, str] | None = None
    block_indent: int | None = None
    seen_top: set[str] = set()

    for number, raw in enumerate(text.splitlines(), start=1):
        if raw.strip() == "" or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))

        if block_indent is not None:
            if indent >= block_indent:
                continue
            block_indent = None

        if "\t" in raw:
            problems.append(f"{name} line {number}: contains a tab; this file is space-indented")
            continue

        if indent == 0:
            match = re.match(r"^(\S+):\s*(.*)$", raw)
            if match is None:
                problems.append(
                    f"{name} line {number}: neither a top-level key nor indented under one: "
                    f"{raw.strip()!r}"
                )
                continue
            key, rest = match.group(1), match.group(2).strip()
            current = None
            entry = None
            refuse_repeat(name, number, key, "this file", seen_top, problems)
            seen_top.add(key)
            if key in scalars:
                refuse_value(name, number, key, rest, problems)
                parsed["scalars"][key] = rest
            elif key in entry_lists or key in scalar_lists:
                if rest != "":
                    problems.append(
                        f"{name} line {number}: {key!r} carries an inline value; its entries "
                        f"must be written as a block"
                    )
                current = key
            else:
                problems.append(
                    f"{name} line {number}: unknown top-level key {key!r}. A key nothing reads "
                    f"is a key that can split a list in two for every reader but this one"
                )
            continue

        if current is None:
            problems.append(
                f"{name} line {number}: indented content outside any list: {raw.strip()!r}"
            )
            continue

        if indent == 2 and current in entry_lists:
            opener, _fields = entry_lists[current]
            match = re.match(r"^ {2}- ([A-Za-z0-9_]+):\s*(.*)$", raw)
            if match is None or match.group(1) != opener:
                problems.append(
                    f"{name} line {number}: an entry of {current!r} must open with "
                    f"'- {opener}: <value>': {raw.strip()!r}"
                )
                entry = None
                continue
            value = match.group(2).strip()
            refuse_value(name, number, opener, value, problems)
            entry = {opener: value, "__line__": str(number)}
            parsed["entries"][current].append(entry)
            continue

        if indent == 2:
            match = re.match(r"^ {2}- (.*)$", raw)
            if match is None:
                problems.append(f"{name} line {number}: not an item of {current!r}: {raw.strip()!r}")
                continue
            value = match.group(1).strip()
            refuse_value(name, number, current, value, problems)
            parsed["items"][current].append(value)
            continue

        if indent == 4 and current in entry_lists and entry is not None:
            _opener, fields = entry_lists[current]
            match = re.match(r"^ {4}([A-Za-z0-9_]+):\s*(.*)$", raw)
            if match is None:
                problems.append(f"{name} line {number}: not a field of an entry: {raw.strip()!r}")
                continue
            field, value = match.group(1), match.group(2).strip()
            if field not in fields:
                problems.append(
                    f"{name} line {number}: unknown field {field!r} on an entry of {current!r}"
                )
                continue
            if refuse_value(name, number, field, value, problems):
                continue
            if refuse_repeat(
                name, number, field, f"the entry at line {entry['__line__']}", entry, problems
            ):
                continue
            if value in (">", ">-", "|", "|-", ""):
                block_indent = 6
                value = ""
            entry[field] = value
            continue

        problems.append(
            f"{name} line {number}: indented {indent} spaces, which is neither an entry nor a "
            f"field: {raw.strip()!r}"
        )

    return parsed, problems


def unquoted(value: str) -> str:
    """A scalar read as YAML reads it, for the two quoted forms; anything else as written."""
    if _DOUBLE_QUOTED_SCALAR.match(value):
        try:
            decoded = json.loads(value)
        except ValueError:
            return value
        return decoded if isinstance(decoded, str) else value
    if _SINGLE_QUOTED_SCALAR.match(value):
        return value[1:-1].replace("''", "'")
    return value


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
    seen_sections: set[str] = set()

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
            # Round seven finding N1. Two blocks under one key were MERGED
            # here, while PyYAML keeps the last and drops the first: a second
            # `tool_authority:` appended to the file replaced every pinned
            # list for everyone but this reader. Refused, not merged.
            if section in seen_sections:
                problems.append(
                    f"badf/authority.yaml line {number}: top-level key {section!r} "
                    f"appears more than once. Two readings of one key are two files, "
                    f"and YAML keeps only the last"
                )
            seen_sections.add(section)
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
            refuse_value("badf/authority.yaml", number, section, rest, problems)
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
            refuse_key("badf/authority.yaml", number, key, problems)
            refuse_repeat(
                "badf/authority.yaml", number, key, section, sections[section], problems
            )
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
            if refuse_key("badf/authority.yaml", number, field, problems):
                continue
            if refuse_value("badf/authority.yaml", number, field, value, problems):
                continue
            if refuse_repeat(
                "badf/authority.yaml", number, field, f"{section}.{key}",
                sections[section][key], problems,
            ):
                continue
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


#: What an agent may NOT do in this repository, verbatim from the
#: `tool_authority.may_not` list of badf/authority.yaml.
#:
#: Review finding M1. The block was never read: list items under it hit
#: `continue` in parse_authority, so moving "Grant, extend or infer authority,
#: including its own" from may_not into may passed `pnpm validate:records`
#: with ONE file edited. That is a strictly cheaper forgery than the three-file
#: one the signing policy declares. The list is a FLOOR, as PINNED_ROUTING and
#: PINNED_PROTECTED_PATHS are: forbidding more is always allowed, and removing
#: one is a reviewed change to this validator under a Work Package that says why.
PINNED_TOOL_MAY_NOT = (
    "Push to main",
    "Record a gate result",
    "Mark a design or an ADR ACCEPTED",
    "Grant, extend or infer authority, including its own",
    "Create a domain table or implement a P0 epic",
    "Claim that any capability is implemented, secure, compliant or production-ready",
    "Place a secret, a credential, client data or regulated data in this repository",
)

TOOL_AUTHORITY_LISTS = ("may", "may_not")


#: A plain YAML scalar this reader is willing to read: it opens on a letter,
#: digit or parenthesis (so no indicator, quote, anchor, tag, flow bracket or
#: nested `- `), and holds no ` #` or `#`, no `: ` and no closing colon.
_PLAIN_SCALAR = re.compile(r"^[A-Za-z0-9(][^#]*$")


def _tool_authority_item(raw: str) -> tuple[str | None, str | None]:
    """One `- ...` list item as (text, None), or (None, why it was refused).

    Round seven finding N1. This used to unquote an item only when the item
    ENDED with a quote, and hand anything else back as text. A trailing
    `# comment` after a quoted forbidden power therefore left the quotes and
    the comment inside the compared string, the power no longer matched its
    pin, and PyYAML read exactly the pinned string. Anything that is not
    exactly one quoted scalar, or one plain scalar without a `#`, is REFUSED
    here rather than guessed at: a reader that guesses is a reader with two
    readings of the same file.
    """
    body = raw.strip()[2:].strip()
    if body.startswith('"'):
        try:
            decoded = json.loads(body)
        except ValueError:
            decoded = None
        if not isinstance(decoded, str):
            return None, "a double-quoted scalar this reader cannot decode whole"
        return decoded, None
    if body.startswith("'"):
        if _SINGLE_QUOTED_SCALAR.match(body) is None:
            return None, "a single-quoted scalar with text outside its quotes"
        return body[1:-1].replace("''", "'"), None
    if _PLAIN_SCALAR.match(body) is None:
        return None, "neither quoted nor a plain scalar this reader accepts"
    if ": " in body or body.endswith(":"):
        return None, "a plain scalar that reads as a mapping"
    return body, None


def _normalised(text: str) -> str:
    """Case and whitespace folded, so `push  to MAIN` is `Push to main`."""
    return " ".join(text.split()).casefold()


def parse_tool_authority(text: str) -> tuple[dict[str, list[str]], list[str]]:
    """Reads the `may` and `may_not` lists of the tool_authority section.

    parse_authority classifies every line and skips list items under this
    section; this reads them. Anything it cannot classify is a problem, so a
    third list, or a field where a list belongs, is not a place to hide a power.
    """
    lists: dict[str, list[str]] = {name: [] for name in TOOL_AUTHORITY_LISTS}
    problems: list[str] = []
    in_section = False
    current: str | None = None
    opened: set[str] = set()
    for number, raw in enumerate(text.splitlines(), start=1):
        if raw.strip() == "" or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        if indent == 0:
            in_section = raw.startswith("tool_authority:")
            current = None
            opened = set()
            continue
        if not in_section:
            continue
        if indent == 2:
            match = re.match(r"^ {2}([A-Za-z0-9_]+):\s*$", raw)
            if match is None or match.group(1) not in TOOL_AUTHORITY_LISTS:
                problems.append(
                    f"badf/authority.yaml line {number}: tool_authority takes only the "
                    f"lists {list(TOOL_AUTHORITY_LISTS)}, written as blocks: {raw.strip()!r}"
                )
                current = None
                continue
            current = match.group(1)
            if current in opened:
                # PyYAML keeps the LAST of two equal keys; merging them here
                # would read a different file from the one everyone else reads.
                problems.append(
                    f"badf/authority.yaml line {number}: tool_authority.{current} "
                    f"appears more than once; a second list is not merged with the first"
                )
            opened.add(current)
            continue
        if indent == 4 and raw.lstrip().startswith("- ") and current is not None:
            item, why = _tool_authority_item(raw)
            if item is None:
                problems.append(
                    f"badf/authority.yaml line {number}: a tool_authority item that is "
                    f"not exactly one quoted scalar or one plain scalar without '#' "
                    f"({why}): {raw.strip()!r}"
                )
                continue
            # Round nine S-4. `_normalised` folds Unicode whitespace and YAML
            # does not, so `Push<NBSP>to main` met the pin here and was absent
            # from may_not for a strict reader; a homoglyph or a zero-width
            # space under `may` names a power no pin can. Judged after
            # decoding, so a `\u00a0` escape is caught as well.
            if not item.isascii():
                problems.append(
                    f"badf/authority.yaml line {number}: a tool_authority item holding a "
                    f"non-ASCII character ({item!r}). Every pinned power is ASCII, and "
                    f"a look-alike is a power the pins cannot name"
                )
                continue
            lists[current].append(item)
            continue
        problems.append(
            f"badf/authority.yaml line {number}: not an item of tool_authority.may or "
            f"tool_authority.may_not: {raw.strip()!r}"
        )
    return lists, problems


def validate_tool_authority(text: str, errors: list[str]) -> None:
    """Refuses a tool_authority block that grants an agent a pinned power.

    Two refusals, and each has its own fixture so neither can be deleted alone:
    a pinned power missing from `may_not`, and a pinned power listed under
    `may`. The second compares with case and whitespace folded, so re-spelling
    a forbidden power is not a way past it.
    """
    lists, problems = parse_tool_authority(text)
    errors.extend(problems)
    forbidden = {_normalised(item) for item in lists["may_not"]}
    permitted = {_normalised(item) for item in lists["may"]}
    for pinned in PINNED_TOOL_MAY_NOT:
        if _normalised(pinned) not in forbidden:
            errors.append(
                f"badf/authority.yaml: tool_authority.may_not no longer lists {pinned!r}. "
                f"The list is pinned in scripts/validate_continuity.py; removing a "
                f"forbidden power is a reviewed change to the validator, not a data edit"
            )
    for pinned in PINNED_TOOL_MAY_NOT:
        if _normalised(pinned) in permitted:
            errors.append(
                f"badf/authority.yaml: tool_authority.may lists {pinned!r}, which is "
                f"pinned as forbidden to an agent"
            )


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
    validate_tool_authority(text, errors)

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

#: How restrictive each status is. A skill may be recorded at or ABOVE its
#: pinned status (a BLOCKED skill later recorded FORBIDDEN_TO_AGENTS is a
#: tightening, and nothing here objects); it may never be recorded below it.
SKILL_STATUS_RANK = {"AVAILABLE": 0, "BLOCKED": 1, "FORBIDDEN_TO_AGENTS": 2}

#: The COMPLETE roster of badf/skills.yaml, id by id, with the status each is
#: pinned at. Not a floor for the two or three authority-shaped entries: the
#: whole file.
#:
#: Round four finding I8. The previous version pinned three ids
#: FORBIDDEN_TO_AGENTS and nothing else, so the registry could still be
#: widened three ways, each verified passing:
#:
#:   - `write-a-migration: BLOCKED -> AVAILABLE` passed, leaving the entry's
#:     own `why:` text ("ADR-004 is DRAFT_REQUIRED and BT-G0 is unrecorded")
#:     standing in flat contradiction of its status;
#:   - appending a NEW entry with `status: AVAILABLE` passed, which is how a
#:     capability registry grows a capability nobody granted;
#:   - a skill the file newly marked FORBIDDEN_TO_AGENTS was not protected at
#:     all, because the pin was a list of three names and the data had
#:     outgrown it.
#:
#: The last of those is why this is a two-way check rather than a floor (see
#: validate_skills_registry): every pinned id must be recorded at or above
#: its pin, AND every id the file records must be pinned here. The second
#: half is what refuses a floor the data has outgrown, and it is the
#: non-circular form of "derive the set from the file" - deriving it at
#: validation time would let an agent editing badf/skills.yaml move the very
#: set meant to constrain it.
#:
#: Changing a status therefore costs a reviewed edit to THIS mapping, in the
#: same pull request as the data change, under a Work Package that says why -
#: the cost DEC-007 already chose for widening a grant in
#: badf/authority.yaml, and the cost validate_agents_registry already applies
#: to who may occupy a seat.
PINNED_SKILL_STATUS = {
    "read-records": "AVAILABLE",
    "run-validators": "AVAILABLE",
    "write-a-checkpoint": "AVAILABLE",
    "append-a-decision": "AVAILABLE",
    "register-a-module": "BLOCKED",
    "create-a-module-package": "BLOCKED",
    "write-a-migration": "BLOCKED",
    "implement-a-contract": "BLOCKED",
    "record-a-gate": "FORBIDDEN_TO_AGENTS",
    "grant-authority": "FORBIDDEN_TO_AGENTS",
    "deploy": "FORBIDDEN_TO_AGENTS",
    "enroll-a-signing-key": "FORBIDDEN_TO_AGENTS",
}

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
    seen_top: set[str] = set()

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
            refuse_value("badf/skills.yaml", number, key, rest, problems)
            refuse_repeat("badf/skills.yaml", number, key, "this file", seen_top, problems)
            seen_top.add(key)
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
            refuse_value("badf/skills.yaml", number, "id", current, problems)
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
            if refuse_value("badf/skills.yaml", number, field, value, problems):
                continue
            if refuse_repeat(
                "badf/skills.yaml", number, field, f"skill {current!r}",
                entries[current], problems,
            ):
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
    """The capability registry: statuses from a closed set, and the roster
    pinned in PINNED_SKILL_STATUS in BOTH directions.

    badf/skills.yaml was validated for existence, non-emptiness and a
    version: line only (validate_registries above). Nothing stopped an agent
    setting record-a-gate, grant-authority or deploy to AVAILABLE: the
    registry lists what a skill claims to need, but the claim is prose an
    agent could edit to say anything at all, and nothing read the status
    column. Task 6 closed that for three ids; round four finding I8 found the
    registry could still be widened around them - see PINNED_SKILL_STATUS.
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

    # Direction one: every pinned id is recorded, at or above its pin. This
    # refuses both a deletion (a skill that is not there is not forbidden) and
    # a widening (BLOCKED -> AVAILABLE, FORBIDDEN_TO_AGENTS -> anything).
    for skill_id, pinned in sorted(PINNED_SKILL_STATUS.items()):
        if skill_id not in entries:
            errors.append(
                f"badf/skills.yaml: {skill_id!r} is missing, so its pinned "
                f"status {pinned} cannot be checked. Deleting a skill is how a "
                f"blocked or forbidden capability stops being blocked or "
                f"forbidden without anyone recording that"
            )
            continue
        status = entries[skill_id].get("status", "").strip().strip('"')
        if SKILL_STATUS_RANK.get(status, -1) < SKILL_STATUS_RANK[pinned]:
            errors.append(
                f"badf/skills.yaml: {skill_id} has status {status!r}, which is "
                f"less restrictive than the {pinned} it is pinned at in "
                f"scripts/validate_continuity.py (PINNED_SKILL_STATUS). "
                f"AGENTS.md section 4 makes this a human decision; a skill can "
                f"be widened only through a reviewed change to this validator, "
                f"under a Work Package that says why - never through a one-word "
                f"edit to badf/skills.yaml alone"
            )

    # Direction two: every id the file records is pinned here. Without this the
    # pin is a floor the data can outgrow - a NEW skill, at any status, is
    # simply unprotected, and one recorded AVAILABLE is a capability nobody
    # reviewed. This is the non-circular form of "derive the set from the
    # file": the file cannot move the set, it can only be refused by it.
    for skill_id in sorted(entries):
        if skill_id in PINNED_SKILL_STATUS:
            continue
        status = entries[skill_id].get("status", "").strip().strip('"')
        errors.append(
            f"badf/skills.yaml: {skill_id!r} (status {status!r}) is recorded in "
            f"the registry but is pinned nowhere in "
            f"scripts/validate_continuity.py (PINNED_SKILL_STATUS), so nothing "
            f"holds its status where it is. A capability registry an agent can "
            f"grow by one entry is a capability registry, not a governed one; "
            f"add it to PINNED_SKILL_STATUS in the same pull request, under a "
            f"Work Package that says why"
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

#: The governance records whose routing entry is PINNED: the path must be
#: routed, and routed to exactly these two seats.
#:
#: Round four finding I7. The routing block is what
#: scripts/generate-codeowners.mjs turns into .github/CODEOWNERS - who must
#: review a change to what - and it was validated for PRESENCE only: owner and
#: verifier had to be non-empty strings, and nothing else. Two edits were
#: verified passing both `validate:records` AND `codeowners:check`:
#:
#:   - rerouting "badf/authority.yaml" from business-authority /
#:     repository-administrator to platform-engineer / peer-reviewer, both of
#:     which are may_be_an_agent: true. The file AGENTS.md section 4 says an
#:     agent "may READ and may never widen" would then be reviewed by two
#:     seats an agent may occupy;
#:   - deleting the "badf/authority.yaml" and "badf/gates.yaml" routing
#:     entries outright, after which CODEOWNERS names no reviewer for either
#:     and the generated file is, correctly, current.
#:
#: badf/agents.yaml and badf/skills.yaml had no routing entry of their own at
#: all - the registry of who may hold a seat, and the registry of what an
#: agent may do, routed to nobody. Both are added here and to the data file.
#:
#: Every seat named below is may_be_an_agent: false. That is the point: these
#: four files decide what agents may do, and an agent may not be the reviewer
#: of a change to them.
PINNED_ROUTING = {
    "badf/authority.yaml": ("business-authority", "repository-administrator"),
    "badf/signing-policy.yaml": ("repository-administrator", "architecture-authority"),
    "badf/gates.yaml": ("architecture-authority", "repository-administrator"),
    "badf/agents.yaml": ("architecture-authority", "repository-administrator"),
    "badf/skills.yaml": ("architecture-authority", "repository-administrator"),
    # 'badf/bootstrap.yaml' is DELIBERATELY not pinned here. Round two showed
    # the static pin subsumed the dynamic rule in validate_bootstrap_record
    # entirely, and that changing a static pin is a change to THIS file, which
    # badf/agents.yaml routes to two seats an agent may occupy. The dynamic
    # rule states the whole requirement - routed at all, to human-only seats,
    # neither of which the record seats - and it holds for whatever seat a
    # future act names rather than for the two this one happens to use.
}

#: A value that LOOKS like a role id: one bare token, no spaces. Anything
#: matching this must name a role this file declares (see
#: validate_agents_registry). Prose - "the owner_role of the module in
#: modules/modules.yaml", the one routing entry whose owner genuinely varies
#: per module - does not match, and is left to the pins above, which is where
#: a governance path could otherwise hide behind prose.
ROLE_SHAPED = re.compile(r"[A-Za-z0-9_.-]+")


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
    seen_top: set[str] = set()

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
            refuse_value("badf/agents.yaml", number, key, rest, problems)
            refuse_repeat("badf/agents.yaml", number, key, "this file", seen_top, problems)
            seen_top.add(key)
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
            # The succession rule: prose, pinned verbatim by
            # validate_agents_succession_rule below, which is the reader that
            # gives it meaning. scripts/agents-registry.mjs learns the same
            # shape in the same change - two readers in two languages that must
            # independently agree on this file, as its own header says.
            if key == "succession":
                if rest in (">", ">-", "|", "|-", ""):
                    block_indent = 2
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
                refuse_value("badf/agents.yaml", number, "id", current_role, problems)
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
                refuse_value(
                    "badf/agents.yaml", number, "path", current_route["path"], problems
                )
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
            if refuse_value("badf/agents.yaml", number, field, value, problems):
                continue
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
                if refuse_repeat(
                    "badf/agents.yaml", number, field, f"role {current_role!r}",
                    roles[current_role], problems,
                ):
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
                if refuse_repeat(
                    "badf/agents.yaml", number, field,
                    f"the routing entry for {current_route['path']!r}",
                    current_route, problems,
                ):
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


def validate_agents_registry(errors: list[str], seated: dict[str, str]) -> None:
    """The role registry: may_be_an_agent pinned for the four human seats, and
    held_by pinned to the literal null on every role.

    badf/agents.yaml was validated for existence, non-emptiness and a
    version: line only. Nothing stopped an agent flipping may_be_an_agent to
    true on all four authority seats, and no field could record who holds one
    even honestly, so NS-001's acceptance criterion could not be recorded in
    the record it names.

    Task 6 review found that a presence-only check on held_by let an agent
    write held_by: "Agent-Claude-Session-1" onto architecture-authority - or
    any name onto any seat - and pnpm validate:records still passed. That is
    precisely the forgery this repository exists to prevent: a named human
    holding a seat is a human's record, never an agent's to write, even
    honestly. held_by is therefore pinned to the literal null. A human
    filling a seat changes this function in the same pull request, under a
    Work Package that says why - the cost DEC-007 gave widening a grant in
    badf/authority.yaml, applied here to who may occupy a seat rather than
    what is granted.
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
        else:
            held_by = entry["held_by"].strip().strip('"')
            # NARROWED, never removed. The literal null is still the only value
            # this registry may carry on its own; the one exception is a seat
            # that badf/bootstrap.yaml VALIDLY seats, to that same principal,
            # with badf/current-state.json agreeing about the act, the seats and
            # the digest. validate_bootstrap_record returns an empty map unless
            # every one of those holds, so a defect anywhere in the bootstrap
            # record restores the unconditional pin rather than relaxing it.
            if held_by != "null" and seated.get(role_id) != held_by:
                errors.append(
                    f"badf/agents.yaml: role {role_id} has held_by "
                    f"{held_by!r}, and badf/bootstrap.yaml records no valid "
                    f"bootstrap seating naming that seat and that principal. "
                    f"Every seat in this registry stays null unless "
                    f"badf/bootstrap.yaml records the one-time act that seated "
                    f"it AND badf/current-state.json records that act, the "
                    f"seats it was spent on, and the digest of its frozen "
                    f"region. Filling a seat is a consistent, simultaneous "
                    f"change to three governed records under a Work Package "
                    f"that says why - the same doctrine "
                    f"scripts/agents-registry.mjs states for this file. It is "
                    f"never a one-line edit to badf/agents.yaml alone"
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

    routed: dict[str, list[dict[str, str]]] = {}
    for index, route in enumerate(routing, start=1):
        for field in ("path", "owner", "verifier"):
            if field not in route or route[field].strip() == "":
                errors.append(
                    f"badf/agents.yaml: routing entry {index} records no "
                    f"{field}"
                )
        path = route.get("path", "").strip().strip('"')
        routed.setdefault(path, []).append(route)

        # A role-shaped owner or verifier must name a role this file
        # declares. Presence was the only check, so a routing entry could
        # name a seat that does not exist - which generates no CODEOWNERS
        # line at all, silently leaving the path unreviewed, and reads to a
        # human as though it were routed.
        for field in ("owner", "verifier"):
            value = route.get(field, "").strip().strip('"')
            if value == "" or value in roles:
                continue
            if ROLE_SHAPED.fullmatch(value) is None:
                continue
            errors.append(
                f"badf/agents.yaml: routing entry {index} ({path!r}) records "
                f"{field} {value!r}, which names no role declared in this "
                f"file's roles: block. scripts/generate-codeowners.mjs emits a "
                f"CODEOWNERS line only for a value that IS a declared role, so "
                f"a seat that does not exist leaves the path unreviewed while "
                f"reading as though it were routed"
            )

    for path, (owner, verifier) in sorted(PINNED_ROUTING.items()):
        entries = routed.get(path, [])
        if not entries:
            errors.append(
                f"badf/agents.yaml: no routing entry records {path!r}, which "
                f"is pinned in scripts/validate_continuity.py "
                f"(PINNED_ROUTING) to {owner} / {verifier}. Deleting the "
                f"routing entry for a governance record is how it stops "
                f"having a required reviewer without anyone recording that"
            )
            continue
        if len(entries) > 1:
            errors.append(
                f"badf/agents.yaml: {path!r} has {len(entries)} routing "
                f"entries; a pinned governance path is routed exactly once, "
                f"or which of them binds is a question about parse order"
            )
        for field, expected in (("owner", owner), ("verifier", verifier)):
            actual = entries[0].get(field, "").strip().strip('"')
            if actual == expected:
                continue
            errors.append(
                f"badf/agents.yaml: {path!r} routes {field} to {actual!r}, "
                f"not the {expected!r} it is pinned to in "
                f"scripts/validate_continuity.py (PINNED_ROUTING). This path "
                f"decides what agents may do, so its reviewer is a human-only "
                f"seat; rerouting it to a seat an agent may occupy is the "
                f"forgery this repository exists to refuse, and it can change "
                f"only through a reviewed edit to that mapping, under a Work "
                f"Package that says why"
            )


# ---------------------------------------------------------------------------
# badf/bootstrap.yaml: the one-time act that seats the first human-only seat.
#
# badf/agents.yaml routes changes to itself to `verifier:
# repository-administrator`, so filling that seat requires the seat to verify
# its own creation, and the same seat (unfilled when this was written, held by
# BizEra since BOOTSTRAP-001, DEC-036, and contested by review finding B6) owns
# badf/signing-policy.yaml and AGENTS.md. docs/decisions/PROPOSAL-bootstrap-seating.md
# costs four ways out; the mechanism built here is its recommendation - option
# (a), the succession rule, adopted ONCE by option (c), an operator instruction.
#
# NOTHING BELOW SEATS ANYONE. The record was written to ship with no principal
# named and to be refused as a completed seating until an operator named one;
# the operator did on 2026-09-30 (DEC-036) and the record now reads SEATED. An
# agent may not supply that name, and this validator is written so that it
# cannot: every rule
# here narrows what a record may say, and none of them can be satisfied by an
# agent writing a human into a seat, because the seating has to agree with
# badf/agents.yaml AND with badf/current-state.json, both of which are covered
# by badf/signing-policy.yaml.
# ---------------------------------------------------------------------------

#: The markers delimiting the frozen region of badf/bootstrap.yaml. They are
#: comments, so the reader below skips them as prose; they are read separately,
#: by line, because what is hashed is TEXT and not a parse. A record with no
#: frozen region can never be frozen, so exactly one of each is required.
BOOTSTRAP_BEGIN = "# ---- BEGIN HISTORICAL RECORD ----"
BOOTSTRAP_END = "# ---- END HISTORICAL RECORD ----"

BOOTSTRAP_AWAITING = "AWAITING_OPERATOR_INSTRUCTION"
BOOTSTRAP_SEATED = "SEATED"

#: The literal that says WHICH mechanism adopted the succession rule. It is one
#: value and not a free string for the reason WITHHELD_STATUSES is a set: a
#: reader's conclusion lives in the word, and "OPERATOR_INSTRUCTION" alone
#: would read equally well as a standing authority path that stays available.
BOOTSTRAP_ESTABLISHED_BY = "OPERATOR_INSTRUCTION_ADOPTING_THE_SUCCESSION_RULE"

#: The only exception a dual seat may be. A dual seat recorded as anything else
#: is an exception whose type nothing constrains, which is a permanent one.
BOOTSTRAP_EXCEPTION_TYPE = "BOOTSTRAP"

#: The statement constraint 3 asks for, pinned VERBATIM in the shape
#: validate_lifecycle_pins uses: a later reader must not be able to mistake the
#: operator instruction for a standing parallel authority path, and prose that
#: can be reworded is prose that will be.
BOOTSTRAP_STATEMENT = (
    "THE OPERATOR INSTRUCTION RECORDED HERE IS THE MECHANISM THAT ADOPTED THE "
    "SUCCESSION RULE IN badf/agents.yaml. IT IS NOT A STANDING ALTERNATIVE "
    "AUTHORITY PATH, AND IT IS SPENT BY ITS OWN USE."
)

# The bootstrap capability is single-use, and this is where that is PINNED.
#
# Review finding M3. badf/current-state.json carries a consumption ledger, but
# a ledger is data: a second seating (business-authority seated by an agent
# identifier) or a new BOOTSTRAP-002 act passed once the ledger was edited to
# match and the digest recomputed. Nothing bound the ledger to what the first,
# real act recorded. These four constants do, from code the data cannot reach:
#
#   - BOOTSTRAP-001 is the only act there is;
#   - it is SEATED, and stays SEATED (reverting it to AWAITING would make the
#     act unspent again, and every other pin would then be vacuous);
#   - it seated exactly the repository administrator, and no other seat;
#   - the frozen historical region hashes to the value recorded when it was
#     seated.
#
# A later legitimate change - a second act, another seat - therefore needs a
# reviewed change to THIS FILE, under a Work Package that says why, rather than
# a consistent edit to three data files. tests/unit substitutes these four
# lines in a temporary copy to exercise the older rules against other records;
# each is a single line for that reason, so keep them single lines.
BOOTSTRAP_PINNED_ACT = "BOOTSTRAP-001"
BOOTSTRAP_PINNED_STATE = "SEATED"
BOOTSTRAP_PINNED_SEATS = ["repository-administrator"]
BOOTSTRAP_PINNED_DIGEST = "5989e6c2c7210c656bde85f0a57199816c881501cc2007e9427ca4628094d784"

BOOTSTRAP_SCALARS = {
    "version",
    "updated_at",
    "act_id",
    "state",
    "established_by",
    "standing_authority_path",
    "instruction_date",
    "instruction_origin",
    "temporary_dual_seat",
    "exception_type",
    "expiry",
    "separation_trigger",
    "establishment_statement",
}
BOOTSTRAP_SEATING_FIELDS = {"seat", "principal", "note"}

BOOTSTRAP_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}")

#: The scalars pinned to a fixed set of literals, one deletable row per rule,
#: for the reason ACCEPTED_KEY_RULES is a table: three conditions inside one
#: function share one mutation and one control, and which of them is actually
#: enforced then cannot be observed.
#:
#: (field, allowed values, what it must be)
BOOTSTRAP_LITERALS = (
    (
        "state",
        (BOOTSTRAP_AWAITING, BOOTSTRAP_SEATED),
        f"either {BOOTSTRAP_AWAITING} - the shape of a seating, awaiting the "
        f"operator's name - or {BOOTSTRAP_SEATED}. A record ambiguous about "
        f"whether anyone is seated is read as seated by whoever benefits",
    ),
    (
        "established_by",
        (BOOTSTRAP_ESTABLISHED_BY,),
        f"the literal {BOOTSTRAP_ESTABLISHED_BY}. The operator instruction is "
        f"the MECHANISM that adopted the succession rule in badf/agents.yaml, "
        f"and recording it as anything else turns a spent, one-time act into a "
        f"second authority path a later reader may take",
    ),
    (
        "standing_authority_path",
        ("false",),
        "the literal false. This record is consumed by its own use; a record "
        "that declares itself a standing path declares the bypass this "
        "mechanism exists to close",
    ),
)


def bootstrap_region(text: str) -> tuple[int, int] | None:
    """The 1-based line numbers of the BEGIN and END markers, or None.

    Separate from the block below because the SPAN is what says which recorded
    fields the digest actually covers. Round two proved why that matters: the
    markers being present, in order, and one of each was the whole rule, so a
    region enclosing NOTHING hashed the empty string and passed, and a region
    shrunk to one field left every other field editable with the recorded
    digest still matching. A digest over a region that encloses less than the
    record binds less than it appears to, at the one moment - the first
    recording - when there is nothing to compare it against.
    """
    lines = text.replace("\r\n", "\n").split("\n")
    starts = [i for i, line in enumerate(lines, start=1) if line.strip() == BOOTSTRAP_BEGIN]
    ends = [i for i, line in enumerate(lines, start=1) if line.strip() == BOOTSTRAP_END]
    if len(starts) != 1 or len(ends) != 1 or ends[0] < starts[0]:
        return None
    return starts[0], ends[0]


def bootstrap_historical_block(text: str) -> str | None:
    """The frozen region of badf/bootstrap.yaml, verbatim, or None.

    Text and not a parse: what constraint 2 freezes is the record a human
    reads, so a comment reworded inside the region changes the digest exactly
    as a changed principal does. Newlines are normalised because the checkout
    that computes the digest need not be the checkout that recorded it.
    """
    span = bootstrap_region(text)
    if span is None:
        return None
    lines = text.replace("\r\n", "\n").split("\n")
    return "\n".join(lines[span[0] : span[1] - 1])


def bootstrap_digest(block: str) -> str:
    return hashlib.sha256(block.encode("utf-8")).hexdigest()


def parse_bootstrap(text: str) -> tuple[dict, list[str]]:
    """Reads badf/bootstrap.yaml, refusing every line it cannot classify.

    A sibling of parse_authority, parse_skills, parse_agents and
    parse_signing_policy, and written for the reason the first of those
    documents at length: a reader that SKIPS what it does not recognise was
    defeated five ways with ordinary, legal YAML. The default is an error.

    Returns {"scalars": {key: value}, "seatings": [{field: value}, ...],
    "classified": [(line, what)]}. The third is what
    validate_bootstrap_record checks the frozen region against: a field this
    reader classified but the digest does not cover is a field the record's
    immutability does not cover.
    """
    record: dict = {"scalars": {}, "seatings": [], "classified": []}
    problems: list[str] = []
    section: str | None = None
    entry: dict[str, str] | None = None
    block_indent: int | None = None
    block_owner: str = ""
    seen_top: set[str] = set()

    for number, raw in enumerate(text.splitlines(), start=1):
        if raw.strip() == "" or raw.lstrip().startswith("#"):
            continue

        indent = len(raw) - len(raw.lstrip(" "))

        if block_indent is not None:
            if indent >= block_indent:
                # The body of a folded scalar is prose and is not read for
                # meaning - but it IS part of the record, so it is recorded as
                # classified. Otherwise the frozen region could be drawn
                # between a pinned statement's key and the statement itself.
                record["classified"].append((number, f"the body of {block_owner!r}"))
                continue
            block_indent = None

        # A tab is not an indent this reader disagrees with; it is a shape that
        # made a whole section invisible to an earlier reader. It matches no
        # rule below and lands on the catch-all, with its number.
        tabless = "\t" not in raw

        if tabless and indent == 0:
            top = re.match(r"^(\S+):[ ]*(.*)$", raw)
            if top is not None:
                key, value = top.group(1), top.group(2).strip()
                section = None
                entry = None
                refuse_value("badf/bootstrap.yaml", number, key, value, problems)
                refuse_repeat(
                    "badf/bootstrap.yaml", number, key, "this file", seen_top, problems
                )
                seen_top.add(key)
                if key in BOOTSTRAP_SCALARS:
                    if value in (">", ">-", "|", "|-"):
                        block_indent = 2
                        block_owner = key
                        value = ""
                    elif value == "":
                        # An empty value used to open a folded block here, and a
                        # block opened by accident swallows every line indented
                        # under it WITHOUT classifying any of them - which this
                        # reader's own docstring promises never to do. Round two
                        # built the file that exploits it: `expiry:` with no
                        # value between `seatings:` and its entries makes the
                        # whole block invisible, so a record that READS to a
                        # human as a completed seating parses as no seating at
                        # all. That divergence between the machine's text and
                        # the human's text is the exact thing the digest exists
                        # to prevent, arriving one layer below it.
                        problems.append(
                            f"badf/bootstrap.yaml line {number}: {key!r} carries no "
                            f"value and does not open a folded scalar. Every scalar "
                            f"in this record says something, the literal null "
                            f"included; a key with nothing after the colon is a key "
                            f"whose meaning a reader has to guess"
                        )
                        continue
                    record["scalars"][key] = value.strip('"')
                    record["classified"].append((number, key))
                    continue
                if key == "seatings":
                    if value != "":
                        problems.append(
                            f"badf/bootstrap.yaml line {number}: 'seatings' carries "
                            f"an inline value; its entries must be written as a block"
                        )
                    section = "seatings"
                    record["classified"].append((number, "seatings"))
                    continue
                problems.append(
                    f"badf/bootstrap.yaml line {number}: unknown top-level key "
                    f"{key!r}. A key nothing reads is a key a forger fills in while "
                    f"the file still looks authoritative"
                )
                continue

        if tabless and indent == 2 and section == "seatings":
            opener = re.match(r"^ {2}- seat:[ ]*(\S.*)$", raw)
            if opener is not None:
                refuse_value(
                    "badf/bootstrap.yaml", number, "seat", opener.group(1).strip(), problems
                )
                entry = {
                    "seat": opener.group(1).strip().strip('"'),
                    "__line__": str(number),
                }
                record["seatings"].append(entry)
                record["classified"].append(
                    (number, f"the seat of seating {len(record['seatings'])}")
                )
                continue

        if tabless and indent == 4 and section == "seatings" and entry is not None:
            field_match = re.match(r"^ {4}(\S+):[ ]*(.*)$", raw)
            if field_match is not None:
                field, value = field_match.group(1), field_match.group(2).strip()
                if field not in BOOTSTRAP_SEATING_FIELDS:
                    problems.append(
                        f"badf/bootstrap.yaml line {number}: unknown field {field!r} "
                        f"on a seating. A field this reader drops is a field a human "
                        f"reading the file still sees, and believes"
                    )
                    continue
                if refuse_value("badf/bootstrap.yaml", number, field, value, problems):
                    continue
                if refuse_repeat(
                    "badf/bootstrap.yaml", number, field,
                    f"seating {len(record['seatings'])}", entry, problems,
                ):
                    continue
                if value in (">", ">-", "|", "|-", ""):
                    block_indent = 6
                    block_owner = f"a seating's {field}"
                    value = ""
                entry[field] = value.strip('"')
                record["classified"].append(
                    (number, f"the {field} of seating {len(record['seatings'])}")
                )
                continue

        problems.append(
            f"badf/bootstrap.yaml line {number}: matches no rule of this record's "
            f"grammar, or names a field with no seating open: {raw.strip()!r}. This "
            f"reader refuses what it cannot classify rather than skipping it"
        )

    return record, problems


def validate_bootstrap_record(state, errors: list[str]) -> dict[str, str]:
    """The one-time act, and the seats it legitimately seats.

    Returns {seat: principal}, which validate_agents_registry uses to NARROW -
    never to remove - the pin holding every held_by at the literal null. The
    map is empty unless this record is valid in every respect, so a defect
    anywhere here restores the unconditional pin rather than relaxing it: the
    fail-closed direction is the one where nobody is seated.
    """
    before = len(errors)
    try:
        text = (BADF / "bootstrap.yaml").read_text(encoding="utf-8")
    except OSError as exc:
        errors.append(f"badf/bootstrap.yaml: cannot read: {exc}")
        return {}

    record, problems = parse_bootstrap(text)
    errors.extend(problems)
    scalars = record["scalars"]
    seatings = record["seatings"]

    # The roles and the routing table this record has to agree with. Parse
    # problems here are validate_agents_registry's to report, not this
    # function's: one malformed line should be one error, not two.
    try:
        agents_text = (BADF / "agents.yaml").read_text(encoding="utf-8")
    except OSError as exc:
        errors.append(
            f"badf/bootstrap.yaml: cannot read badf/agents.yaml to check it "
            f"against: {exc}"
        )
        return {}
    roles, routing, _ = parse_agents(agents_text)

    for field, allowed, expectation in BOOTSTRAP_LITERALS:
        value = scalars.get(field, "").strip()
        if value in allowed:
            continue
        errors.append(
            f"badf/bootstrap.yaml: records {field} as {value!r}, and it must be "
            f"{expectation}"
        )

    # Constraint 3, in the shape validate_lifecycle_pins uses for the
    # acceptance transition: the sentence has to be PRESENT and UNMODIFIED.
    # Whitespace is normalised because the statement is a folded scalar and
    # where the folding falls is not part of what it says.
    if BOOTSTRAP_STATEMENT not in " ".join(text.split()):
        errors.append(
            "badf/bootstrap.yaml: does not carry the establishment statement "
            "verbatim. That sentence is what tells a later reader that the "
            "operator instruction was the mechanism which adopted the succession "
            "rule and not a standing parallel authority path, and a sentence that "
            "can be reworded is a sentence that will be"
        )

    block = bootstrap_historical_block(text)
    if block is None:
        errors.append(
            f"badf/bootstrap.yaml: does not delimit a historical record with exactly "
            f"one {BOOTSTRAP_BEGIN!r} line and one {BOOTSTRAP_END!r} line after it. "
            f"The frozen region is what the digest in badf/current-state.json is "
            f"taken over, so a record with no region can never be frozen"
        )

    # C-1, first half. A region present, ordered, and enclosing nothing hashed
    # the empty string - e3b0c442..., the sha256 every reader recognises - and
    # passed, with every historical field sitting outside it.
    if block is not None and block.strip() == "":
        errors.append(
            "badf/bootstrap.yaml: the frozen historical region encloses no content at "
            "all. The sha256 of nothing is a digest that binds nothing, and it is "
            "recorded at the one moment - the first seating - when there is nothing "
            "to compare it against, so it would never be caught later either"
        )

    # C-1, second half, and the one with the sharper attack behind it. With the
    # END marker moved so the region held only act_id, a seating was recorded
    # for Alice, the digest taken, and then the principal rewritten to Mallory
    # in badf/bootstrap.yaml AND badf/agents.yaml with the ledger untouched -
    # exit 0, one forger, one pair of files, digest still matching. Every line
    # this reader classified, except the two that are legitimately mutable,
    # must be inside the region the digest covers.
    span = bootstrap_region(text)
    if span is not None:
        for number, what in record["classified"]:
            if what in ("version", "updated_at") or span[0] < number < span[1]:
                continue
            errors.append(
                f"badf/bootstrap.yaml line {number}: {what} is recorded OUTSIDE the "
                f"frozen historical region (lines {span[0]}-{span[1]}). The digest in "
                f"badf/current-state.json is taken over that region and nothing else, "
                f"so a field outside it is a field this record's immutability does not "
                f"cover, in a file that still reads as though it were frozen whole"
            )

    declared_state = scalars.get("state", "").strip()
    dual = scalars.get("temporary_dual_seat", "").strip()
    expiry = scalars.get("expiry", "").strip()
    trigger = scalars.get("separation_trigger", "").strip()
    exception = scalars.get("exception_type", "").strip()

    # Review finding M3: the pins. Each is a separate rule with a separate
    # control, because a check that four conditions share cannot be observed
    # enforcing any one of them. See BOOTSTRAP_PINNED_ACT for why they are code.
    if scalars.get("act_id", "").strip() != BOOTSTRAP_PINNED_ACT:
        errors.append(
            f"badf/bootstrap.yaml: records act {scalars.get('act_id', '')!r}, and "
            f"{BOOTSTRAP_PINNED_ACT} is the only bootstrap act there is. The capability "
            f"is single-use and was spent by that act; a second act is pinned out in "
            f"scripts/validate_continuity.py because a ledger in a data file can be "
            f"edited to agree with it. A legitimate later act is a reviewed change to "
            f"that pin, under a Work Package that says why"
        )

    if declared_state != BOOTSTRAP_PINNED_STATE:
        errors.append(
            f"badf/bootstrap.yaml: records state {declared_state!r}, and the spent act "
            f"is pinned as {BOOTSTRAP_PINNED_STATE} in scripts/validate_continuity.py. "
            f"Reverting a spent act makes it unspent, which reopens the seating every "
            f"other pin then guards nothing about"
        )

    if declared_state == BOOTSTRAP_SEATED and not seatings:
        errors.append(
            f"badf/bootstrap.yaml: records state {BOOTSTRAP_SEATED} and no seating at "
            f"all. A single-use capability recorded as spent having seated nobody is "
            f"the bypass consumed with nothing to show for it: the act is gone, no "
            f"office is filled, and the next vacancy has neither an operator "
            f"instruction nor an unspent one to reach for. This is the mirror of the "
            f"declared dual seat that no principal holds, and it is refused for the "
            f"same reason - a declaration with nothing behind it"
        )

    seats_named: list[str] = []
    seated: dict[str, str] = {}
    for position, seating in enumerate(seatings, start=1):
        seat = seating.get("seat", "").strip()
        principal = seating.get("principal", "").strip()
        line = seating.get("__line__", "?")

        if seat in seats_named:
            errors.append(
                f"badf/bootstrap.yaml: seating {position} (line {line}) names seat "
                f"{seat!r}, which an earlier seating in this record already names. "
                f"One seat, seated twice in one act, is two claims about the same "
                f"office and this reader would take the later one"
            )
        seats_named.append(seat)

        if seat not in roles:
            errors.append(
                f"badf/bootstrap.yaml: seating {position} (line {line}) names seat "
                f"{seat!r}, which is no role declared in badf/agents.yaml. A record "
                f"that seats an office no registry declares creates the office and "
                f"the occupant in one unreviewed act"
            )
        elif roles[seat].get("may_be_an_agent", "").strip().strip('"') != "false":
            errors.append(
                f"badf/bootstrap.yaml: seating {position} (line {line}) names seat "
                f"{seat!r}, whose may_be_an_agent is not false. This mechanism exists "
                f"for human-only seats: a seat an agent may occupy is not blocked by "
                f"the loop this record breaks, and bootstrapping one would hand an "
                f"agent a seat by an act no seat reviewed"
            )

        if declared_state == BOOTSTRAP_AWAITING and principal != "null":
            errors.append(
                f"badf/bootstrap.yaml: seating {position} (line {line}) records "
                f"principal {principal!r} while state is {BOOTSTRAP_AWAITING}. This "
                f"record is the SHAPE of a seating and not one: the principal is the "
                f"operator's to name, and until the state says {BOOTSTRAP_SEATED} it "
                f"is the literal null"
            )

        if declared_state == BOOTSTRAP_SEATED and principal in ("", "null"):
            errors.append(
                f"badf/bootstrap.yaml: seating {position} (line {line}) records no "
                f"principal while state is {BOOTSTRAP_SEATED}. A seating with no "
                f"named human seats nobody, and an agent may not supply the name: the "
                f"repository's git identity is a fact about a machine, not a decision "
                f"about who holds an office"
            )
            continue

        if declared_state != BOOTSTRAP_SEATED:
            continue

        held = roles.get(seat, {}).get("held_by", "").strip().strip('"')
        if held != principal:
            errors.append(
                f"badf/bootstrap.yaml: seating {position} (line {line}) records seat "
                f"{seat!r} as seated by {principal!r}, and badf/agents.yaml records "
                f"that seat's held_by as {held!r}. The two records must agree in BOTH "
                f"directions - a bootstrap record naming a seat nobody holds is a "
                f"claim of authority with no occupant, exactly as an occupant no "
                f"bootstrap record names is an occupant nothing seated"
            )
            continue
        seated[seat] = principal

    # M3, the seats and the frozen text of the one act that was spent.
    if declared_state == BOOTSTRAP_SEATED:
        if sorted(seats_named) != sorted(BOOTSTRAP_PINNED_SEATS):
            errors.append(
                f"badf/bootstrap.yaml: the record seats {sorted(seats_named)}, and "
                f"{BOOTSTRAP_PINNED_ACT} seated exactly {sorted(BOOTSTRAP_PINNED_SEATS)}. "
                f"That is pinned in scripts/validate_continuity.py, not in the ledger, "
                f"because a ledger can be edited to agree with a second seating. Seating "
                f"another office is a reviewed change to the pin, or the succession rule"
            )
        pinned_computed = bootstrap_digest(block) if block is not None else None
        if pinned_computed != BOOTSTRAP_PINNED_DIGEST:
            errors.append(
                f"badf/bootstrap.yaml: the frozen historical region hashes to "
                f"{pinned_computed!r}, and the digest pinned in "
                f"scripts/validate_continuity.py for {BOOTSTRAP_PINNED_ACT} is "
                f"{BOOTSTRAP_PINNED_DIGEST!r}. A digest recorded in badf/current-state.json "
                f"can be repaired to match an edited record; this one cannot"
            )

    # Constraint 4. DECLARED SEPARATION = ACTUAL SEPARATION, and the rule is
    # written in both directions on purpose: a dual seat that is not declared
    # is a separation of duties this repository's routing table claims to have
    # and does not, and a declaration with no dual seat is an expiring
    # exception nothing will ever trigger, sitting in the record as cover.
    holders: dict[str, list[str]] = {}
    for seat, principal in seated.items():
        holders.setdefault(principal, []).append(seat)
    doubled = sorted(
        (principal, sorted(held_seats))
        for principal, held_seats in holders.items()
        if len(held_seats) > 1
    )

    if doubled and dual != "true":
        errors.append(
            f"badf/bootstrap.yaml: {doubled[0][0]!r} is recorded as the occupant of "
            f"{doubled[0][1]} and temporary_dual_seat is {dual!r}. One principal in "
            f"two seats IS the collapse of the separation of duties the routing table "
            f"exists to create; it may be unavoidable, and it is then a recorded, "
            f"expiring exception - never a silence"
        )

    if not doubled and dual == "true":
        errors.append(
            "badf/bootstrap.yaml: declares temporary_dual_seat: true and no principal "
            "in this record holds two seats. A declared exception with nothing to "
            "except is an expiry nothing will trigger and a separation nobody has to "
            "restore: declared separation must equal actual separation in both "
            "directions"
        )

    if dual == "true" and exception != BOOTSTRAP_EXCEPTION_TYPE:
        errors.append(
            f"badf/bootstrap.yaml: declares temporary_dual_seat: true with "
            f"exception_type {exception!r}, and it must be the literal "
            f"{BOOTSTRAP_EXCEPTION_TYPE}. An exception whose type nothing constrains "
            f"is a permanent one"
        )

    if dual == "true" and (
        BOOTSTRAP_DATE.match(expiry) is None or trigger in ("", "null")
    ):
        errors.append(
            f"badf/bootstrap.yaml: declares temporary_dual_seat: true with expiry "
            f"{expiry!r} and separation_trigger {trigger!r}. A dual seat records BOTH: "
            f"a date it ends on and the event that ends it. An exception with no "
            f"expiry and no trigger is the permanent arrangement it says it is not"
        )

    if dual != "true" and (
        exception not in ("", "null")
        or expiry not in ("", "null")
        or trigger not in ("", "null")
    ):
        errors.append(
            f"badf/bootstrap.yaml: records temporary_dual_seat {dual!r} and still "
            f"carries exception_type {exception!r}, expiry {expiry!r} and "
            f"separation_trigger {trigger!r}. Only the expiry being in the PAST was "
            f"checked, so a future date sat here reading as a live exception that no "
            f"rule above governs - and an expiry with no exception to expire is a date "
            f"nothing will ever read"
        )

    now = str(state.get("updated_at") or "") if isinstance(state, dict) else ""
    if BOOTSTRAP_DATE.match(expiry) is not None and expiry[:10] < now[:10]:
        errors.append(
            f"badf/bootstrap.yaml: the dual-seat exception expired on {expiry[:10]}, "
            f"and the records were updated on {now[:10]}. An expired exception is a "
            f"stop condition, not a live one, and a dual seat that outlives its own "
            f"expiry is the permanent collapse of duties it was granted not to be"
        )

    # The consumption ledger, which lives in badf/current-state.json because a
    # record attesting to its own single use attests to nothing.
    ledger = state.get("bootstrap") if isinstance(state, dict) else None
    if not isinstance(ledger, dict):
        errors.append(
            "badf/current-state.json: records no bootstrap block, so nothing outside "
            "badf/bootstrap.yaml says which act was spent, on which seats, or over "
            "what text - and a record that is its own only witness is not a witness"
        )
        return {}

    if str(ledger.get("state")) != declared_state:
        errors.append(
            f"badf/current-state.json: records bootstrap.state "
            f"{ledger.get('state')!r} and badf/bootstrap.yaml records state "
            f"{declared_state!r}. Two records that disagree about whether anyone is "
            f"seated leave a reader to pick, and a reader picks the one that helps"
        )

    if str(ledger.get("act_id")) != scalars.get("act_id", "").strip():
        errors.append(
            f"badf/current-state.json: the bootstrap capability was spent by act "
            f"{ledger.get('act_id')!r} and badf/bootstrap.yaml now records act "
            f"{scalars.get('act_id', '')!r}. It is SINGLE-USE: a second act is not a "
            f"second bootstrap, it is the persistent bypass this mechanism was built "
            f"to refuse"
        )

    recorded_seats = ledger.get("seats")
    recorded_seats = sorted(recorded_seats) if isinstance(recorded_seats, list) else []
    if recorded_seats != sorted(seated):
        errors.append(
            f"badf/current-state.json: the bootstrap capability was consumed seating "
            f"{recorded_seats} and badf/bootstrap.yaml now seats {sorted(seated)}. A "
            f"consumed record may not be reused for another seat: what the act seated "
            f"is what it seated, and the next vacancy is the succession rule's, not "
            f"this record's"
        )

    recorded = ledger.get("historical_digest")
    if declared_state == BOOTSTRAP_AWAITING and recorded is not None:
        errors.append(
            f"badf/current-state.json: records a bootstrap historical_digest while "
            f"badf/bootstrap.yaml is still {BOOTSTRAP_AWAITING}. Nothing is frozen "
            f"until something is seated, and a digest recorded early is a digest "
            f"chosen before the text it is supposed to bind"
        )

    if declared_state == BOOTSTRAP_SEATED:
        computed = bootstrap_digest(block) if block is not None else None
        if recorded != computed:
            errors.append(
                f"badf/current-state.json: records bootstrap historical_digest "
                f"{recorded!r} and the frozen region of badf/bootstrap.yaml hashes to "
                f"{computed!r}. Once a principal is named the historical record is "
                f"fixed: the seat this act created may not rewrite the act that "
                f"created it, and an edit that repairs the digest is an edit to a "
                f"second governed record with a second reviewer"
            )

    # Constraint 2, the structural half, and now the WHOLE rule for this path.
    #
    # It was three rules until round two: a static PINNED_ROUTING entry naming
    # two specific seats, plus this dynamic one. The review showed the dynamic
    # rule was entirely subsumed - no routing the static pin allowed could ever
    # trigger it - and that the escape hatch was not neutral: PINNED_ROUTING
    # lives in scripts/validate_continuity.py, which badf/agents.yaml routes to
    # platform-engineer / peer-reviewer, BOTH seats an agent may occupy. So a
    # governance collision about who reviews the seating record would have been
    # resolved through a file an agent may own AND verify. The static pin is
    # gone and this rule states the whole requirement instead: routed at all,
    # to human-only seats, neither of which this record seats.
    routes = [
        route
        for route in routing
        if route.get("path", "").strip().strip('"') == "badf/bootstrap.yaml"
    ]
    if not routes:
        errors.append(
            "badf/agents.yaml: records no routing entry for 'badf/bootstrap.yaml'. A "
            "path with no row routes to peer-reviewer and stops (this file's own "
            "note), and peer-reviewer is a seat an agent may occupy - so deleting the "
            "row is how the record of who was seated becomes reviewable by an agent "
            "without anyone recording that"
        )
    for route in routes:
        for field in ("owner", "verifier"):
            value = route.get(field, "").strip().strip('"')
            if value in seats_named:
                errors.append(
                    f"badf/agents.yaml: routes 'badf/bootstrap.yaml' {field} to "
                    f"{value!r}, which is a seat badf/bootstrap.yaml seats. A record "
                    f"that created a seat's authority may not be owned or reviewed by "
                    f"that seat: this record is non-self-amending, or it is a "
                    f"self-appointment with extra steps"
                )
                continue
            if roles.get(value, {}).get("may_be_an_agent", "").strip().strip('"') != "false":
                errors.append(
                    f"badf/agents.yaml: routes 'badf/bootstrap.yaml' {field} to "
                    f"{value!r}, which is not a seat pinned may_be_an_agent: false. "
                    f"This record decides who holds an office; a seat an agent may "
                    f"occupy reviewing a change to it is an agent reviewing the "
                    f"creation of authority"
                )

    if len(errors) != before:
        return {}
    return seated


#: The two sentences of badf/agents.yaml's succession rule that the mechanism
#: in badf/bootstrap.yaml depends on, pinned in the shape
#: validate_lifecycle_pins uses for the acceptance transition. The first makes
#: the rule apply to the FIRST fill; the second makes every later change
#: ordinary. Delete either and the file still reads as though it had a
#: succession rule.
SUCCESSION_PINS = (
    (
        "The first fill of a seat whose may_be_an_agent is false is verified by a "
        "different seat whose may_be_an_agent is false.",
        "the rule that a human-only seat's FIRST occupant is verified by a "
        "DIFFERENT human-only seat, which is what keeps an agent from ever being "
        "the verifier of a seating",
    ),
    (
        "Every subsequent change to that seat's occupancy is verified normally by "
        "the routing table above.",
        "the sentence that makes this a RULE and not a standing exception: once a "
        "seat is filled, its occupancy is routed like everything else, and the "
        "bootstrap path is not available a second time",
    ),
)


def succession_body(text: str, opener) -> str:
    """The body of the succession: key, comments removed.

    Round two deleted the key outright, left the two pinned sentences as
    ordinary ``#`` comments, and the whole-file substring search passed. A rule
    demoted to a comment is not a rule of the file, so the search is scoped to
    the key's own block and comment lines inside it do not count.
    """
    if opener is None:
        return ""
    lines = text.replace("\r\n", "\n").split("\n")
    body: list[str] = []
    for line in lines[text[: opener.start()].count("\n") + 1 :]:
        if line.strip() == "":
            continue
        if not line.startswith("  "):
            break
        if line.lstrip().startswith("#"):
            continue
        body.append(line)
    return " ".join(" ".join(body).split())


def validate_agents_succession_rule(errors: list[str]) -> None:
    """The succession rule is present and unmodified.

    Round three rewrote a lifecycle transition to requires_human: false and the
    validator passed, which is why validate_lifecycle_pins exists. The same
    treatment applies here for a stronger reason: this rule is the whole answer
    to "who verifies the NEXT vacancy", and a rule an agent can edit is a rule
    an agent does not have.
    """
    try:
        text = (BADF / "agents.yaml").read_text(encoding="utf-8")
    except OSError as exc:
        errors.append(f"badf/agents.yaml: cannot read: {exc}")
        return

    opener = re.search(r"^succession:[ ]*(\S*)[ ]*$", text, re.MULTILINE)
    if opener is None:
        errors.append(
            "badf/agents.yaml: declares no top-level succession: key. The rule that "
            "decides who verifies the FIRST fill of a human-only seat is a rule OF "
            "this file, beside roles: and routing: - not prose beside it. Both readers "
            "of this file were taught the key in the same change; a pin that searched "
            "the whole text for two sentences would have accepted them demoted to "
            "comments, which is what a rule stops being when nothing parses it"
        )

    flat = succession_body(text, opener)
    for sentence, what in SUCCESSION_PINS:
        if sentence in flat:
            continue
        errors.append(
            f"badf/agents.yaml: the succession rule no longer states, verbatim, "
            f"{what}. badf/bootstrap.yaml records that this rule was adopted by a "
            f"single-use operator instruction which is already spent, so a rule "
            f"edited away here cannot be re-adopted: it can only be restored by a "
            f"reviewed change that says why"
        )


# ---------------------------------------------------------------------------
# badf/signing-policy.yaml: WHO wrote a record, not what it says.
#
# Every other check in this file constrains what a record may SAY. None of them
# constrains who WROTE it, and a forgery that edits badf/authority.yaml,
# badf/current-state.json and the checkpoint CONSISTENTLY passes all of them -
# because this validator reads the same files the forger writes. No reader can
# close that. The only thing that can is a signature the acting agent cannot
# produce, which is why the policy exists and why this section validates its
# shape rather than trusting it.
#
# What is here is the POLICY's integrity. The signature verification itself is
# scripts/check-signing.mjs, which needs git and does not belong in a reader.
# The two are deliberately in different languages over the same file, for the
# reason scripts/agents-registry.mjs states: two readers that must
# independently agree are harder to fool with one clever line than one.
# ---------------------------------------------------------------------------

#: The scalar keys of the policy. Each carries its value on its own line.
SIGNING_SCALARS = ("version", "updated_at", "enforcement_point")

#: The fields an accepted-key entry may carry. Unknown to this set is refused,
#: not skipped - the doctrine parse_authority documents at length.
SIGNING_KEY_FIELDS = {"identity", "kind", "enrolled_by", "note"}

#: The signature kinds git can verify. A closed set, so a key recorded with a
#: kind nothing implements cannot sit in the policy looking enrolled.
SIGNING_KEY_KINDS = ("gpg", "ssh")

#: The literal that says, in the file itself, that no human identity is bound
#: to this repository. It is not a placeholder: it is the accurate statement of
#: the current state, and `grep NONE_ENROLLED badf/signing-policy.yaml` is how
#: a reader finds out in one command.
NO_KEYS_ENROLLED = "NONE_ENROLLED"

#: The enforcement point, when it is not an explicit sha: the commit that added
#: the policy, resolved from git by scripts/check-signing.mjs. The sha cannot
#: be written into the file it is the sha of, and no commit before the policy
#: existed may be required to carry a signature - no commit on this branch is
#: signed and rewriting history is not a repair.
ENFORCEMENT_POINT_LITERAL = "FIRST_COMMIT_OF_THIS_POLICY"

COMMIT_SHA = re.compile(r"^[0-9a-f]{40}$")

#: A plain relative path: no wildcard, no leading dash, no leading slash,
#: nothing a shell or `git log` could read as an option. The check hands these
#: to git as pathspecs, so the shape is a security boundary and not a tidiness
#: rule.
#:
#: One leading dot is allowed, and only when a name follows it, so `.github` is
#: a plain path while `.`, `..` and `./x` are not. `.` would be a pathspec for
#: the whole tree. scripts/signing-policy.mjs carries the same shape.
PROTECTED_PATH = re.compile(r"^\.?[A-Za-z0-9_][A-Za-z0-9._/-]*$")

#: The paths whose protection is PINNED here, in the same doctrine as
#: PINNED_SKILL_STATUS and PINNED_ROUTING: the data file is a FLOOR the records
#: cannot shrink. Adding a path to badf/signing-policy.yaml widens protection
#: and is allowed; removing one of these is a reviewed change to this validator,
#: under a Work Package that says why.
#:
#: Deny by default rather than an extendable list: every governance record is
#: named here, including the policy itself. A policy that does not protect the
#: file naming which keys are accepted protects nothing at all.
PINNED_PROTECTED_PATHS = (
    "badf/authority.yaml",
    "badf/gates.yaml",
    "badf/current-state.json",
    "badf/lifecycle.yaml",
    "badf/agents.yaml",
    "badf/skills.yaml",
    "badf/signing-policy.yaml",
    "badf/bootstrap.yaml",
    "sessions/checkpoints",
    # Review finding M5: the instrument. A one-line edit to
    # scripts/check-signing.mjs (`if (verdict.verified || true) continue;`)
    # turned an enforcing check into a false PASS, because the checker ships
    # inside the change it judges and CI runs the PR's own copy. The checker,
    # its reader, this validator (which holds every pin), the schemas the state
    # is validated against, the scripts that run all of it and the workflow
    # that calls them are governance, not tooling.
    "scripts/check-signing.mjs",
    "scripts/signing-policy.mjs",
    "scripts/validate_continuity.py",
    "schemas",
    "package.json",
    ".github",
    # Round seven N2. `validate:records` and `test:validator` both run through
    # the launcher, and a key-enrolled tree with one injected line in it
    # printed PASS for both. The tests that witness the signing check, and the
    # sweep that witnesses the tests, ship in the change they judge, and the
    # decision log and the next-action list are records an agent writes.
    "scripts/python.mjs",
    "scripts/mutation-check.mjs",
    "tests/unit",
    "tests/signing",
    "badf/decision-log.jsonl",
    "badf/next-actions.json",
)

#: The identity that signs every commit GitHub's own merge writes, and that
#: no policy may ever accept (review finding M4).
#:
#: GitHub's merge button writes squash merges committed by
#: `GitHub <noreply@github.com>` and signed by GitHub's web-flow key. Five of
#: them (#4 to #7 and #9) are on PR #1's head branch; main itself still holds
#: only its "Initial commit", so this is what a squash merge into main WOULD do,
#: seen in how those five behaved. Enrolling THAT key turns this check green for
#: every change merged in the web UI - including one an agent authored and a human never read - so the
#: signature would bind nothing to a person. A person's own signature does not
#: survive a squash merge through the UI, which is the incompatibility
#: badf/signing-policy.yaml states. Which merge strategy resolves it is a human
#: decision this validator does not make; what it does is refuse the one
#: "solution" that makes the check pass while meaning nothing.
#:
#: Two literals and two separate rules below, so each has a control and a
#: mutation of its own: git reports the signer (%GS) and the key (%GK)
#: separately, and a policy can name either.
WEB_FLOW_KEY_ID = "B5690EEEBB952194"
WEB_FLOW_COMMITTER_EMAIL = "noreply@github.com"

#: What an accepted-key entry must record, as one alternation rather than three
#: hand-written conditions, for the reason VERDICT_TERMS in
#: scripts/mutation-attribution.mjs is one: a rule written as a table entry is
#: one deletable line, so it can carry a mutation and a control of its own,
#: while three conditions inside one function share a single mutation and hide
#: which of them is actually enforced.
#:
#: (field, allowed values or None for "any non-empty", what it must be)
ACCEPTED_KEY_RULES = (
    ("identity", None, "a non-empty signer identity, matched against git's own %GS and %GK"),
    ("kind", SIGNING_KEY_KINDS, f"one of {list(SIGNING_KEY_KINDS)}, the kinds git can verify"),
    (
        "enrolled_by",
        AGENT_FORBIDDEN_ROLES,
        f"one of {list(AGENT_FORBIDDEN_ROLES)} - enrolling a key is a human act, "
        f"and a key an agent-occupiable seat enrolled binds nobody",
    ),
)


def parse_signing_policy(text: str) -> tuple[dict, list[str]]:
    """Reads badf/signing-policy.yaml, refusing every line it cannot classify.

    A sibling of parse_authority, parse_skills and parse_agents, and written
    for the reason parse_authority documents at length: an earlier reader in
    this repository SKIPPED what it did not recognise, and peer review round
    three defeated it five ways with ordinary, legal YAML. So the default here
    is an error. A line that is not blank, not a comment and not one of the
    shapes below is a problem, whatever it happens to look like - a tab, a
    three-space indent, a flow mapping, a list item under a scalar key.

    The catch-all is deliberately ONE refusal covering all of those rather than
    a branch per shape: what matters is that an unclassified line is refused
    WITH ITS NUMBER, not that the reader has an opinion about which way it is
    malformed.

    Returns a policy of

        {"scalars": {key: value}, "protected_paths": [(line, value)],
         "accepted_keys": [{field: value}], "accepted_keys_inline": str | None}

    where accepted_keys_inline is None when the file never names the key at
    all, which is a different thing from naming it and enrolling nothing.
    """
    policy: dict = {
        "scalars": {},
        "protected_paths": [],
        "accepted_keys": [],
        "accepted_keys_inline": None,
    }
    problems: list[str] = []
    section: str | None = None
    entry: dict[str, str] | None = None
    block_indent: int | None = None
    seen_top: set[str] = set()

    for number, raw in enumerate(text.splitlines(), start=1):
        if raw.strip() == "" or raw.lstrip().startswith("#"):
            continue

        indent = len(raw) - len(raw.lstrip(" "))

        # A folded or literal scalar's body is prose, and is not read for
        # meaning. Same treatment as every other reader in this file.
        if block_indent is not None:
            if indent >= block_indent:
                continue
            block_indent = None

        # A tab is not "an indent this reader disagrees with". A tab-indented
        # block made a whole section invisible to the reader parse_authority
        # replaces, so a line containing one matches no rule below and lands on
        # the catch-all, with its number.
        tabless = "\t" not in raw

        if tabless and indent == 0:
            top = re.match(r"^(\S+):[ ]*(.*)$", raw)
            if top is not None:
                key, value = top.group(1), top.group(2).strip()
                section = None
                entry = None
                refuse_value("badf/signing-policy.yaml", number, key, value, problems)
                refuse_repeat(
                    "badf/signing-policy.yaml", number, key, "this file", seen_top, problems
                )
                seen_top.add(key)
                if key in SIGNING_SCALARS:
                    policy["scalars"][key] = value.strip('"')
                    continue
                if key == "protected_paths":
                    section = "protected_paths"
                    continue
                if key == "accepted_keys":
                    section = "accepted_keys"
                    policy["accepted_keys_inline"] = value.strip('"')
                    continue
                problems.append(
                    f"badf/signing-policy.yaml line {number}: unknown top-level key "
                    f"{key!r}. A key nothing reads is a key a forger fills in while "
                    f"the file still looks authoritative"
                )
                continue

        if tabless and indent == 2 and section == "protected_paths":
            item = re.match(r"^ {2}- (\S+)[ ]*$", raw)
            if item is not None:
                refuse_value(
                    "badf/signing-policy.yaml", number, "protected_paths item",
                    item.group(1), problems,
                )
                policy["protected_paths"].append((number, item.group(1).strip('"')))
                continue

        if tabless and indent == 2 and section == "accepted_keys":
            opener = re.match(r"^ {2}- identity:[ ]*(\S.*)$", raw)
            if opener is not None:
                refuse_value(
                    "badf/signing-policy.yaml", number, "identity",
                    opener.group(1).strip(), problems,
                )
                entry = {
                    "identity": opener.group(1).strip().strip('"'),
                    "__line__": str(number),
                }
                policy["accepted_keys"].append(entry)
                continue

        if tabless and indent == 4 and section == "accepted_keys" and entry is not None:
            field_match = re.match(r"^ {4}(\S+):[ ]*(.*)$", raw)
            if field_match is not None:
                field, value = field_match.group(1), field_match.group(2).strip()
                if field not in SIGNING_KEY_FIELDS:
                    problems.append(
                        f"badf/signing-policy.yaml line {number}: unknown field "
                        f"{field!r} on an accepted key. A field this reader drops is "
                        f"a field a human reading the file still sees, and believes"
                    )
                    continue
                if refuse_value("badf/signing-policy.yaml", number, field, value, problems):
                    continue
                if refuse_repeat(
                    "badf/signing-policy.yaml", number, field,
                    f"the accepted key at line {entry['__line__']}", entry, problems,
                ):
                    continue
                if value in (">", ">-", "|", "|-", ""):
                    block_indent = 6
                    value = ""
                entry[field] = value.strip('"')
                continue

        problems.append(
            f"badf/signing-policy.yaml line {number}: matches no rule of this "
            f"policy's grammar, or names a field with no accepted key open: "
            f"{raw.strip()!r}. This reader refuses what it cannot classify rather "
            f"than skipping it"
        )

    return policy, problems


def validate_signing_policy(errors: list[str]) -> None:
    """The policy's shape, which is what the signature check stands on.

    A malformed policy is worse than no policy: scripts/check-signing.mjs reads
    the same file, and a path it cannot see is a path nothing verifies while
    the file still lists it. Nothing here verifies a signature - that needs git
    - and nothing here can be satisfied by an agent, which is the point:
    ACCEPTED_KEY_RULES refuses any key an agent-occupiable seat enrolled, so an
    agent that writes itself into the policy is refused by the policy's own
    validator.
    """
    try:
        text = (BADF / "signing-policy.yaml").read_text(encoding="utf-8")
    except OSError as exc:
        errors.append(f"badf/signing-policy.yaml: cannot read: {exc}")
        return

    policy, problems = parse_signing_policy(text)
    errors.extend(problems)

    # The enforcement point. An unreadable one is not "no enforcement point";
    # it is a scope nothing can compute, and a scope nothing can compute is a
    # check that silently governs nothing.
    point = policy["scalars"].get("enforcement_point", "").strip()
    if point != ENFORCEMENT_POINT_LITERAL and COMMIT_SHA.match(point) is None:
        errors.append(
            f"badf/signing-policy.yaml: enforcement_point is {point!r}, which is "
            f"neither the literal {ENFORCEMENT_POINT_LITERAL} nor a 40-character "
            f"commit sha. The enforcement point is where the policy starts "
            f"applying, so a value nothing can resolve scopes the check to nothing "
            f"at all"
        )

    # The protected paths, in both directions the skills roster is checked in.
    # Direction one: the shape, because these are handed to git as pathspecs.
    recorded = set()
    for number, path in policy["protected_paths"]:
        recorded.add(path)
        if PROTECTED_PATH.match(path) is None or ".." in path.split("/"):
            errors.append(
                f"badf/signing-policy.yaml line {number}: protected path {path!r} is "
                f"not a plain relative path. These are handed to git as pathspecs, so "
                f"a leading dash, a wildcard or a .. segment is a path that resolves "
                f"to something other than what it reads as"
            )

    # Direction two: the floor. A path that is not listed is a path no signature
    # is ever required for, and deleting a line is how a governance record stops
    # being protected without anyone recording that.
    for pinned in PINNED_PROTECTED_PATHS:
        if pinned in recorded:
            continue
        errors.append(
            f"badf/signing-policy.yaml: {pinned!r} is pinned in "
            f"scripts/validate_continuity.py (PINNED_PROTECTED_PATHS) and this policy "
            f"does not protect it. A governance record no signature is ever required "
            f"for is a record any agent may write; widening this policy is allowed, "
            f"narrowing it is a reviewed change to the validator under a Work Package "
            f"that says why"
        )

    # accepted_keys says exactly one thing: no key is enrolled, or these keys
    # are. Not both, not neither, and not some third word.
    #
    # FOUR branches, and each one now carries a control of its own in
    # tests/unit/test_validator_fails_closed.py and a mutation of its own in
    # scripts/mutation-check.mjs. Until the final review of this branch they
    # shared ONE of each: the mutation rewrote the aggregation below
    # (`if said is not None:`), the one existing control caught it, and the
    # sweep printed a full house while three of these four could be DELETED
    # with the entire validator suite still green.
    #
    # The second branch is the one with a motive behind it. With it gone, a
    # policy that says NONE_ENROLLED and then lists an identity PASSES here;
    # scripts/signing-policy.mjs decides enrolment from whether an entry
    # parsed and never from the word, and says so; so the signature check
    # enforces against an identity nobody enrolled and stops printing
    # NOT_ENFORCED, while a human greps NONE_ENROLLED - the method this policy
    # file documents - and reads that nobody is bound to anything. The
    # branches stay four separate lines rather than an alternation table for
    # the same reason ACCEPTED_KEY_RULES below is a table: what matters is
    # that each rule is ONE deletable thing with one control and one mutation
    # against it, and these already are.
    inline = policy["accepted_keys_inline"]
    keys = policy["accepted_keys"]
    said = None
    if inline is None:
        said = "does not declare accepted_keys at all"
    elif inline == NO_KEYS_ENROLLED and keys:
        said = f"says {NO_KEYS_ENROLLED} and then lists {len(keys)} key(s)"
    elif inline == "" and not keys:
        said = "opens accepted_keys as a block and lists no key in it"
    elif inline not in ("", NO_KEYS_ENROLLED):
        said = f"records accepted_keys as {inline!r}"
    if said is not None:
        errors.append(
            f"badf/signing-policy.yaml: {said}. accepted_keys must state either the "
            f"literal {NO_KEYS_ENROLLED} - the honest current state, and what makes "
            f"scripts/check-signing.mjs report NOT_ENFORCED - or a block of one or "
            f"more entries. A policy that is ambiguous about whether anyone is "
            f"enrolled is read as enrolled by whoever benefits"
        )

    # Every enrolled key, against the alternation above.
    for position, key in enumerate(keys, start=1):
        for field, allowed, expectation in ACCEPTED_KEY_RULES:
            value = key.get(field, "").strip()
            if value != "" and (allowed is None or value in allowed):
                continue
            errors.append(
                f"badf/signing-policy.yaml: accepted key {position} (line "
                f"{key.get('__line__', '?')}) records {field} as {value!r}, and it "
                f"must be {expectation}"
            )

        # Review finding M4. Compared with case and spacing folded, and by
        # containment: git's %GK may print a 16-hex key id or a 40-hex
        # fingerprint that ends in it, and an identity may carry a 0x prefix.
        identity = "".join(key.get("identity", "").split()).casefold()
        line = key.get("__line__", "?")
        if WEB_FLOW_KEY_ID.casefold() in identity:
            errors.append(
                f"badf/signing-policy.yaml: accepted key {position} (line {line}) names "
                f"GitHub's web-flow signing key {WEB_FLOW_KEY_ID}. That key signs every "
                f"commit GitHub's merge writes, so accepting it makes the check pass any "
                f"change merged in the web UI, an agent-authored one included, and binds "
                f"nothing to a human. It is pinned in scripts/validate_continuity.py as "
                f"never acceptable"
            )
        if WEB_FLOW_COMMITTER_EMAIL in identity:
            errors.append(
                f"badf/signing-policy.yaml: accepted key {position} (line {line}) names "
                f"GitHub's web-flow committer identity (GitHub <{WEB_FLOW_COMMITTER_EMAIL}>). "
                f"That identity is the committer of every squash merge made in the web UI "
                f"and stands for no person. It is pinned in scripts/validate_continuity.py "
                f"as never acceptable"
            )


#: The delivery gates, and the states no agent may move a Work Package into
#: without a recorded acceptance by someone who is not its implementer.
DELIVERY_GATES = ("BT-G0", "BT-G1", "BT-G2", "BT-G3", "BT-G4")
TERMINAL_STATES = ("ACCEPTED", "CLOSED")


#: The grammar of badf/gates.yaml, for parse_lists. A field or a top-level key
#: outside these is refused, so the file cannot grow a shape only PyYAML reads.
GATES_SCALARS = {"version", "updated_at"}
GATES_ENTRY_LISTS = {
    "delivery_gates": (
        "id",
        {"name", "status", "recorded_by_role", "blocks", "evidence_required"},
    ),
    "instruments": (
        "id",
        {"command", "proves", "fails_closed_evidence", "gate_input_for"},
    ),
}
GATES_SCALAR_LISTS = {"not_covered"}

#: The grammar of badf/lifecycle.yaml, for parse_lists.
LIFECYCLE_SCALARS = {"version", "updated_at"}
LIFECYCLE_ENTRY_LISTS = {
    "transitions": ("from", {"to", "role", "requires_human", "condition"}),
}
LIFECYCLE_SCALAR_LISTS = {"states", "exceptional_states", "forbidden"}


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

    parsed, problems = parse_lists(
        "badf/gates.yaml",
        text,
        scalars=GATES_SCALARS,
        entry_lists=GATES_ENTRY_LISTS,
        scalar_lists=GATES_SCALAR_LISTS,
    )
    errors.extend(problems)

    recorded: dict[str, str] = {}
    for gate_entry in parsed["entries"]["delivery_gates"]:
        gate_id = unquoted(gate_entry["id"])
        if gate_id in recorded:
            errors.append(
                f"badf/gates.yaml line {gate_entry['__line__']}: duplicate id {gate_id!r}; "
                f"YAML keeps every entry and a reader may take either"
            )
            continue
        if "status" in gate_entry:
            recorded[gate_id] = gate_entry["status"]

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

    parsed, problems = parse_lists(
        "badf/lifecycle.yaml",
        text,
        scalars=LIFECYCLE_SCALARS,
        entry_lists=LIFECYCLE_ENTRY_LISTS,
        scalar_lists=LIFECYCLE_SCALAR_LISTS,
    )
    errors.extend(problems)

    acceptance = [
        t
        for t in parsed["entries"]["transitions"]
        if unquoted(t["from"]) == "ENGINEERING_READY" and unquoted(t.get("to", "")) == "ACCEPTED"
    ]
    if not acceptance:
        errors.append(
            "badf/lifecycle.yaml: records no ENGINEERING_READY -> ACCEPTED transition; "
            "the acceptance check has nothing to stand on"
        )
        return
    if len(acceptance) > 1:
        errors.append(
            "badf/lifecycle.yaml: records the ENGINEERING_READY -> ACCEPTED transition more "
            "than once. YAML keeps every entry, so a decoy that says requires_human: true "
            "beside the one that says false is two files"
        )
        return
    transition = acceptance[0]
    human = transition.get("requires_human", "")
    if human != "true":
        errors.append(
            "badf/lifecycle.yaml: ENGINEERING_READY -> ACCEPTED is recorded as "
            "requires_human: "
            f"{human!r}. Only a human accepts work (AGENTS.md "
            "section 5)"
        )
    if "not the implementer" not in unquoted(transition.get("role", "")):
        errors.append(
            "badf/lifecycle.yaml: the ENGINEERING_READY -> ACCEPTED role no longer "
            "excludes the implementer"
        )
    forbidden = {unquoted(item) for item in parsed["items"]["forbidden"]}
    if "Any transition into ACCEPTED made by the implementing agent" not in forbidden:
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


def tracked_files() -> set[str]:
    """The paths git tracks, as posix paths relative to ROOT.

    Empty when git cannot say (no repository, no git): then nothing is treated
    as tracked, which is the old behaviour, and the skip lists apply.
    """
    try:
        listing = subprocess.run(
            ["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return set()
    return {name.decode("utf-8", "replace") for name in listing.split(b"\0") if name}


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
        # Review finding m5. The four above missed these shapes: a review
        # planted each and the scan said nothing. Each is its own line so each
        # can carry its own control and its own mutation.
        (re.compile(r"gh[su]_[A-Za-z0-9]{20,}"), "a GitHub server or user token"),
        (re.compile(r"sk_live_[A-Za-z0-9]{20,}"), "a Stripe live key"),
        # Round seven m2: the two shapes the list above still missed.
        (re.compile(r"ghr_[A-Za-z0-9]{20,}"), "a GitHub refresh token"),
        (re.compile(r"rk_live_[A-Za-z0-9]{20,}"), "a Stripe restricted key"),
        (re.compile(r"AIza[0-9A-Za-z_-]{35}"), "a Google API key"),
        (re.compile(r"npm_[A-Za-z0-9]{30,}"), "an npm access token"),
        # Round nine S-5: three more shapes a review planted and the scan missed.
        (re.compile(r"glpat-[A-Za-z0-9_-]{20,}"), "a GitLab access token"),
        (re.compile(r"sk-ant-[A-Za-z0-9_-]{20,}"), "an Anthropic API key"),
        (re.compile(r"rk_test_[A-Za-z0-9]{20,}"), "a Stripe test restricted key"),
    ]
    # Build output and dependencies are not repository content, UNLESS git
    # tracks them. Round nine S-2: `dist/` and `__pycache__` are gitignored, and
    # `git add -f` puts a file there into CI's checkout all the same, so a skip
    # that ignored tracking was the one place a credential could sit unscanned.
    # Everything else is scanned, binaries included.
    tracked = tracked_files()
    skip_prefixes = (".git/", "node_modules/", "dist/", ".pnpm-store/")
    skip_segments = ("__pycache__",)
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(ROOT).as_posix()
        if relative.startswith(skip_prefixes) and relative not in tracked:
            continue
        if (
            any(segment in relative.split("/") for segment in skip_segments)
            and relative not in tracked
        ):
            continue
        # No exemption for this file (round seven m1). It used to be skipped
        # because it "names the patterns it searches for", but a pattern is a
        # regex and a regex does not match itself, so the exemption bought
        # nothing except a file that carries every pin and cannot be scanned.
        # tests/unit plants a token here and requires it to be found, and
        # requires the unmodified file to scan clean.
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
    seated = validate_bootstrap_record(state, errors)
    validate_agents_registry(errors, seated)
    validate_agents_succession_rule(errors)
    validate_signing_policy(errors)
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
