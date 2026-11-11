# What it does: decides whether a PR's change to a function/class is code, documentation or formatting
#
# For one graph node, its "own tokens" are the tree-sitter leaves of its definition, excluding
# nested definitions (other graph nodes inside it, with their decorators) and, unless asked
# for, comments and docstrings (Python: the first-statement string of a module/class/def;
# every language: comment nodes, which include JSDoc / doc comments).
# Comparing base and head:
#   code tokens differ                       → "modified"
#   code equal, docs/comments differ         → "docs"
#   all tokens equal (whitespace / layout)   → "format"; a container (class, or a function with
#                                             nested definitions) is no change at all: the edit
#                                             was in something nested inside it
# When a file can't be parsed or the node isn't found, the caller keeps "modified".

import logging

from languages import registry

logger = logging.getLogger("codegraph.pr")

PY_DEF_TYPES = ("function_definition", "class_definition")


def _parser_for(path: str):
    lang = registry.language_of(path)
    if lang == "python":
        from languages.python import PARSER

        return PARSER
    if lang is None:
        return None
    loaded = registry.load(registry.grammar_of(path, lang))
    return loaded[0] if loaded else None


class SourceFile:
    """One file's text and tree, parsed lazily (None when unparseable)."""

    def __init__(self, path: str, text: str):
        self.path = path
        self.src = text.encode("utf-8")
        self.python = registry.language_of(path) == "python"
        self._root = False

    @property
    def root(self):
        if self._root is False:
            try:
                parser = _parser_for(self.path)
                self._root = parser.parse(self.src).root_node if parser else None
            except Exception as e:  # a grammar problem must never fail the PR analysis
                logger.info(f"[pr] could not parse {self.path}: {type(e).__name__}")
                self._root = None
        return self._root

    def find(self, start_line: int, end_line: int):
        """The largest node spanning exactly these (1-based) lines."""
        root = self.root
        if root is None:
            return None
        best = None
        stack = [root]
        while stack:
            node = stack.pop()
            s, e = node.start_point[0] + 1, node.end_point[0] + 1
            if s > end_line or e < start_line:
                continue
            if s == start_line and e == end_line and (best is None or node.end_byte - node.start_byte > best.end_byte - best.start_byte):
                best = node
            stack.extend(node.children)
        return best


def _is_comment(node) -> bool:
    return "comment" in node.type


def _is_docstring(node) -> bool:
    """Python: a string expression that is the first statement of a module, class or function."""
    if node.type != "expression_statement" or node.named_child_count != 1 or node.named_children[0].type != "string":
        return False
    parent = node.parent
    if parent is None:
        return False
    first = next((c for c in parent.named_children if not _is_comment(c)), None)
    if first is None or first.id != node.id:
        return False
    return parent.type == "module" or (parent.type == "block" and parent.parent is not None and parent.parent.type in PY_DEF_TYPES)


def own_tokens(sf: SourceFile, start_line: int, end_line: int, nested: set[tuple[int, int]], keep_docs: bool) -> list[str] | None:
    """The node's own leaf texts (see module docstring), or None when it can't be located."""
    target = sf.find(start_line, end_line)
    if target is None:
        return None
    out: list[str] = []

    def nested_def(node) -> bool:
        span = (node.start_point[0] + 1, node.end_point[0] + 1)
        if span in nested:
            return True
        # A decorated nested definition: the decorators belong to it, not to the container
        if node.type == "decorated_definition":
            inner = node.child_by_field_name("definition")
            return inner is not None and (inner.start_point[0] + 1, inner.end_point[0] + 1) in nested
        return False

    stack = [target]
    while stack:
        node = stack.pop()
        if node is not target and nested_def(node):
            continue
        if not keep_docs and (_is_comment(node) or (sf.python and _is_docstring(node))):
            continue
        if node.child_count == 0:
            out.append(sf.src[node.start_byte:node.end_byte].decode("utf-8", "replace"))
        else:
            stack.extend(reversed(node.children))
    return out


def classify(base: SourceFile | None, head: SourceFile | None, base_lines, head_lines,
             base_nested: set, head_nested: set) -> str | None:
    """'modified' | 'docs' | 'format' | 'none' (container with no own change); None = unknown."""
    if base is None or head is None or not base_lines or not head_lines:
        return None
    b_code = own_tokens(base, *base_lines, base_nested, keep_docs=False)
    h_code = own_tokens(head, *head_lines, head_nested, keep_docs=False)
    if b_code is None or h_code is None:
        return None
    if b_code != h_code:
        return "modified"
    b_all = own_tokens(base, *base_lines, base_nested, keep_docs=True)
    h_all = own_tokens(head, *head_lines, head_nested, keep_docs=True)
    if b_all != h_all:
        return "docs"
    return "none" if (base_nested or head_nested) else "format"
