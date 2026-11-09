# What it does: tree-sitter AST extractor for Python files
# Module 2: Parser
#
# Takes the dict returned by ingestion.py's fetch_repo() and extracts
# functions, classes, imports, and call sites from each Python file.
# Output feeds into Module 3 (graph_builder.py).
#
# Every definition gets a qualified name that reflects where it lives:
#   function           path::func
#   method             path::Class.method
#   nested class       path::Outer.Inner
#   nested function    path::outer.inner
# Call sites record the qualified id of their caller, the enclosing class
# (for self/cls resolution) and a structured description of the receiver,
# so the graph builder can resolve calls without guessing by name.

import re

from tree_sitter import Language, Parser
import tree_sitter_python as tspython

# ---------------------------------------------------------------------------
# Module-level singleton: initialize tree-sitter parser ONCE
# ---------------------------------------------------------------------------
PY_LANGUAGE = Language(tspython.language())
PARSER = Parser(PY_LANGUAGE)

MAX_CALLEE_TEXT = 200
_MAIN_GUARD_RE = re.compile(r"""^\s*(__name__\s*==\s*['"]__main__['"]|['"]__main__['"]\s*==\s*__name__)\s*$""")


def _text(node) -> str:
    return node.text.decode("utf-8", errors="replace") if node is not None else ""


# ---------------------------------------------------------------------------
# Docstring extraction helper
# ---------------------------------------------------------------------------
def _get_docstring(body_node, source_bytes: bytes) -> str | None:
    """
    Given a block node, return the first string literal inside it if it
    looks like a docstring, else None.
    """
    if body_node is None or body_node.child_count == 0:
        return None

    first_child = body_node.children[0]

    # The docstring is an expression_statement containing a string node
    if first_child.type == "expression_statement":
        if first_child.child_count > 0 and first_child.children[0].type == "string":
            raw = first_child.children[0].text.decode("utf-8", errors="replace")
            # Strip triple-quote or single-quote wrappers
            for q in ('"""', "'''", '"', "'"):
                if raw.startswith(q) and raw.endswith(q):
                    raw = raw[len(q):-len(q)]
                    break
            return raw.strip() or None

    return None


# ---------------------------------------------------------------------------
# Small AST helpers
# ---------------------------------------------------------------------------
def _is_dotted(node) -> bool:
    """identifier, or attribute chain of identifiers (a.b.c)."""
    if node is None:
        return False
    if node.type == "identifier":
        return True
    if node.type == "attribute":
        return _is_dotted(node.child_by_field_name("object")) and node.child_by_field_name("attribute") is not None
    return False


def _parameters(params_node) -> list[str]:
    parameters = []
    if params_node is None:
        return parameters
    for child in params_node.children:
        name_child = None
        if child.type == "identifier":
            name_child = child
        elif child.type in ("typed_parameter", "default_parameter", "typed_default_parameter"):
            name_child = child.child_by_field_name("name")
            if name_child is None:
                name_child = next((sub for sub in child.children if sub.type == "identifier"), None)
        if name_child is not None:
            name = _text(name_child)
            if name not in ("self", "cls"):
                parameters.append(name)
    return parameters


def _decorators(def_node) -> list[str]:
    """Decorator names as written: "app.get", "click.command", "staticmethod"…"""
    names = []
    parent = def_node.parent
    if parent is None or parent.type != "decorated_definition":
        return names
    for child in parent.children:
        if child.type != "decorator":
            continue
        for deco in child.children:
            if deco.type in ("identifier", "attribute"):
                names.append(_text(deco))
            elif deco.type == "call":
                fn = deco.child_by_field_name("function")
                if fn is not None:
                    names.append(_text(fn))
    return names


def _describe_call(call_node) -> dict | None:
    """
    Structured description of what a call targets:
      name      f()                       {"name": "f"}
      self      self.m() / cls.m()        {"attr": "m", "receiver": "self"|"cls"}
      super     super().m()               {"attr": "m"}
      dotted    a.b.f()                   {"base": "a.b", "attr": "f"}
      instance  Store().get()             {"ctor": "Store", "attr": "get"}
      unknown   obj.m(), self.x.m(), "".join()  {"attr": "m"}
    """
    fn = call_node.child_by_field_name("function")
    if fn is None:
        return None
    if fn.type == "identifier":
        return {"kind": "name", "name": _text(fn)}
    if fn.type != "attribute":
        return None
    obj = fn.child_by_field_name("object")
    attr = _text(fn.child_by_field_name("attribute"))
    if not attr:
        return None
    if obj is not None and obj.type == "identifier" and _text(obj) in ("self", "cls"):
        return {"kind": "self", "receiver": _text(obj), "attr": attr}
    if obj is not None and obj.type == "call":
        inner = obj.child_by_field_name("function")
        if inner is not None and inner.type == "identifier" and _text(inner) == "super":
            return {"kind": "super", "attr": attr}
        if _is_dotted(inner) and not _text(inner).startswith(("self.", "cls.")):
            return {"kind": "instance", "ctor": _text(inner), "attr": attr}
        return {"kind": "unknown", "attr": attr}
    if _is_dotted(obj) and not _text(obj).startswith(("self.", "cls.")):
        return {"kind": "dotted", "base": _text(obj), "attr": attr}
    return {"kind": "unknown", "attr": attr}


def _parse_import_statement(node) -> list[dict]:
    """import a.b  /  import a.b as c  /  import a, b"""
    out = []
    for child in node.children:
        alias = None
        if child.type == "dotted_name":
            module = _text(child)
        elif child.type == "aliased_import":
            module = _text(child.child_by_field_name("name"))
            alias = _text(child.child_by_field_name("alias")) or None
        else:
            continue
        if module:
            out.append({
                "kind": "import",
                "module": module,
                "names": [module],
                "aliases": [{"name": module, "alias": alias}] if alias else [],
                "alias": alias,
                "is_relative": False,
                "level": 0,
            })
    return out


def _parse_import_from(node) -> dict | None:
    """from a.b import c as d  /  from ..x import y  /  from . import z  /  from m import *"""
    module = ""
    level = 0
    names, aliases = [], []
    module_node = node.child_by_field_name("module_name")
    if module_node is not None:
        if module_node.type == "relative_import":
            for sub in module_node.children:
                if sub.type == "import_prefix":
                    level = _text(sub).count(".")
                elif sub.type == "dotted_name":
                    module = _text(sub)
        else:
            module = _text(module_node)
    past_import = False
    for child in node.children:
        if child.type == "import":
            past_import = True
            continue
        if not past_import:
            continue
        if child.type == "dotted_name":
            names.append(_text(child))
        elif child.type == "aliased_import":
            name = _text(child.child_by_field_name("name"))
            alias = _text(child.child_by_field_name("alias"))
            if name:
                names.append(name)
                if alias:
                    aliases.append({"name": name, "alias": alias})
        elif child.type == "wildcard_import":
            names.append("*")
    if not module and not names:
        return None
    return {
        "kind": "from",
        "module": module,
        "names": names,
        "aliases": aliases,
        "is_relative": level > 0,
        "level": level,
    }


def _is_main_guard(if_node) -> bool:
    cond = if_node.child_by_field_name("condition")
    return cond is not None and bool(_MAIN_GUARD_RE.match(_text(cond)))


# ---------------------------------------------------------------------------
# Single scope-aware walk
# ---------------------------------------------------------------------------
def _walk(tree, source_bytes: bytes, path: str) -> dict:
    functions, classes, imports, call_sites = [], [], [], []
    seen_calls = set()

    # Iterative DFS: (node, scope, in_main_guard). scope = tuple of ("class"|"function", name)
    stack = [(tree.root_node, (), False)]
    while stack:
        node, scope, in_main = stack.pop()
        t = node.type
        child_scope = scope
        child_main = in_main

        if t == "class_definition":
            name = _text(node.child_by_field_name("name"))
            body = node.child_by_field_name("body")
            qual = ".".join([s[1] for s in scope] + [name])
            base_classes = []
            supers = node.child_by_field_name("superclasses")
            if supers is not None:
                for child in supers.children:
                    if child.type in ("identifier", "attribute"):
                        base_classes.append(_text(child))
            method_names = []
            if body is not None:
                for child in body.children:
                    fn = child
                    if child.type == "decorated_definition":
                        fn = next((s for s in child.children if s.type == "function_definition"), None)
                    if fn is not None and fn.type == "function_definition":
                        method_names.append(_text(fn.child_by_field_name("name")))
            classes.append({
                "id": f"{path}::{qual}",
                "name": name,
                "qualified_name": qual,
                "type": "class",
                "start_line": node.start_point[0] + 1,
                "end_line": node.end_point[0] + 1,
                "base_classes": base_classes,
                "method_names": method_names,
                "is_nested": bool(scope),
                "docstring": _get_docstring(body, source_bytes),
            })
            child_scope = scope + (("class", name),)

        elif t == "function_definition":
            name = _text(node.child_by_field_name("name"))
            qual = ".".join([s[1] for s in scope] + [name])
            is_method = bool(scope) and scope[-1][0] == "class"
            class_name = ".".join(s[1] for s in scope) if is_method else None
            functions.append({
                "id": f"{path}::{qual}",
                "name": name,
                "qualified_name": qual,
                "class_name": class_name,
                "type": "function",
                "start_line": node.start_point[0] + 1,
                "end_line": node.end_point[0] + 1,
                "parameters": _parameters(node.child_by_field_name("parameters")),
                "is_method": is_method,
                "is_nested": any(s[0] == "function" for s in scope),
                "decorator_names": _decorators(node),
                "docstring": _get_docstring(node.child_by_field_name("body"), source_bytes),
            })
            child_scope = scope + (("function", name),)

        elif t == "import_statement":
            imports.extend(_parse_import_statement(node))
        elif t == "import_from_statement":
            parsed = _parse_import_from(node)
            if parsed:
                imports.append(parsed)

        elif t == "if_statement" and not scope and _is_main_guard(node):
            child_main = True

        elif t == "call":
            target = _describe_call(node)
            if target is not None:
                # Caller: innermost function, else the module (class bodies count as module level)
                fn_depth = max((i for i, s in enumerate(scope) if s[0] == "function"), default=-1)
                if fn_depth >= 0:
                    caller_qual = ".".join(s[1] for s in scope[: fn_depth + 1])
                    caller_id = f"{path}::{caller_qual}"
                    caller_function = scope[fn_depth][1]
                else:
                    caller_id = path
                    caller_function = "__module__"
                # Class for self/cls: the class enclosing the caller (methods and their closures)
                cls_depth = max((i for i, s in enumerate(scope[: fn_depth + 1] if fn_depth >= 0 else scope) if s[0] == "class"), default=-1)
                enclosing_class = ".".join(s[1] for s in scope[: cls_depth + 1]) if cls_depth >= 0 else None
                fn_node = node.child_by_field_name("function")
                callee = _text(fn_node)[:MAX_CALLEE_TEXT]
                line = node.start_point[0] + 1
                key = (caller_id, callee, line)
                if key not in seen_calls:
                    seen_calls.add(key)
                    call_sites.append({
                        "caller_function": caller_function,
                        "caller_id": caller_id,
                        "enclosing_class": enclosing_class,
                        "callee": callee,
                        "target": target,
                        "line": line,
                        "module_scope": fn_depth < 0,
                        "in_main_guard": in_main,
                    })

        # Push children in reverse so they are visited in source order
        for child in reversed(node.children):
            stack.append((child, child_scope, child_main))

    # Stable, source-ordered output
    functions.sort(key=lambda f: (f["start_line"], f["qualified_name"]))
    classes.sort(key=lambda c: (c["start_line"], c["qualified_name"]))
    call_sites.sort(key=lambda c: (c["line"], c["caller_id"], c["callee"]))
    return {"functions": functions, "classes": classes, "imports": imports, "call_sites": call_sites}


# ---------------------------------------------------------------------------
# Per-file entry point
# ---------------------------------------------------------------------------
def parse_file(path: str, content: str) -> dict:
    """
    Parse a single Python file and extract functions, classes, imports,
    and call sites.

    Returns a dict with the structure expected by graph_builder.py.
    """
    result = {
        "path": path,
        "functions": [],
        "classes": [],
        "imports": [],
        "call_sites": [],
    }

    if not content or not content.strip():
        return result

    try:
        source_bytes = content.encode("utf-8")
    except (UnicodeDecodeError, UnicodeEncodeError):
        print(f"[parser] Warning: Could not encode {path} as UTF-8, skipping")
        return result

    tree = PARSER.parse(source_bytes)
    result.update(_walk(tree, source_bytes, path))
    return result


# ---------------------------------------------------------------------------
# Repo-level entry point
# ---------------------------------------------------------------------------
def parse_repo(ingestion_output: dict) -> dict:
    """
    Takes the full dict from fetch_repo().
    Calls parse_file() on every file.

    Returns:
    {
      "repo": "owner/repo",
      "commit_sha": "abc12345",
      "parsed_files": [ ...one parse_file() output per file... ]
    }
    """
    files = ingestion_output.get("files", [])
    total = len(files)
    parsed_files = []

    for file_entry in files:
        path = file_entry.get("path", "unknown")
        content = file_entry.get("content", "")
        try:
            parsed = parse_file(path, content)
            parsed_files.append(parsed)
        except Exception as e:
            print(f"[parser] Warning: Failed to parse {path}: {e}")
            continue

    print(f"[parser] Parsed {len(parsed_files)}/{total} files")

    return {
        "repo": ingestion_output.get("repo", ""),
        "commit_sha": ingestion_output.get("commit_sha", ""),
        "parsed_files": parsed_files,
    }
