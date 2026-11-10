# What it does: unified-diff hunks → changed line numbers on each side
#
#   @@ -a,b +c,d @@   a/c: first line on the old/new side, b/d: line counts (default 1)
#   " " context (both sides advance), "-" removed (old side), "+" added (new side)
# A modified line shows up as a removed old line plus an added new line.

import re

HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


def parse_patch(patch: str | None) -> dict:
    """{"removed": set(old line numbers), "added": set(new line numbers), "hunks": [(a, b, c, d)]}."""
    removed: set[int] = set()
    added: set[int] = set()
    hunks: list[tuple[int, int, int, int]] = []
    if not patch:
        return {"removed": removed, "added": added, "hunks": hunks}
    old = new = None
    for line in patch.splitlines():
        m = HUNK_RE.match(line)
        if m:
            a, b, c, d = m.group(1), m.group(2), m.group(3), m.group(4)
            hunks.append((int(a), int(b) if b is not None else 1, int(c), int(d) if d is not None else 1))
            old, new = int(a), int(c)
            continue
        if old is None:
            continue  # before the first hunk (headers)
        if line.startswith("\\"):
            continue  # "\\ No newline at end of file"
        if line.startswith("-"):
            removed.add(old)
            old += 1
        elif line.startswith("+"):
            added.add(new)
            new += 1
        else:
            old += 1
            new += 1
    return {"removed": removed, "added": added, "hunks": hunks}
