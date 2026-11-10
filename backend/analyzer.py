import math
import re
import uuid
import networkx as nx

from languages import registry

# ---------------------------------------------------------------------------
# Line rules: shared (all languages) + per-language rule packs
# ---------------------------------------------------------------------------
# Hardcoded secrets (shared)
SECRET_PATTERNS = [
    (r'(password|passwd|pwd)\s*=\s*["\'][^"\']{4,}["\']', "password"),
    (r'(api_key|apikey|api_secret)\s*=\s*["\'][^"\']{8,}["\']', "api_key"),
    (r'(secret_key|secret)\s*=\s*["\'][^"\']{8,}["\']', "secret_key"),
    (r'(token)\s*=\s*["\'][^"\']{10,}["\']', "token"),
    (r'(aws_access_key_id|aws_secret)\s*=\s*["\']', "aws_key")
]
SECRET_EXCLUDE_TERMS = ["example", "placeholder", "your_", "YOUR_", "<", ">", "os.getenv", "os.environ", "config.",
                        "process.env", "System.getenv", "os.Getenv", "env::var", "ENV["]

# Comment markers per language (TODO detection, skipping commented-out code)
HASH_COMMENT_LANGS = frozenset({"python", "ruby"})
TODO_PATTERNS = {
    "hash": re.compile(r'#\s*(TODO|FIXME|HACK|XXX|BUG)[\s:](.*)', re.IGNORECASE),
    "slash": re.compile(r'(?://|/\*|^\s*\*)\s*(TODO|FIXME|HACK|XXX|BUG)[\s:](.*)', re.IGNORECASE),
    "dash": re.compile(r'--\s*(TODO|FIXME|HACK|XXX|BUG)[\s:](.*)', re.IGNORECASE),
}


def _comment_style(lang: str) -> str:
    if lang in HASH_COMMENT_LANGS:
        return "hash"
    return "dash" if lang == "lua" else "slash"


def _is_comment_line(line: str, style: str) -> bool:
    stripped = line.lstrip()
    if style == "hash":
        return stripped.startswith("#")
    if style == "dash":
        return stripped.startswith("--")
    return stripped.startswith(("//", "/*", "*"))


def _issue(file_path, line, severity, kind, message, function=None):
    return {"id": str(uuid.uuid4()), "file": file_path, "line": line, "severity": severity,
            "type": kind, "message": message, "function": function}


# Python rule pack (unchanged rules)
PY_SQL_INJECTION = re.compile(r'execute\s*\(\s*f["\']|execute\s*\(\s*["\'].*\+.*["\']')
PY_EVAL = re.compile(r'\beval\s*\(')
PY_DEBUG = [
    re.compile(r'\bpdb\.set_trace\(\)'),
    re.compile(r'\bbreakpoint\(\)'),
    re.compile(r'\bprint\s*\(\s*["\']DEBUG'),
]


def _python_rules(file_path, line_idx, line, is_comment, is_test_file):
    out = []
    if not is_comment:
        if PY_SQL_INJECTION.search(line):
            out.append(_issue(file_path, line_idx, "high", "security", "Potential SQL injection via string formatting"))
        if PY_EVAL.search(line):
            out.append(_issue(file_path, line_idx, "high", "security", "Use of eval() — arbitrary code execution risk"))
    if not is_test_file and not is_comment:
        for d_pat in PY_DEBUG:
            if d_pat.search(line):
                out.append(_issue(file_path, line_idx, "medium", "quality", "Debug statement left in production code"))
                break
    return out


# JavaScript / TypeScript rule pack
JS_RULES = [
    (re.compile(r'(?<![\w.$])eval\s*\('), "high", "security", "Use of eval() — arbitrary code execution risk"),
    (re.compile(r'\bnew\s+Function\s*\('), "high", "security", "new Function() — arbitrary code execution risk"),
    (re.compile(r'\.(?:inner|outer)HTML\s*(?:\+?=)(?!=)'), "medium", "security",
     "Assigning innerHTML/outerHTML — XSS risk unless the value is sanitized"),
    (re.compile(r'\bdangerouslySetInnerHTML\b'), "medium", "security",
     "dangerouslySetInnerHTML — XSS risk unless the value is sanitized"),
    (re.compile(r'\b(?:exec|execSync|spawn|spawnSync)\s*\(\s*`[^`]*\$\{'), "high", "security",
     "Shell command built from a template string — command injection risk"),
]
JS_DEBUG = re.compile(r'^\s*debugger\s*;?\s*$')


def _js_rules(file_path, line_idx, line, is_comment, is_test_file):
    if is_comment:
        return []
    out = [_issue(file_path, line_idx, sev, kind, msg) for pat, sev, kind, msg in JS_RULES if pat.search(line)]
    if not is_test_file and JS_DEBUG.search(line):
        out.append(_issue(file_path, line_idx, "medium", "quality", "Debug statement left in production code"))
    return out


RULE_PACKS = {"python": _python_rules, "javascript": _js_rules, "typescript": _js_rules}

# Language-agnostic structure thresholds
LONG_FUNCTION_LINES = 50
MAX_PARAMETERS = 6
GOD_OBJECT_METHODS = 25
GOD_OBJECT_LINES = 600
# Methods the language or a framework calls (never "unused"): dunders are handled separately
IMPLICIT_CALL_NAMES = frozenset({
    "main", "init", "constructor", "new", "toString", "equals", "hashCode", "String", "Error", "Main",
    "render", "componentDidMount", "componentDidUpdate", "componentWillUnmount", "getDerivedStateFromProps",
    "setUp", "tearDown", "setUpClass", "tearDownClass", "drop", "fmt", "default", "clone", "finalize",
})
_IDENTIFIER_RE = re.compile(r"[A-Za-z_$][\w$]*")
LARGE_FILE_LOC = 600
DEEP_NESTING = 5
DUPLICATE_NAME_IGNORE = frozenset({"main", "__init__", "init", "index", "constructor", "setup", "run", "new",
                                   "default", "render", "handler", "handle", "App"})


def analyze_repo(parse_output: dict, source_files: dict, graph: dict) -> dict:
    """
    Analyzes the repo for security and quality.
    Line rules: shared secrets/TODO checks plus a rule pack per language (Python, JS/TS).
    Structure: long functions, large files, deep nesting, duplicate names, circular imports.
    """
    issues = []
    lang_of = {pf.get("path"): pf.get("lang", "python") for pf in parse_output.get("parsed_files", [])}

    # 1. File-level Security and Quality Issues
    for file_path, content in source_files.items():
        if not content:
            continue
        lang = lang_of.get(file_path) or registry.language_of(file_path) or "python"
        style = _comment_style(lang)
        todo_pattern = TODO_PATTERNS[style]
        pack = RULE_PACKS.get(lang)
        if lang == "python":
            is_test_file = file_path.startswith("test_") or "/test_" in file_path or "/tests/" in file_path
        else:
            is_test_file = registry.is_test(file_path)

        lines = content.split('\n')
        for i, line in enumerate(lines):
            line_idx = i + 1
            is_comment = _is_comment_line(line, style)

            # Check secrets
            if not is_comment:
                has_exclude = any(term in line for term in SECRET_EXCLUDE_TERMS)
                if not has_exclude:
                    for pat, type_str in SECRET_PATTERNS:
                        if re.search(pat, line, re.IGNORECASE):
                            issues.append(_issue(file_path, line_idx, "high", "security", f"Possible hardcoded {type_str} detected"))
                            break  # One secret per line is enough

            if pack is not None:
                issues.extend(pack(file_path, line_idx, line, is_comment, is_test_file))

            # Check TODO/FIXME
            todo_match = todo_pattern.search(line)
            if todo_match:
                content_match = todo_match.group(2).strip()[:60]
                issues.append(_issue(file_path, line_idx, "low", "quality", f"TODO/FIXME comment: {content_match}"))

    # 1b. Language-agnostic structure: large files, deep nesting, duplicate names
    defined_in = {}
    for pf in parse_output.get("parsed_files", []):
        path = pf.get("path")
        if pf.get("loc", 0) > LARGE_FILE_LOC:
            issues.append(_issue(path, 1, "low", "quality", f"Large file: {pf['loc']} lines of code — consider splitting it"))
        for sym in pf.get("symbols", []):
            if sym.get("nesting", 0) >= DEEP_NESTING:
                issues.append(_issue(path, sym["start_line"], "low", "quality",
                                     f"{sym['name']} nests control flow {sym['nesting']} levels deep", sym["name"]))
            if sym.get("top_level", True) and not sym.get("class_name") and sym["name"] not in DUPLICATE_NAME_IGNORE \
                    and not sym["name"].startswith("_"):
                defined_in.setdefault((sym["kind"] in ("function", "method"), sym["name"]), []).append((path, sym["start_line"]))
    for (_is_fn, name), places in sorted(defined_in.items()):
        files = sorted({p for p, _ in places})
        if len(files) > 1:
            first_file, first_line = min(places)
            # Basenames, unless two files share one (server/src/x.js vs shared/x.js): then paths
            bases = [f.split("/")[-1] for f in files]
            shown = files if len(set(bases)) < len(bases) else bases
            others = ", ".join(s for f, s in zip(files, shown) if f != first_file)
            issues.append(_issue(first_file, first_line, "info", "quality",
                                 f"{name} is also defined in {others} — the same name in {len(files)} files", name))

    # 1c. Parameter count, God objects, dead code (from the IR, every language)
    issues.extend(_structure_issues(parse_output, source_files, graph))

    # 2. Graph & Parse Output based issues
    functions = [n for n in graph.get("nodes", []) if n.get("type") == "function"]
    classes = [n for n in graph.get("nodes", []) if n.get("type") == "class"]
    files = [n for n in graph.get("nodes", []) if n.get("type") == "file"]
    
    # Map functions by file to calculate missing docstrings ratio
    funcs_by_file = {}
    for fn in functions:
        fn_file = fn.get("file")
        if fn_file:
            funcs_by_file.setdefault(fn_file, []).append(fn)
            
    for fn in functions:
        fn_name = fn.get("label", "")
        start_line = fn.get("lines", [0, 0])[0]
        end_line = fn.get("lines", [0, 0])[1]
        length = end_line - start_line if end_line and start_line else 0
        
        if length > LONG_FUNCTION_LINES:
            issues.append({
                "id": str(uuid.uuid4()),
                "file": fn.get("file"),
                "line": start_line,
                "severity": "medium",
                "type": "quality",
                "message": f"Function {fn_name} is {length} lines — consider breaking it up",
                "function": fn_name
            })
            
        # Too many parameters (heuristic: we can check the AST if available, or signature)
        # We don't have exact parameter counts in standard graph unless enriched, assuming it's available or skipping
        # Actually from parse_output we can get this.
    
    # Let's inspect parse_output for function parameters and docstrings
    for parsed_file in parse_output.get("parsed_files", []):
        file_path = parsed_file.get("path")
        public_funcs = 0
        missing_docs = 0
        
        for p_fn in parsed_file.get("functions", []):
            fn_name = p_fn.get("name", "")
            start_line = p_fn.get("start_line", 0)
            
            # Missing docstrings
            if not fn_name.startswith("_") and not p_fn.get("is_method", False):
                public_funcs += 1
                if not p_fn.get("docstring"):
                    missing_docs += 1
                    
        # Flag if > 30% missing
        if public_funcs > 0 and (missing_docs / public_funcs) > 0.3:
            issues.append({
                "id": str(uuid.uuid4()),
                "file": file_path,
                "line": 1,
                "severity": "low",
                "type": "quality",
                "message": f"{missing_docs} public functions missing docstrings",
                "function": None
            })
            
    # Circular Imports
    import_edges = [(e["source"], e["target"]) for e in graph.get("edges", []) if e.get("type") == "imports"]
    nx_graph = nx.DiGraph(import_edges)
    cycles = list(nx.simple_cycles(nx_graph))
    # simple_cycles can return cycles of length 2+
    for cycle in cycles:
        if len(cycle) == 2:
            file_a, file_b = cycle
            issues.append({
                "id": str(uuid.uuid4()),
                "file": file_a,
                "line": 1,
                "severity": "medium",
                "type": "quality",
                "message": f"Circular import: {file_a} ↔ {file_b}",
                "function": None
            })
            
    # Deduplicate issues
    unique_issues = []
    seen_issues = set()
    for i in issues:
        key = (i["file"], i["line"], i["message"])
        if key not in seen_issues:
            seen_issues.add(key)
            unique_issues.append(i)

    # 3. Compute Health Score
    health_result = compute_health_score(unique_issues, graph)
    
    # By File dict
    by_file = {}
    severity_rank = {"high": 3, "medium": 2, "low": 1, "info": 0}
    for issue in unique_issues:
        f = issue["file"]
        if f not in by_file:
            by_file[f] = {"issue_count": 0, "severity": issue["severity"], "issues": []}
        
        by_file[f]["issue_count"] += 1
        by_file[f]["issues"].append(issue)
        
        if severity_rank[issue["severity"]] > severity_rank[by_file[f]["severity"]]:
            by_file[f]["severity"] = issue["severity"]
            
    health_result["issues"] = unique_issues
    health_result["patterns"] = []  # kept for API compatibility; pattern detection was removed
    health_result["by_file"] = by_file
    
    return health_result

HEALTH_DECAY = 1.2


def grade_for_score(score: int) -> str:
    if score >= 90:
        return "A"
    if score >= 80:
        return "B"
    if score >= 70:
        return "C"
    if score >= 60:
        return "D"
    return "F"


def compute_health_score(issues: list[dict], graph: dict, patterns: list[dict] | None = None) -> dict:
    """
    Size-normalized health score. Issues are weighted (high 8, medium 3, low 1),
    structural problems add weight too, and the total is divided by the number of
    functions and classes, so a large repo is not penalized just for being large:
        score = 100 * exp(-1.2 * weighted / items).
    There is no bonus for "design patterns": the old detectors matched names (create_*,
    *factory*) rather than structure, so they rewarded naming, not quality. `patterns` is
    accepted and ignored for compatibility.
    """
    high_count = sum(1 for i in issues if i["severity"] == "high")
    med_count = sum(1 for i in issues if i["severity"] == "medium")
    low_count = sum(1 for i in issues if i["severity"] == "low")

    # Additional Deductions & Metrics
    total_files = len([n for n in graph.get("nodes", []) if n.get("type") == "file"])
    total_functions = len([n for n in graph.get("nodes", []) if n.get("type") == "function"])
    total_classes = len([n for n in graph.get("nodes", []) if n.get("type") == "class"])

    total_lines = 0
    max_function_length = 0
    for fn in [n for n in graph.get("nodes", []) if n.get("type") == "function"]:
        start = fn.get("lines", [0, 0])[0]
        end = fn.get("lines", [0, 0])[1]
        length = end - start if end and start else 0
        total_lines += length
        if length > max_function_length:
            max_function_length = length

    avg_function_length = total_lines / total_functions if total_functions > 0 else 0

    dead_code_count = sum(1 for i in issues if i["type"] == "dead_code")
    circular_import_count = sum(1 for i in issues if "Circular import" in i["message"]) / 2 # since it flags both A->B and B->A in a cycle

    items = max(total_functions + total_classes, 1)
    weighted = 8 * high_count + 3 * med_count + 1 * low_count
    # Structural penalties, expressed as weight so they scale with repo size too
    weighted += 10 * circular_import_count
    if total_functions > 0 and (dead_code_count / total_functions) > 0.2:
        weighted += 0.10 * items  # roughly -10 points on an otherwise clean repo
    if avg_function_length > 40:
        weighted += 0.05 * items  # roughly -5 points

    density = weighted / items
    score = 100 * math.exp(-HEALTH_DECAY * density)
    score = max(0, min(100, round(score))) # clamp 0-100

    grade = grade_for_score(score)
    # Kept for API compatibility; the frontend no longer uses these colours
    grade_color = {"A": "#22c55e", "B": "#4ade80", "C": "#eab308", "D": "#f97316", "F": "#ef4444"}[grade]

    # Most complex file
    file_complexity = {}
    for n in graph.get("nodes", []):
        if n.get("type") in ("function", "class"):
            f = n.get("file")
            if f:
                file_complexity[f] = file_complexity.get(f, 0) + 1
    
    most_complex_file = max(file_complexity.items(), key=lambda x: x[1])[0] if file_complexity else None
    
    # Test coverage estimate
    test_functions = sum(1 for n in graph.get("nodes", []) if n.get("type") == "function" and (n.get("label", "").startswith("test_") or "test" in n.get("file", "")))
    test_coverage_estimate = test_functions / total_functions if total_functions > 0 else 0
    
    return {
        "score": score,
        "grade": grade,
        "grade_color": grade_color,
        "metrics": {
            "total_files": total_files,
            "total_functions": total_functions,
            "total_classes": total_classes,
            "avg_function_length": round(avg_function_length, 1),
            "max_function_length": max_function_length,
            "most_complex_file": most_complex_file,
            "dead_code_count": dead_code_count,
            "circular_import_count": int(circular_import_count),
            "test_coverage_estimate": round(test_coverage_estimate, 2)
        }
    }


# ---------------------------------------------------------------------------
# Parameter count, God objects, dead code
# ---------------------------------------------------------------------------
def _is_dunder(name: str) -> bool:
    return name.startswith("__") and name.endswith("__")


def _external_base_classes(parse_output: dict) -> set:
    """Python class ids with a base class that is not defined in the repo (methods may be overrides)."""
    repo_classes = {c["name"] for pf in parse_output.get("parsed_files", []) for c in pf.get("classes", [])}
    out = set()
    for pf in parse_output.get("parsed_files", []):
        for c in pf.get("classes", []):
            bases = [b.split(".")[-1] for b in c.get("base_classes", []) if b not in ("object", "ABC", "Protocol")]
            if any(b not in repo_classes for b in bases):
                out.add(f"{pf['path']}::{c['qualified_name']}")
    return out


def _structure_issues(parse_output: dict, source_files: dict, graph: dict) -> list[dict]:
    issues = []
    nodes = {n["id"]: n for n in graph.get("nodes", [])}
    callers = {}
    for e in graph.get("edges", []):
        if e.get("type") == "calls" and e.get("source") != e.get("target"):
            callers[e["target"]] = callers.get(e["target"], 0) + 1
    # How often each identifier appears anywhere in the repo source (cheap "is it referenced?" check)
    words = {}
    for content in source_files.values():
        for w in _IDENTIFIER_RE.findall(content or ""):
            words[w] = words.get(w, 0) + 1
    overriding = _external_base_classes(parse_output)

    for pf in parse_output.get("parsed_files", []):
        path = pf.get("path")
        lang = pf.get("lang", "python")
        test_file = registry.is_test(path) if lang != "python" else ("/tests/" in f"/{path}" or path.split("/")[-1].startswith("test_"))
        for sym in pf.get("symbols", []):
            name, kind = sym["name"], sym["kind"]
            line = sym["start_line"]
            if kind in ("function", "method"):
                if sym.get("param_count", 0) > MAX_PARAMETERS:
                    issues.append(_issue(path, line, "medium", "quality",
                                         f"Function {name} has {sym['param_count']} parameters — may indicate poor design", name))
                if _looks_unused(sym, nodes.get(sym["id"], {}), callers, words, overriding, test_file):
                    exact = lang == "python"  # full support: calls are resolved through scope
                    issue = _issue(path, line, "low", "dead_code",
                                   "No callers found — may be unused" if exact else "No callers found — possibly unused", name)
                    issue["confidence"] = "likely" if exact else "possible"
                    issues.append(issue)
            elif kind in ("class", "struct"):
                span = sym["end_line"] - sym["start_line"] + 1
                methods = sym.get("method_count", 0)
                if methods > GOD_OBJECT_METHODS or span > GOD_OBJECT_LINES:
                    issues.append(_issue(path, line, "medium", "quality",
                                         f"Class {name} has {methods} methods across {span} lines — possible God Object", None))
    return issues


def _looks_unused(sym: dict, node: dict, callers: dict, words: dict, overriding: set, test_file: bool) -> bool:
    """No resolved callers, and nothing suggests it is reached another way."""
    name = sym["name"]
    if callers.get(sym["id"]) or node.get("is_entry_point"):
        return False
    if _is_dunder(name) or name in IMPLICIT_CALL_NAMES or test_file or name.lower().startswith("test"):
        return False
    if sym.get("decorated") or sym.get("exported"):
        return False  # routes, handlers, fixtures, properties, overrides; public API used elsewhere
    if sym.get("class_name") and f"{sym['file']}::{sym['class_name']}" in overriding:
        return False  # may override a method of a third-party base class (Thread.run, Servicer.Method…)
    # Referenced by name anywhere else (callbacks, dispatch tables, getattr, templates…)
    return words.get(name, 0) <= 1
