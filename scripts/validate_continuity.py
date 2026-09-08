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
