# What it does: parses every source file of a repo into the language-neutral IR
# Module 2: Parser
#
# Takes the dict returned by ingestion.py's fetch_repo() and dispatches each file
# by language: Python → languages/python.py (full support, scope-aware detail),
# everything else → languages/generic.py (tags queries). Output feeds graph_builder.py.

from languages import generic, registry
from languages.python import parse_file as parse_python_file


def parse_file(path: str, content: str, lang: str | None = None) -> dict:
    """Parse one file. `lang` defaults to the language of its extension (Python if unknown)."""
    lang = lang or registry.language_of(path) or "python"
    if lang == "python":
        return parse_python_file(path, content)
    return generic.parse_file(path, content, lang)


def language_summary(parsed_files: list[dict]) -> list[dict]:
    """[{lang, label, files, loc}] sorted by lines of code."""
    totals = {}
    for pf in parsed_files:
        row = totals.setdefault(pf.get("lang", "python"), {"files": 0, "loc": 0})
        row["files"] += 1
        row["loc"] += pf.get("loc", 0)
    return sorted(
        ({"lang": lang, "label": registry.label(lang), **row} for lang, row in totals.items()),
        key=lambda r: (-r["loc"], r["lang"]),
    )


def parse_repo(ingestion_output: dict) -> dict:
    """
    Takes the full dict from fetch_repo().
    Returns:
    {
      "repo": "owner/repo",
      "commit_sha": "abc12345",
      "parsed_files": [ ...one parse_file() output per file... ],
      "languages": [{lang, label, files, loc}],
      "manifests": {path: content}   # package.json etc., for entry points
    }
    """
    files = ingestion_output.get("files", [])
    total = len(files)
    parsed_files = []

    for file_entry in files:
        path = file_entry.get("path", "unknown")
        content = file_entry.get("content", "")
        lang = file_entry.get("lang") or registry.language_of(path)
        if lang is None:
            continue
        try:
            parsed_files.append(parse_file(path, content, lang))
        except Exception as e:
            print(f"[parser] Warning: Failed to parse {path}: {e}")
            continue

    print(f"[parser] Parsed {len(parsed_files)}/{total} files")

    return {
        "repo": ingestion_output.get("repo", ""),
        "commit_sha": ingestion_output.get("commit_sha", ""),
        "parsed_files": parsed_files,
        "languages": language_summary(parsed_files),
        "manifests": ingestion_output.get("manifests", {}),
    }
