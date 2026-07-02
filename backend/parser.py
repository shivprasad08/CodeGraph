# What it does: tree-sitter AST extractor for Python files
# Module 2: Parser
#
# Takes the dict returned by ingestion.py's fetch_repo() and extracts
# functions, classes, imports, and call sites from each Python file
# using tree-sitter queries. Output feeds into Module 3 (graph_builder.py).

from tree_sitter import Language, Parser
import tree_sitter_python as tspython

# ---------------------------------------------------------------------------
# Module-level singleton: initialize tree-sitter parser ONCE
# ---------------------------------------------------------------------------
PY_LANGUAGE = Language(tspython.language())
PARSER = Parser(PY_LANGUAGE)

# ---------------------------------------------------------------------------
# Precompiled tree-sitter queries
# ---------------------------------------------------------------------------
FUNCTION_QUERY = PY_LANGUAGE.query("""
  (function_definition
    name: (identifier) @func.name
    parameters: (parameters) @func.params
    body: (block) @func.body) @func.def
""")

CLASS_QUERY = PY_LANGUAGE.query("""
  (class_definition
    name: (identifier) @class.name
    body: (block) @class.body) @class.def
""")

IMPORT_QUERY = PY_LANGUAGE.query("""
  (import_statement) @import
  (import_from_statement) @import_from
""")

CALL_QUERY = PY_LANGUAGE.query("""
  (call function: [
    (identifier) @call.name
    (attribute object: (_) @call.obj attribute: (identifier) @call.attr)
  ])
""")


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
# Enclosing function finder (walks up the tree)
# ---------------------------------------------------------------------------
def _get_enclosing_function(node, tree) -> str:
    """Walk up the tree from a call node to find its enclosing function name."""
    current = node.parent
    while current is not None:
        if current.type == "function_definition":
            name_node = current.child_by_field_name("name")
            if name_node:
                return name_node.text.decode("utf-8", errors="replace")
        current = current.parent
    return "__module__"


# ---------------------------------------------------------------------------
# Extraction: Functions
# ---------------------------------------------------------------------------
def _extract_functions(tree, source_bytes: bytes, path: str) -> list[dict]:
    """Extract all function definitions from the parsed tree."""
    matches = FUNCTION_QUERY.matches(tree.root_node)

    functions = []
    for _pattern_idx, capture_dict in matches:
        func_def_node = capture_dict.get("func.def")
        func_name_node = capture_dict.get("func.name")
        func_params_node = capture_dict.get("func.params")
        func_body_node = capture_dict.get("func.body")

        if not func_def_node or not func_name_node:
            continue

        name = func_name_node.text.decode("utf-8", errors="replace")
        start_line = func_def_node.start_point[0] + 1  # 1-indexed
        end_line = func_def_node.end_point[0] + 1

        # Extract parameters
        parameters = []
        if func_params_node:
            for child in func_params_node.children:
                if child.type == "identifier":
                    param_name = child.text.decode("utf-8", errors="replace")
                    if param_name not in ("self", "cls"):
                        parameters.append(param_name)
                elif child.type in ("typed_parameter", "default_parameter",
                                     "typed_default_parameter"):
                    # The name is the first identifier child or via field name
                    name_child = child.child_by_field_name("name")
                    if name_child is None:
                        for sub in child.children:
                            if sub.type == "identifier":
                                name_child = sub
                                break
                    if name_child:
                        param_name = name_child.text.decode("utf-8", errors="replace")
                        if param_name not in ("self", "cls"):
                            parameters.append(param_name)

        # Determine if this function is a method
        # In tree-sitter-python 0.21, the class body is a 'block' node
        # whose parent is a 'class_definition'
        is_method = False
        parent = func_def_node.parent
        if parent and parent.type == "block":
            grandparent = parent.parent
            if grandparent and grandparent.type == "class_definition":
                is_method = True

        # Extract decorator names
        decorator_names = []
        # Decorators wrap the function in a decorated_definition node
        decorated_parent = func_def_node.parent
        if decorated_parent and decorated_parent.type == "decorated_definition":
            for child in decorated_parent.children:
                if child.type == "decorator":
                    for deco_child in child.children:
                        if deco_child.type == "identifier":
                            decorator_names.append(
                                deco_child.text.decode("utf-8", errors="replace")
                            )
                        elif deco_child.type == "attribute":
                            decorator_names.append(
                                deco_child.text.decode("utf-8", errors="replace")
                            )
                        elif deco_child.type == "call":
                            fn_node = deco_child.child_by_field_name("function")
                            if fn_node:
                                decorator_names.append(
                                    fn_node.text.decode("utf-8", errors="replace")
                                )

        # Extract docstring
        docstring = _get_docstring(func_body_node, source_bytes)

        functions.append({
            "id": f"{path}::{name}",
            "name": name,
            "type": "function",
            "start_line": start_line,
            "end_line": end_line,
            "parameters": parameters,
            "is_method": is_method,
            "decorator_names": decorator_names,
            "docstring": docstring,
        })

    return functions


# ---------------------------------------------------------------------------
# Extraction: Classes
# ---------------------------------------------------------------------------
def _extract_classes(tree, source_bytes: bytes, path: str) -> list[dict]:
    """Extract all class definitions from the parsed tree."""
    matches = CLASS_QUERY.matches(tree.root_node)

    classes = []
    for _pattern_idx, capture_dict in matches:
        class_def_node = capture_dict.get("class.def")
        class_name_node = capture_dict.get("class.name")
        class_body_node = capture_dict.get("class.body")

        if not class_def_node or not class_name_node:
            continue

        name = class_name_node.text.decode("utf-8", errors="replace")
        start_line = class_def_node.start_point[0] + 1
        end_line = class_def_node.end_point[0] + 1

        # Extract base classes from superclasses field (argument_list)
        base_classes = []
        superclasses_node = class_def_node.child_by_field_name("superclasses")
        if superclasses_node:
            for child in superclasses_node.children:
                if child.type == "identifier":
                    base_classes.append(
                        child.text.decode("utf-8", errors="replace")
                    )
                elif child.type == "attribute":
                    base_classes.append(
                        child.text.decode("utf-8", errors="replace")
                    )

        # Extract method names defined inside this class body
        method_names = []
        if class_body_node:
            for child in class_body_node.children:
                if child.type == "function_definition":
                    method_name_node = child.child_by_field_name("name")
                    if method_name_node:
                        method_names.append(
                            method_name_node.text.decode("utf-8", errors="replace")
                        )
                elif child.type == "decorated_definition":
                    for sub in child.children:
                        if sub.type == "function_definition":
                            method_name_node = sub.child_by_field_name("name")
                            if method_name_node:
                                method_names.append(
                                    method_name_node.text.decode("utf-8", errors="replace")
                                )

        # Docstring
        docstring = _get_docstring(class_body_node, source_bytes)

        classes.append({
            "id": f"{path}::{name}",
            "name": name,
            "type": "class",
            "start_line": start_line,
            "end_line": end_line,
            "base_classes": base_classes,
            "method_names": method_names,
            "docstring": docstring,
        })

    return classes


# ---------------------------------------------------------------------------
# Extraction: Imports
# ---------------------------------------------------------------------------
def _extract_imports(tree, source_bytes: bytes) -> list[dict]:
    """Extract all import and import-from statements."""
    captures = IMPORT_QUERY.captures(tree.root_node)

    imports = []
    seen_nodes = set()  # Deduplicate by node id

    for node, capture_name in captures:
        if id(node) in seen_nodes:
            continue
        seen_nodes.add(id(node))

        if capture_name == "import":
            # Plain: import os  /  import os, sys  /  import os.path
            for child in node.children:
                if child.type == "dotted_name":
                    module_name = child.text.decode("utf-8", errors="replace")
                    imports.append({
                        "module": module_name,
                        "names": [module_name],
                        "is_relative": False,
                    })
                elif child.type == "aliased_import":
                    dotted = child.child_by_field_name("name")
                    if dotted:
                        module_name = dotted.text.decode("utf-8", errors="replace")
                        imports.append({
                            "module": module_name,
                            "names": [module_name],
                            "is_relative": False,
                        })

        elif capture_name == "import_from":
            # from X import Y, Z  /  from .X import Y
            module_name = ""
            names = []
            is_relative = False

            # Walk children to find module and imported names
            # Structure: from, [dotted_name | relative_import], import, name, ...
            past_import_keyword = False

            for child in node.children:
                if child.type == "relative_import":
                    is_relative = True
                    # Extract module name from inside the relative_import node
                    for sub in child.children:
                        if sub.type == "dotted_name":
                            module_name = sub.text.decode("utf-8", errors="replace")
                elif child.type == "dotted_name":
                    if not past_import_keyword:
                        # This is the module name (before 'import' keyword)
                        module_name = child.text.decode("utf-8", errors="replace")
                    else:
                        # This is an imported name (after 'import' keyword)
                        names.append(
                            child.text.decode("utf-8", errors="replace")
                        )
                elif child.type == "aliased_import":
                    name_node = child.child_by_field_name("name")
                    if name_node:
                        names.append(
                            name_node.text.decode("utf-8", errors="replace")
                        )
                    past_import_keyword = True
                elif child.type == "import":
                    past_import_keyword = True

            if not module_name and not names:
                continue

            imports.append({
                "module": module_name,
                "names": names,
                "is_relative": is_relative,
            })

    return imports


# ---------------------------------------------------------------------------
# Extraction: Call sites
# ---------------------------------------------------------------------------
def _extract_call_sites(tree, source_bytes: bytes) -> list[dict]:
    """Extract all function call sites from the parsed tree."""
    captures = CALL_QUERY.captures(tree.root_node)

    call_sites = []
    seen = set()

    for node, capture_name in captures:
        if capture_name == "call.name":
            # Simple call: verify_token()
            callee = node.text.decode("utf-8", errors="replace")
            caller = _get_enclosing_function(node, tree)
            key = (caller, callee, node.start_point[0])
            if key not in seen:
                seen.add(key)
                call_sites.append({
                    "caller_function": caller,
                    "callee": callee,
                })
        elif capture_name == "call.attr":
            # Attribute call: self.db.query() → callee = "db.query"
            attr_name = node.text.decode("utf-8", errors="replace")
            # The parent of this identifier is the attribute node
            attr_parent = node.parent
            if attr_parent and attr_parent.type == "attribute":
                obj_node = attr_parent.child_by_field_name("object")
                if obj_node:
                    obj_text = obj_node.text.decode("utf-8", errors="replace")
                    # Simplify: strip "self." prefix for cleaner callee names
                    if obj_text == "self":
                        callee = attr_name
                    else:
                        if obj_text.startswith("self."):
                            obj_text = obj_text[5:]
                        callee = f"{obj_text}.{attr_name}"
                else:
                    callee = attr_name
            else:
                callee = attr_name

            caller = _get_enclosing_function(node, tree)
            key = (caller, callee, node.start_point[0])
            if key not in seen:
                seen.add(key)
                call_sites.append({
                    "caller_function": caller,
                    "callee": callee,
                })

    return call_sites


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

    result["functions"] = _extract_functions(tree, source_bytes, path)
    result["classes"] = _extract_classes(tree, source_bytes, path)
    result["imports"] = _extract_imports(tree, source_bytes)
    result["call_sites"] = _extract_call_sites(tree, source_bytes)

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

    for i, file_entry in enumerate(files, start=1):
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
