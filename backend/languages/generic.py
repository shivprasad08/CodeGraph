# What it does: tags-query parser for every non-Python language (basic support)
#
# Definitions and call references come from each grammar's official tags.scm
# (queries/<lang>-tags.scm). Imports come from small per-language node walks where
# they are easy to read (JS/TS import/require, Go import, Rust use/mod, C/C++ local
# #include, Java import, C# using, Ruby require(_relative), PHP require/use).
# Output: the language-neutral IR (ir.py) as a parse_output dict.

import re

from ir import CallRef, ImportRef, ParsedFile, Symbol, count_loc, max_nesting
from languages import registry

MAX_MODULE_DOC = 400
MAX_CLASS_DOC = 200
MAX_RECEIVER = 80

# tags capture → IR kind (None: not a definition we keep)
DEFINITION_KINDS = {
    "definition.function": "function",
    "definition.method": "method",
    "definition.class": "class",
    "definition.interface": "interface",
    "definition.module": "module",
    "definition.object": "class",
    "definition.enum": "class",
    "definition.type": "type",  # Go type_spec etc.: kept only for struct / interface types
}
CALL_CAPTURES = ("reference.call", "reference.send")
NEW_NODE_TYPES = ("new_expression", "object_creation_expression", "instance_expression", "composite_literal")
STRUCT_NODE_TYPES = frozenset({"struct_item", "struct_specifier", "struct_declaration", "record_declaration"})
CLASS_KINDS = frozenset({"class", "interface", "struct", "module"})
FUNCTION_KINDS = frozenset({"function", "method"})

_COMMENT_MARKERS = re.compile(r"^\s*(/\*\*?|\*/|\*|//[/!]?|#|--)\s?", re.MULTILINE)
_GENERICS = re.compile(r"<.*>|\[.*\]")


def _text(node, src: bytes) -> str:
    return src[node.start_byte:node.end_byte].decode("utf-8", errors="replace") if node is not None else ""


def _clean_comment(text: str) -> str:
    text = text.replace("*/", "")
    return " ".join(_COMMENT_MARKERS.sub("", line) for line in text.splitlines()).strip()


def _short(text: str, limit: int) -> str:
    return " ".join(text.split())[:limit]


# ---------------------------------------------------------------------------
# Docs
# ---------------------------------------------------------------------------
def _file_doc(root, src: bytes) -> str:
    """Leading comment block of the file (licence headers skipped)."""
    blocks, current = [], []
    last_row = None
    for child in root.children:
        if child.type not in ("comment", "line_comment", "block_comment"):
            break
        text = _text(child, src)
        if text.startswith("#!"):
            continue
        if last_row is not None and child.start_point[0] > last_row + 1 and current:
            blocks.append(current)
            current = []
        current.append(_clean_comment(text))
        last_row = child.end_point[0]
    if current:
        blocks.append(current)
    for block in blocks:
        doc = " ".join(block).strip()
        if doc and not re.search(r"copyright|licen[cs]e|spdx", doc, re.IGNORECASE):
            return _short(doc, MAX_MODULE_DOC)
    return ""


def _preceding_doc(node, src: bytes) -> str:
    """Comment(s) directly above a definition."""
    target = node
    # Export / decorator wrappers carry the comment above them
    while target.parent is not None and target.parent.type in ("export_statement", "decorated_definition", "attribute_item"):
        target = target.parent
    lines, row = [], target.start_point[0]
    sib = target.prev_sibling
    while sib is not None and sib.type in ("comment", "line_comment", "block_comment") and sib.end_point[0] >= row - 1:
        lines.insert(0, _clean_comment(_text(sib, src)))
        row = sib.start_point[0]
        sib = sib.prev_sibling
    return _short(" ".join(lines), MAX_CLASS_DOC)


# ---------------------------------------------------------------------------
# Owners for methods declared outside their type (Rust impl, Go receivers)
# ---------------------------------------------------------------------------
def _outside_owner(def_node, lang: str, src: bytes) -> str | None:
    if lang == "rust":
        n = def_node.parent
        while n is not None:
            if n.type == "impl_item":
                t = n.child_by_field_name("type")
                return _GENERICS.sub("", _text(t, src)).strip() or None
            if n.type in ("function_item", "mod_item"):
                return None
            n = n.parent
    if lang == "go" and def_node.type == "method_declaration":
        recv = def_node.child_by_field_name("receiver")
        if recv is not None:
            names = []
            stack = [recv]
            while stack:
                n = stack.pop()
                if n.type == "type_identifier":
                    names.append((n.start_byte, _text(n, src)))
                stack.extend(n.children)
            if names:
                return min(names)[1]
    return None


def _type_kind(def_node, src: bytes) -> str | None:
    """Go `type X struct{}` / `type X interface{}` → struct / interface; other type aliases are skipped."""
    t = def_node.child_by_field_name("type")
    if t is None:
        return None
    if t.type == "struct_type":
        return "struct"
    if t.type == "interface_type":
        return "interface"
    return None


# ---------------------------------------------------------------------------
# Imports
# ---------------------------------------------------------------------------
def _string_value(node, src: bytes) -> str:
    return _text(node, src).strip().strip("'\"`<>")


def _imports(root, src: bytes, lang: str, path: str) -> list:
    out = []

    def add(node, module, names=(), alias=None, aliases=None):
        if module:
            out.append(ImportRef(file=path, raw=_short(_text(node, src), 160), module=module, lang=lang,
                                 names=list(names), alias=alias, aliases=dict(aliases or {})))

    stack = [root]
    while stack:
        node = stack.pop()
        t = node.type
        if lang in ("javascript", "typescript"):
            if t in ("import_statement", "export_statement"):
                source = node.child_by_field_name("source")
                if source is not None:
                    names, aliases, alias = [], {}, None
                    for clause in node.children:
                        if clause.type != "import_clause":
                            continue
                        for part in clause.children:
                            if part.type == "identifier":  # default import
                                names.append("default")
                                aliases[_text(part, src)] = "default"
                            elif part.type == "namespace_import":
                                ident = next((c for c in part.children if c.type == "identifier"), None)
                                names.append("*")
                                alias = _text(ident, src) if ident is not None else None
                            elif part.type == "named_imports":
                                for spec in part.children:
                                    if spec.type != "import_specifier":
                                        continue
                                    orig = _text(spec.child_by_field_name("name"), src)
                                    local = _text(spec.child_by_field_name("alias"), src) or orig
                                    names.append(orig)
                                    aliases[local] = orig
                    if t == "export_statement" and not names:
                        names = ["*"]
                    add(node, _string_value(source, src), names, alias, aliases)
                    continue
            if t == "call_expression":
                fn = node.child_by_field_name("function")
                args = node.child_by_field_name("arguments")
                fn_text = _text(fn, src)
                if fn_text in ("require", "import") and args is not None:
                    arg = next((c for c in args.children if c.type == "string"), None)
                    if arg is not None:
                        names, aliases, alias = ["*"], {}, None
                        decl = node.parent
                        if decl is not None and decl.type == "variable_declarator":
                            name = decl.child_by_field_name("name")
                            if name is not None and name.type == "identifier":
                                alias = _text(name, src)
                            elif name is not None and name.type == "object_pattern":
                                names = []
                                for prop in name.children:
                                    if prop.type == "shorthand_property_identifier_pattern":
                                        names.append(_text(prop, src))
                                        aliases[_text(prop, src)] = _text(prop, src)
                                    elif prop.type == "pair_pattern":
                                        orig = _text(prop.child_by_field_name("key"), src)
                                        local = _text(prop.child_by_field_name("value"), src)
                                        names.append(orig)
                                        aliases[local] = orig
                        add(node, _string_value(arg, src), names, alias, aliases)
        elif lang == "go" and t == "import_spec":
            p = node.child_by_field_name("path")
            name = node.child_by_field_name("name")
            add(node, _string_value(p, src), ["*"], _text(name, src) if name is not None else None)
            continue
        elif lang == "rust":
            if t == "use_declaration":
                arg = node.child_by_field_name("argument")
                raw = " ".join(_text(arg, src).split())
                if "{" in raw:
                    module = raw.split("::{", 1)[0]
                    inner = raw[raw.index("{") + 1: raw.rindex("}")] if "}" in raw else ""
                    names = [n.strip().split(" as ")[0].split("::")[-1] for n in inner.split(",") if n.strip()]
                else:
                    module, _, last = raw.rpartition("::")
                    names = [last.split(" as ")[0]]
                    if not module:
                        module = raw
                add(node, module, names)
                continue
            if t == "mod_item" and node.child_by_field_name("body") is None:
                name = _text(node.child_by_field_name("name"), src)
                add(node, f"mod::{name}", ["*"])
                continue
        elif lang in ("c", "cpp") and t == "preproc_include":
            p = node.child_by_field_name("path")
            if p is not None and p.type == "string_literal":
                add(node, _string_value(p, src), ["*"])
            continue
        elif lang == "java" and t == "import_declaration":
            raw = _text(node, src)
            module = raw.replace("import", "", 1).replace("static ", "").strip().rstrip(";").strip()
            if module.endswith(".*"):
                add(node, module[:-2], ["*"])
            else:
                add(node, module, [module.rsplit(".", 1)[-1]])
            continue
        elif lang == "csharp" and t == "using_directive":
            raw = _text(node, src)
            add(node, raw.replace("using", "", 1).replace("static ", "").strip().rstrip(";").strip(), ["*"])
            continue
        elif lang == "ruby" and t == "call":
            method = _text(node.child_by_field_name("method"), src)
            if method in ("require", "require_relative"):
                args = node.child_by_field_name("arguments")
                arg = next((c for c in (args.children if args is not None else []) if c.type == "string"), None)
                if arg is not None:
                    value = _string_value(arg, src)
                    add(node, ("./" + value) if method == "require_relative" else value, ["*"])
        elif lang == "php":
            if t in ("require_expression", "require_once_expression", "include_expression", "include_once_expression"):
                arg = next((c for c in node.children if c.type in ("string", "encapsed_string")), None)
                if arg is not None:
                    add(node, "./" + _string_value(arg, src).lstrip("/"), ["*"])
                continue
            if t == "namespace_use_clause":
                name = next((c for c in node.children if c.type in ("qualified_name", "name")), None)
                if name is not None:
                    add(node, _text(name, src).lstrip("\\"), [_text(name, src).split("\\")[-1]])
                continue
        stack.extend(reversed(node.children))
    return out


# ---------------------------------------------------------------------------
# Main entry
# ---------------------------------------------------------------------------
def parse_file(path: str, content: str, lang: str) -> dict:
    pf = ParsedFile(path=path, lang=lang, loc=count_loc(content or ""))
    if not content or not content.strip():
        return pf.to_dict()
    loaded = registry.load(registry.grammar_of(path, lang))
    if loaded is None:
        pf.extras["parse_error"] = "grammar unavailable"
        return pf.to_dict()
    parser, query = loaded
    src = content.encode("utf-8", errors="replace")
    tree = parser.parse(src)
    root = tree.root_node

    from tree_sitter import QueryCursor

    matches = QueryCursor(query).matches(root)

    # -- definitions --------------------------------------------------------------
    raw_defs = {}  # (start, end) → (kind, name, def_node)
    call_refs = []
    for _pattern, caps in matches:
        name_nodes = caps.get("name")
        if not name_nodes:
            continue
        name_node = name_nodes[0]
        for cap, nodes in caps.items():
            if cap in DEFINITION_KINDS:
                def_node = nodes[0]
                kind = DEFINITION_KINDS[cap]
                if kind == "type":
                    kind = _type_kind(def_node, src)
                    if kind is None:
                        continue
                elif kind == "class" and def_node.type in STRUCT_NODE_TYPES:
                    kind = "struct"
                elif kind == "module" and def_node.type == "mod_item" and def_node.child_by_field_name("body") is None:
                    continue  # `mod store;` declares a file module; it is an import, not a definition
                key = (def_node.start_byte, def_node.end_byte)
                if key not in raw_defs:
                    raw_defs[key] = (kind, _text(name_node, src), def_node)
            elif cap in CALL_CAPTURES or (cap == "reference.class" and nodes[0].type in NEW_NODE_TYPES):
                call_refs.append((cap, nodes[0], name_node))

    # Nesting of definitions → qualified names. Sorted outer-first.
    defs = sorted(raw_defs.items(), key=lambda kv: (kv[0][0], -kv[0][1]))
    symbols, ranges = [], []  # ranges: (start, end, symbol)
    open_stack = []
    seen_ids = set()
    for (start, end), (kind, name, def_node) in defs:
        if not name:
            continue
        while open_stack and open_stack[-1][1] <= start:
            open_stack.pop()
        parents = [s for _, _, s in open_stack]
        class_parent = next((s for s in reversed(parents) if s.kind in CLASS_KINDS), None)
        owner = None
        if kind in FUNCTION_KINDS and class_parent is None:
            owner = _outside_owner(def_node, lang, src)
        names = [s.name for s in parents]
        if owner and not parents:
            names = owner.split("::")[-1:]
        qualified = ".".join(names + [name])
        in_function = any(s.kind in FUNCTION_KINDS for s in parents)
        class_name = None
        if kind in FUNCTION_KINDS and (class_parent is not None or owner):
            if class_parent is not None and parents and parents[-1] is class_parent:
                class_name = class_parent.qualified_name
            elif owner and not parents:
                class_name = owner.split("::")[-1]
            if class_name:
                kind = "method"
        sid = f"{path}::{qualified}"
        if sid in seen_ids:
            continue  # overloads / redefinitions: keep the first
        seen_ids.add(sid)
        sym = Symbol(
            id=sid, kind=kind, name=name, qualified_name=qualified, file=path,
            start_line=def_node.start_point[0] + 1, end_line=def_node.end_point[0] + 1, lang=lang,
            class_name=class_name, top_level=not in_function,
            doc=_preceding_doc(def_node, src) if kind in CLASS_KINDS else "",
            nesting=max_nesting(def_node) if kind in FUNCTION_KINDS else 0,
            signature=_short(_text(def_node, src).split("\n", 1)[0], 200),
        )
        symbols.append(sym)
        ranges.append((start, end, sym))
        open_stack.append((start, end, sym))

    # -- calls ----------------------------------------------------------------------
    fn_ranges = sorted(((s, e, sym) for s, e, sym in ranges if sym.kind in FUNCTION_KINDS), key=lambda r: (r[0], -r[1]))
    calls, seen_calls = [], set()
    for cap, ref_node, name_node in call_refs:
        pos = ref_node.start_byte
        caller = None
        for s, e, sym in fn_ranges:
            if s <= pos < e:
                caller = sym  # sorted outer-first, so the last match is the innermost
        name = _text(name_node, src)
        # Receiver: the expression the name hangs off (this.render, util.fmt, Store::new). Some
        # queries capture the arguments node as the reference, so read it from the name's parent.
        holder = name_node.parent
        start = holder.start_byte if holder is not None and holder.start_byte < name_node.start_byte else name_node.start_byte
        prefix = src[start:name_node.start_byte].decode("utf-8", errors="replace")
        is_new = ref_node.type in NEW_NODE_TYPES and holder == ref_node
        receiver = re.sub(r"^\s*new\s+", "", prefix).strip()
        receiver = re.sub(r"(\?\.|\.|->|::)$", "", receiver).strip()
        receiver = " ".join(receiver.split())[:MAX_RECEIVER] or None
        line = ref_node.start_point[0] + 1
        caller_id = caller.id if caller else path
        key = (caller_id, name, receiver, line)
        if not name or key in seen_calls:
            continue
        seen_calls.add(key)
        calls.append(CallRef(file=path, caller_id=caller_id, callee_text=name, lang=lang,
                             receiver=receiver, line=line, kind="new" if is_new else "call"))

    pf.symbols = symbols
    pf.calls = calls
    pf.imports = _imports(root, src, lang, path)
    pf.doc = _file_doc(root, src)
    if lang == "go":
        pkg = next((c for c in root.children if c.type == "package_clause"), None)
        if pkg is not None:
            pf.extras["go_package"] = _text(pkg, src).replace("package", "", 1).strip()
    return pf.to_dict()
