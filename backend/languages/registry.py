# What it does: language detection, path filtering and grammar loading for every supported language
#
# Python is parsed by languages/python.py with the bundled tree-sitter-python wheel.
# Every other language uses a grammar library from tree-sitter-language-pack. Those are
# downloaded ONCE, at build time, by scripts/fetch_grammars.py into a cache inside the
# project (backend/.grammars, or CODEGRAPH_GRAMMAR_DIR). At runtime load() only uses that
# cache: a grammar that is not there is reported unavailable (its files are skipped) and
# is never downloaded during a request.

import logging
import os
import posixpath
import threading
from pathlib import Path

logger = logging.getLogger(__name__)

BACKEND_DIR = Path(__file__).resolve().parent.parent
QUERIES_DIR = BACKEND_DIR / "queries"
DEFAULT_GRAMMAR_DIR = BACKEND_DIR / ".grammars"


def grammar_dir() -> Path:
    """Base directory of the grammar cache (the pack adds tree-sitter-language-pack/v<version>/libs)."""
    return Path(os.environ.get("CODEGRAPH_GRAMMAR_DIR") or DEFAULT_GRAMMAR_DIR).resolve()

# extension → language id
EXTENSIONS = {
    ".py": "python",
    ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript",
    ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "typescript",
    ".java": "java",
    ".go": "go",
    ".rs": "rust",
    ".c": "c", ".h": "c",
    ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp", ".hxx": "cpp",
    ".cs": "csharp",
    ".rb": "ruby",
    ".php": "php",
    ".kt": "kotlin", ".kts": "kotlin",
    ".swift": "swift",
    ".scala": "scala", ".sc": "scala",
    ".lua": "lua",
}

# language id → display name / short tag (file tree)
LABELS = {
    "python": ("Python", "PY"), "javascript": ("JavaScript", "JS"), "typescript": ("TypeScript", "TS"),
    "java": ("Java", "JAVA"), "go": ("Go", "GO"), "rust": ("Rust", "RS"), "c": ("C", "C"),
    "cpp": ("C++", "C++"), "csharp": ("C#", "C#"), "ruby": ("Ruby", "RB"), "php": ("PHP", "PHP"),
    "kotlin": ("Kotlin", "KT"), "swift": ("Swift", "SWIFT"), "scala": ("Scala", "SCALA"), "lua": ("Lua", "LUA"),
}

# Grammar name in tree-sitter-language-pack, and the tags/calls query files to combine
GRAMMARS = {
    "javascript": ("javascript", ["javascript-tags", "jsx-calls"]),
    "typescript": ("typescript", ["javascript-tags", "typescript-tags"]),
    "tsx": ("tsx", ["javascript-tags", "typescript-tags", "jsx-calls"]),
    "java": ("java", ["java-tags"]),
    "go": ("go", ["go-tags"]),
    "rust": ("rust", ["rust-tags", "rust-calls"]),
    "c": ("c", ["c-tags", "c-calls"]),
    "cpp": ("cpp", ["c-tags", "cpp-tags", "cpp-calls"]),
    "csharp": ("csharp", ["csharp-tags"]),
    "ruby": ("ruby", ["ruby-tags"]),
    "php": ("php", ["php-tags"]),
    "kotlin": ("kotlin", ["kotlin-tags"]),
    "swift": ("swift", ["swift-tags", "swift-calls"]),
    "scala": ("scala", ["scala-tags"]),
    "lua": ("lua", ["lua-tags"]),
}

# Vendored, generated and build output: never source we want in the graph
IGNORED_DIRS = frozenset({
    "node_modules", "dist", "build", "out", "target", "vendor", ".next", "coverage",
    "generated", "__pycache__", ".venv", "venv", "migrations", ".git", "bower_components",
})
IGNORED_SUFFIXES = (".min.js", ".d.ts", ".bundle.js", ".pb.go", "_pb2.py")

# Tests, per language (non-Python; Python keeps its original ingestion rules)
TEST_DIRS = frozenset({"__tests__", "test", "tests", "spec", "specs", "testdata"})


def language_of(path: str) -> str | None:
    return EXTENSIONS.get(posixpath.splitext(path)[1].lower())


def grammar_of(path: str, lang: str) -> str:
    """Grammar to parse a file with: .tsx uses the tsx grammar, other TypeScript the typescript one."""
    if lang == "typescript" and path.lower().endswith(".tsx"):
        return "tsx"
    return lang


def is_ignored(path: str) -> bool:
    parts = path.split("/")
    if any(p in IGNORED_DIRS for p in parts[:-1]):
        return True
    return parts[-1].lower().endswith(IGNORED_SUFFIXES)


def is_test(path: str) -> bool:
    """Test files outside Python: __tests__/, test/, spec/, src/test/ (Java/Kotlin/Scala), *.test.*, *.spec.*, *_test.go."""
    parts = path.split("/")
    name = parts[-1].lower()
    if any(p in TEST_DIRS for p in parts[:-1]):
        return True
    stem_parts = name.split(".")
    if len(stem_parts) >= 3 and stem_parts[-2] in ("test", "spec"):
        return True
    return name.endswith(("_test.go", "_spec.rb", "_test.rb", "test.java", "tests.java", "test.kt", "tests.cs", "test.cs"))


def label(lang: str) -> str:
    return LABELS.get(lang, (lang, lang.upper()))[0]


# ---------------------------------------------------------------------------
# Grammars (tree-sitter-language-pack) and queries
# ---------------------------------------------------------------------------
_lock = threading.Lock()
_parsers: dict = {}
_queries: dict = {}
_failed: dict = {}  # grammar → reason
_configured_dir: Path | None = None


def _pack():
    """tree-sitter-language-pack, configured to use grammar_dir() (never $HOME or /tmp)."""
    global _configured_dir
    import tree_sitter_language_pack as pack

    target = grammar_dir()
    if _configured_dir != target:
        pack.configure(pack.PackConfig(cache_dir=str(target)))
        _configured_dir = target
    return pack


def pack_name(grammar: str) -> str:
    return GRAMMARS[grammar][0]


def cached_grammars() -> set[str]:
    """Grammars whose library is in the cache (no network)."""
    try:
        cached = set(_pack().downloaded_languages())
    except Exception as e:  # cache missing or refused (ownership / permissions)
        logger.warning(f"[languages] grammar cache {grammar_dir()} unreadable: {e}")
        return set()
    return {g for g in GRAMMARS if pack_name(g) in cached}


def load(grammar: str, allow_download: bool = False):
    """
    (Parser, Query) for a grammar, or None if it cannot be loaded. Without allow_download
    a grammar missing from the cache is NOT fetched (the server never downloads per request).
    """
    with _lock:
        if grammar in _parsers:
            return _parsers[grammar], _queries[grammar]
        if grammar in _failed and not allow_download:
            return None
        try:
            import tree_sitter as ts

            pack = _pack()
            name, query_files = GRAMMARS[grammar]
            if not allow_download and name not in set(pack.downloaded_languages()):
                raise LookupError(f"not in the grammar cache {grammar_dir()}; run scripts/fetch_grammars.py")
            language = pack.get_language(name)
            source = "\n".join((QUERIES_DIR / f"{q}.scm").read_text(encoding="utf-8") for q in query_files)
            _parsers[grammar] = ts.Parser(language)
            _queries[grammar] = ts.Query(language, source)
            _failed.pop(grammar, None)
            return _parsers[grammar], _queries[grammar]
        except Exception as e:  # not cached, download failed, query mismatch
            logger.warning(f"[languages] grammar {grammar!r} unavailable: {e}")
            _failed[grammar] = str(e)
            return None


def failure_reason(grammar: str) -> str | None:
    return _failed.get(grammar)


def fetch(grammars=None) -> list[str]:
    """
    Downloads (build time only) and checks the grammars. Returns the ones that loaded.
    Used by scripts/fetch_grammars.py; tightens cache permissions afterwards because the
    pack refuses to load libraries from a group- or world-writable directory.
    """
    names = list(grammars or GRAMMARS)
    pack = _pack()
    missing = sorted({pack_name(g) for g in names} - set(pack.downloaded_languages()))
    if missing:
        pack.download(missing)
    _restrict_permissions(grammar_dir())
    return [g for g in names if load(g, allow_download=True)]


def prefetch(grammars=None) -> list[str]:
    """Kept for compatibility: same as fetch()."""
    return fetch(grammars)


def _restrict_permissions(root: Path) -> None:
    """Directories 0755 and files 0644 (POSIX): owner-writable only, as the loader requires."""
    if os.name != "posix" or not root.exists():
        return
    for dirpath, dirnames, filenames in os.walk(root):
        os.chmod(dirpath, 0o755)
        for f in filenames:
            os.chmod(os.path.join(dirpath, f), 0o644)
