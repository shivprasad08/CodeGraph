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
_STRING_PREFIX_RE = re.compile(r"^[rRuUbB]{0,2}")
MAX_MODULE_DOC = 400
MAX_CLASS_DOC = 200


def _get_docstring(body_node, source_bytes: bytes) -> str | None:
    """
    Given a block (or module) node, return its docstring: the first statement,
    if it is a plain string literal. Comments before it are skipped.
    """
    if body_node is None or body_node.child_count == 0:
        return None

    first_child = next((c for c in body_node.children if c.type != "comment"), None)

    # The docstring is an expression_statement containing a string node
    if first_child is not None and first_child.type == "expression_statement":
        if first_child.child_count > 0 and first_child.children[0].type == "string":
            raw = first_child.children[0].text.decode("utf-8", errors="replace")
            raw = _STRING_PREFIX_RE.sub("", raw, count=1)
            # Strip triple-quote or single-quote wrappers
            for q in ('"""', "'''", '"', "'"):
                if raw.startswith(q) and raw.endswith(q) and len(raw) >= 2 * len(q):
                    raw = raw[len(q):-len(q)]
                    break
            return raw.strip() or None

    return None


def _short_doc(doc: str | None, limit: int) -> str:
    """Whitespace-collapsed docstring, cut to `limit` characters."""
    return " ".join(doc.split())[:limit] if doc else ""


# ---------------------------------------------------------------------------
# Lightweight type facts (for resolving self.x.m() and v.m())
# ---------------------------------------------------------------------------
_TYPE_NAME_RE = re.compile(r"[A-Za-z_]\w*(\.[A-Za-z_]\w*)*")
_OPTIONAL_RE = re.compile(r"(?:typing\.)?Optional\[(.+)\]")


def _type_name(text: str) -> str | None:
    """Annotation text → a single dotted class name ("Optional[Foo]", "Foo | None", "'Foo'" → "Foo")."""
    t = text.strip().strip("'\"")
    m = _OPTIONAL_RE.fullmatch(t)
    if m:
        t = m.group(1)
    parts = [p.strip().strip("'\"") for p in t.split("|")]
    parts = [p for p in parts if p and p != "None"]
    if len(parts) != 1 or not _TYPE_NAME_RE.fullmatch(parts[0]):
        return None
    return parts[0]


def _param_types(params_node) -> dict:
    types = {}
    if params_node is None:
        return types
    for child in params_node.children:
        if child.type not in ("typed_parameter", "typed_default_parameter"):
            continue
        name_child = child.child_by_field_name("name") or next((s for s in child.children if s.type == "identifier"), None)
        type_child = child.child_by_field_name("type")
        if name_child is None or type_child is None:
            continue
        type_name = _type_name(_text(type_child))
        if type_name:
            types[_text(name_child)] = type_name
    return types


def _value_type(value, param_types: dict) -> str | None:
    """Class name a value evidently has: Foo(...), mod.Foo(...), an annotated param, or `x or Foo()`."""
    if value is None:
        return None
    if value.type == "call":
        fn = value.child_by_field_name("function")
        if _is_dotted(fn) and not _text(fn).startswith(("self.", "cls.")):
            return _text(fn)
        return None
    if value.type == "identifier":
        return param_types.get(_text(value))
    if value.type == "boolean_operator":
        found = {t for t in (_value_type(value.child_by_field_name(side), param_types) for side in ("left", "right")) if t}
        return found.pop() if len(found) == 1 else None
    return None


def _note_type(table: dict, name: str, type_name: str | None) -> None:
    """First type seen wins; a conflicting or unknown later binding makes the name ambiguous (None)."""
    if name not in table:
        table[name] = type_name
    elif table[name] != type_name:
        table[name] = None


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
      self_attr self.x.m()                {"receiver": "self", "name": "x", "attr": "m"}
      unknown   obj.m(), f().m(), "".join()  {"attr": "m"}
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
    if obj is not None and obj.type == "attribute":
        inner_obj = obj.child_by_field_name("object")
        inner_attr = obj.child_by_field_name("attribute")
        if inner_obj is not None and inner_obj.type == "identifier" and _text(inner_obj) in ("self", "cls") and inner_attr is not None:
            # self.x.m(): resolvable when the type of attribute x is known
            return {"kind": "self_attr", "receiver": _text(inner_obj), "name": _text(inner_attr), "attr": attr}
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
    fn_by_id, class_by_qual = {}, {}  # for type facts gathered while walking bodies

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
                "attr_types": {},
            })
            classes[-1]["doc"] = _short_doc(classes[-1]["docstring"], MAX_CLASS_DOC)
            class_by_qual[qual] = classes[-1]
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
                "param_types": _param_types(node.child_by_field_name("parameters")),
                "local_types": {},
            })
            fn_by_id[f"{path}::{qual}"] = functions[-1]
            child_scope = scope + (("function", name),)

        elif t == "import_statement":
            imports.extend(_parse_import_statement(node))
        elif t == "import_from_statement":
            parsed = _parse_import_from(node)
            if parsed:
                imports.append(parsed)

        elif t == "assignment":
            _record_assignment(node, scope, path, fn_by_id, class_by_qual)

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

    # Only unambiguous type facts are kept
    for fn in functions:
        fn["local_types"] = {k: v for k, v in fn["local_types"].items() if v}
    for cls in classes:
        cls["attr_types"] = {k: v for k, v in cls["attr_types"].items() if v}

    # Stable, source-ordered output
    functions.sort(key=lambda f: (f["start_line"], f["qualified_name"]))
    classes.sort(key=lambda c: (c["start_line"], c["qualified_name"]))
    call_sites.sort(key=lambda c: (c["line"], c["caller_id"], c["callee"]))
    return {
        "functions": functions,
        "classes": classes,
        "imports": imports,
        "call_sites": call_sites,
        "doc": _short_doc(_get_docstring(tree.root_node, source_bytes), MAX_MODULE_DOC),
    }


def _record_assignment(node, scope, path, fn_by_id, class_by_qual) -> None:
    """
    Type facts from one assignment:
      in a function   v = Foo(...) / v: Foo        → local v: Foo
      in a method     self.x = Foo(...) / self.x = typed_param / self.x: Foo  → class attr x: Foo
      in a class body x: Foo / x = Foo()           → class attr x: Foo
    `x = None` is ignored, so `self.x = None` followed by `self.x = Foo()` still types x.
    """
    left = node.child_by_field_name("left")
    right = node.child_by_field_name("right")
    annotation = node.child_by_field_name("type")
    if left is None or (right is not None and right.type == "none"):
        return
    fn_depth = max((i for i, s in enumerate(scope) if s[0] == "function"), default=-1)
    fn = fn_by_id.get(f"{path}::" + ".".join(s[1] for s in scope[: fn_depth + 1])) if fn_depth >= 0 else None
    params = fn["param_types"] if fn else {}
    if annotation is not None:
        type_name = _type_name(_text(annotation))
    else:
        type_name = _value_type(right, params)

    if fn_depth < 0:
        # Class body (class attribute / annotation)
        if scope and scope[-1][0] == "class" and left.type == "identifier":
            cls = class_by_qual.get(".".join(s[1] for s in scope))
            if cls is not None and (type_name or annotation is not None):
                _note_type(cls["attr_types"], _text(left), type_name)
        return
    if fn is None:
        return
    if left.type == "identifier":
        _note_type(fn["local_types"], _text(left), type_name)
        return
    if left.type == "attribute":
        obj = left.child_by_field_name("object")
        attr = left.child_by_field_name("attribute")
        is_method = fn_depth > 0 and scope[fn_depth - 1][0] == "class"
        if is_method and obj is not None and obj.type == "identifier" and _text(obj) == "self" and attr is not None:
            cls = class_by_qual.get(".".join(s[1] for s in scope[:fn_depth]))
            if cls is not None:
                _note_type(cls["attr_types"], _text(attr), type_name)


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
        "doc": "",
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
