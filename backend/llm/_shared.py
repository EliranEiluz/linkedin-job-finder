"""Shared helpers reused across provider modules."""

from __future__ import annotations

import json
import re


def parse_json_response(raw: str):
    """Extract the first balanced JSON object or array from a model reply.
    Mirrors search.py:_parse_claude_json — same logic, kept here so providers
    don't have to import the search module."""
    if not raw:
        return None
    raw = raw.strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```\s*$", "", raw)
    array_at = raw.find("[")
    object_at = raw.find("{")
    if object_at == -1 and array_at == -1:
        return None
    if object_at == -1:
        order = (("[", "]"),)
    elif array_at == -1:
        order = (("{", "}"),)
    elif object_at < array_at:
        order = (("{", "}"), ("[", "]"))
    else:
        order = (("[", "]"), ("{", "}"))
    for opener, closer in order:
        start = raw.find(opener)
        if start == -1:
            continue
        depth = 0
        in_str = False
        esc = False
        for i in range(start, len(raw)):
            ch = raw[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == opener:
                depth += 1
            elif ch == closer:
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(raw[start : i + 1])
                    except Exception:
                        break
    return None


# A single trivial job used by every provider's test() method.
TEST_BATCH = [
    {
        "id": "test-1",
        "title": "Senior Software Engineer",
        "company": "Acme",
        "location": "Remote",
        "priority": False,
        "description": "Backend engineering role. Python, distributed systems.",
    }
]

TEST_CV = "Senior software engineer with 8 years Python and distributed systems experience."
