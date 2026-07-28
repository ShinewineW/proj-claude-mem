#!/usr/bin/env python3
"""
Confine mock.module() pollution to the file that installs it.

bun's mock.module() is process-wide and mock.restore() does NOT undo it, so a
partial stub of a shared module leaks into every test file loaded afterwards.
That is why ~11 project-isolation test files pass alone and fail in the full
suite. This codemod captures the real module before the stub is installed and
re-registers it in afterAll, so the stub lives only for the file that wanted it.

Usage: python3 scripts/confine-test-mocks.py [--check]
"""

import re
import sys
from pathlib import Path

TESTS = Path("tests")

# Modules whose stubs demonstrably break other tests. Restricted to local src/
# modules: re-importing a third-party SDK or a node builtin for capture is both
# heavier and riskier than the pollution it would prevent.
TARGET_BASENAMES = {
    "paths.js",
    "SettingsDefaultsManager.js",
    "project-filter.js",
    "project-allowlist.js",
    "project-name.js",
    "project-db.js",
    "ProcessRegistry.js",
}

MOCK_RE = re.compile(r"mock\.module\(\s*(['\"])([^'\"]+)\1")
MARKER = "__CONFINED_MOCKS__"


def blank_comments(text: str) -> str:
    """Blank out comments, preserving length so indices still map to `text`.

    Several test files *describe* the pollution problem in a comment that
    quotes `mock.module('paths.js')`. Scanning raw text would treat that prose
    as a real call site and patch a file that installs no mock at all.
    """
    out = list(text)
    i, n = 0, len(text)
    while i < n:
        two = text[i : i + 2]
        if two == "//":
            while i < n and text[i] != "\n":
                out[i] = " "
                i += 1
        elif two == "/*":
            while i < n and text[i - 1 : i + 1] != "*/":
                if text[i] != "\n":
                    out[i] = " "
                i += 1
            if i < n and text[i] != "\n":
                out[i] = " "
            i += 1
        else:
            i += 1
    return "".join(out)


def targets_in(code: str) -> list[str]:
    seen, out = set(), []
    for _, spec in MOCK_RE.findall(code):
        if spec.rsplit("/", 1)[-1] in TARGET_BASENAMES and spec not in seen:
            seen.add(spec)
            out.append(spec)
    return out


def ensure_after_all_imported(text: str) -> str:
    """Add afterAll to the existing bun:test import if absent."""
    m = re.search(r"import\s*\{([^}]*)\}\s*from\s*(['\"])bun:test\2\s*;", text)
    if not m:
        return text
    names = [n.strip() for n in m.group(1).split(",") if n.strip()]
    if "afterAll" in names:
        return text
    names.append("afterAll")
    return (
        text[: m.start()]
        + f"import {{ {', '.join(names)} }} from 'bun:test';"
        + text[m.end() :]
    )


def patch(text: str) -> str | None:
    specs = targets_in(blank_comments(text))
    if not specs:
        return None

    if MARKER in text:
        captured = {
            spec
            for _, spec in re.findall(
                r"\[\s*(['\"])([^'\"]+)\1\s*,\s*\{\s*\.\.\.__real\d+\s*\}\s*\]",
                text,
            )
        }
        missing = [spec for spec in specs if spec not in captured]
        if not missing:
            return None

        indexes = [int(i) for i in re.findall(r"import \* as __real(\d+)", text)]
        next_index = max(indexes, default=-1) + 1
        imports, entries = [], []
        for spec in missing:
            alias = f"__real{next_index}"
            next_index += 1
            imports.append(f"import * as {alias} from '{spec}';")
            entries.append(f"  ['{spec}', {{ ...{alias} }}],")

        array_start = text.index("const __REAL_MODULES")
        text = text[:array_start] + "\n".join(imports) + "\n" + text[array_start:]
        array_start = text.index("const __REAL_MODULES")
        array_end = text.index("\n];", array_start)
        return text[:array_end] + "\n" + "\n".join(entries) + text[array_end:]

    text = ensure_after_all_imported(text)

    first = MOCK_RE.search(blank_comments(text))
    if first is None:
        return None
    # Insert at the start of the line holding the first mock.module call.
    line_start = text.rfind("\n", 0, first.start()) + 1

    imports, entries = [], []
    for i, spec in enumerate(specs):
        alias = f"__real{i}"
        imports.append(f"import * as {alias} from '{spec}';")
        entries.append(f"  ['{spec}', {{ ...{alias} }}],")

    block = (
        f"// {MARKER}: bun's mock.module() is process-wide and mock.restore() does\n"
        "// NOT undo it, so a partial stub below would leak into every test file\n"
        "// loaded after this one (project-isolation suites fail that way). Capture\n"
        "// the real modules first and re-register them in afterAll so the stubs\n"
        "// stay confined to this file.\n"
        + "\n".join(imports)
        + "\nconst __REAL_MODULES: Array<[string, unknown]> = [\n"
        + "\n".join(entries)
        + "\n];\nafterAll(() => {\n"
        "  for (const [spec, real] of __REAL_MODULES) mock.module(spec, () => real);\n"
        "});\n\n"
    )

    return text[:line_start] + block + text[line_start:]


def main() -> int:
    check = "--check" in sys.argv
    changed = []
    for f in sorted(TESTS.rglob("*.test.ts")):
        text = f.read_text()
        new = patch(text)
        if new is None:
            continue
        changed.append(f)
        if not check:
            f.write_text(new)

    for f in changed:
        print(("WOULD PATCH " if check else "patched ") + str(f))
    print(f"\n{len(changed)} file(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
