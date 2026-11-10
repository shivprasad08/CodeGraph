# What it does: language-neutral intermediate representation produced by every parser
#
# A ParsedFile serialises to the parse_output shape graph_builder.py consumes:
#   {path, lang, loc, doc, symbols, imports, calls, ...language extras}
# Python adds its richer records (functions, classes, call_sites) as extras so its
# scope-aware resolver keeps working unchanged; other languages only use the IR lists.

from dataclasses import asdict, dataclass, field

SYMBOL_KINDS = ("function", "method", "class", "interface", "struct", "module")


@dataclass
class Symbol:
    id: str                       # path::QualifiedName
    kind: str                     # one of SYMBOL_KINDS
    name: str
    qualified_name: str
    file: str
    start_line: int
    end_line: int
    lang: str
    class_name: str | None = None  # owning class/struct/impl for methods
    doc: str = ""
    top_level: bool = True        # not nested in a function
    nesting: int = 0              # deepest control-flow nesting inside the body
    signature: str = ""           # first line of the definition (entry-point rules)


@dataclass
class ImportRef:
    file: str
    raw: str                      # source text of the import statement (trimmed)
    module: str                   # what is imported: "./util", "crate::store", "java.util.List"
    lang: str
    names: list = field(default_factory=list)   # imported names ("*" for all)
    alias: str | None = None      # module alias (import * as ns, import x as y, Go package alias)
    level: int = 0                # Python relative-import dots
    aliases: dict = field(default_factory=dict)  # local name → imported name (named imports)


@dataclass
class CallRef:
    file: str
    caller_id: str                # enclosing symbol id, or the file path at module level
    callee_text: str              # called name ("save", "new Foo" → "Foo")
    lang: str
    receiver: str | None = None   # text before the name ("this", "store", "fmt")
    line: int = 0
    kind: str = "call"            # call | new


@dataclass
class ParsedFile:
    path: str
    lang: str
    symbols: list = field(default_factory=list)
    imports: list = field(default_factory=list)
    calls: list = field(default_factory=list)
    doc: str = ""
    loc: int = 0
    extras: dict = field(default_factory=dict)  # language-specific detail (Python resolver input)

    def to_dict(self) -> dict:
        out = {
            "path": self.path,
            "lang": self.lang,
            "loc": self.loc,
            "doc": self.doc,
            "symbols": [asdict(s) for s in self.symbols],
            "imports": [asdict(i) for i in self.imports],
            "calls": [asdict(c) for c in self.calls],
        }
        out.update(self.extras)
        return out


def count_loc(content: str) -> int:
    """Non-blank lines."""
    return sum(1 for line in content.splitlines() if line.strip())


# Control-flow node types that count as one nesting level, across grammars
NESTING_TYPES = frozenset({
    "if_statement", "for_statement", "for_in_statement", "for_of_statement", "while_statement",
    "do_statement", "try_statement", "switch_statement", "with_statement", "match_statement",
    "foreach_statement", "enhanced_for_statement", "for_range_loop", "case_statement",
    "if_expression", "match_expression", "while_expression", "loop_expression", "for_expression",
    "if_let_expression", "while_let_expression", "select_statement", "expression_switch_statement",
    "type_switch_statement", "if", "unless", "while", "until", "for", "case", "begin",
    "repeat_statement", "guard_statement", "when_expression", "try_expression",
})
FUNCTION_TYPES = frozenset({
    "function_definition", "function_declaration", "method_definition", "method_declaration",
    "function_item", "arrow_function", "function_expression", "lambda", "lambda_expression",
    "closure_expression", "func_literal", "method", "singleton_method", "constructor_declaration",
    "local_function_statement", "anonymous_function",
})


def max_nesting(node) -> int:
    """Deepest control-flow nesting inside `node`, not descending into nested functions."""
    best = 0
    stack = [(child, 0) for child in node.children]
    while stack:
        n, depth = stack.pop()
        if n.type in FUNCTION_TYPES:
            continue
        if n.is_named and n.type in NESTING_TYPES:  # named only: "if"/"for" are also keyword tokens
            depth += 1
            best = max(best, depth)
        stack.extend((c, depth) for c in n.children)
    return best
