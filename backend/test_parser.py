# What it does: Tests for the tree-sitter AST parser module
# Module 2: Parser Tests

import pytest
from parser import parse_file, parse_repo


# ---------------------------------------------------------------------------
# Test fixture: a realistic Python file as a string
# ---------------------------------------------------------------------------
SAMPLE_CODE = '''
from jose import jwt, JWTError
from .utils import helper

class TokenVerifier(BaseVerifier):
    """Verifies JWT tokens against the configured secret."""

    def __init__(self, secret):
        self.secret = secret

    def verify(self, token):
        """Verify a single token."""
        payload = jwt.decode(token, self.secret)
        return payload

def standalone_function(token, secret):
    """Validates a JWT token and returns the payload."""
    result = jwt.decode(token, secret)
    helper(result)
    return result
'''


class TestParseFileComplete:
    """Test parse_file on a realistic Python file with all node types."""

    def setup_method(self):
        self.result = parse_file("src/auth/utils.py", SAMPLE_CODE)

    def test_path(self):
        assert self.result["path"] == "src/auth/utils.py"

    # -- Functions ----------------------------------------------------------

    def test_functions_found(self):
        funcs = self.result["functions"]
        func_names = [f["name"] for f in funcs]
        assert "standalone_function" in func_names
        assert "__init__" in func_names
        assert "verify" in func_names

    def test_standalone_function_fields(self):
        func = next(
            f for f in self.result["functions"]
            if f["name"] == "standalone_function"
        )
        assert func["id"] == "src/auth/utils.py::standalone_function"
        assert func["type"] == "function"
        assert func["is_method"] is False
        assert "token" in func["parameters"]
        assert "secret" in func["parameters"]
        assert func["docstring"] == "Validates a JWT token and returns the payload."
        assert func["start_line"] > 0
        assert func["end_line"] >= func["start_line"]

    def test_method_is_method_flag(self):
        init_func = next(
            f for f in self.result["functions"]
            if f["name"] == "__init__"
        )
        assert init_func["is_method"] is True

        verify_func = next(
            f for f in self.result["functions"]
            if f["name"] == "verify"
        )
        assert verify_func["is_method"] is True

    def test_method_parameters_exclude_self(self):
        verify_func = next(
            f for f in self.result["functions"]
            if f["name"] == "verify"
        )
        assert "self" not in verify_func["parameters"]
        assert "token" in verify_func["parameters"]

    # -- Classes ------------------------------------------------------------

    def test_classes_found(self):
        classes = self.result["classes"]
        assert len(classes) == 1
        cls = classes[0]
        assert cls["name"] == "TokenVerifier"
        assert cls["id"] == "src/auth/utils.py::TokenVerifier"
        assert cls["type"] == "class"

    def test_class_base_classes(self):
        cls = self.result["classes"][0]
        assert "BaseVerifier" in cls["base_classes"]

    def test_class_method_names(self):
        cls = self.result["classes"][0]
        assert "__init__" in cls["method_names"]
        assert "verify" in cls["method_names"]

    def test_class_docstring(self):
        cls = self.result["classes"][0]
        assert cls["docstring"] == "Verifies JWT tokens against the configured secret."

    # -- Imports ------------------------------------------------------------

    def test_imports_found(self):
        imports = self.result["imports"]
        assert len(imports) >= 2

    def test_absolute_import(self):
        imp = next(
            (i for i in self.result["imports"] if i["module"] == "jose"),
            None,
        )
        assert imp is not None
        assert "jwt" in imp["names"]
        assert "JWTError" in imp["names"]
        assert imp["is_relative"] is False

    def test_relative_import(self):
        rel_imports = [i for i in self.result["imports"] if i["is_relative"]]
        assert len(rel_imports) >= 1
        rel = rel_imports[0]
        assert "helper" in rel["names"]

    # -- Call sites ---------------------------------------------------------

    def test_call_sites_found(self):
        calls = self.result["call_sites"]
        assert len(calls) > 0

    def test_call_site_in_function(self):
        calls = self.result["call_sites"]
        callers = {c["caller_function"] for c in calls}
        assert "standalone_function" in callers or "verify" in callers

    def test_attribute_call(self):
        calls = self.result["call_sites"]
        callees = {c["callee"] for c in calls}
        assert "jwt.decode" in callees


# ---------------------------------------------------------------------------
# Test: empty file
# ---------------------------------------------------------------------------
class TestParseFileEmpty:
    def test_empty_string(self):
        result = parse_file("empty.py", "")
        assert result["path"] == "empty.py"
        assert result["functions"] == []
        assert result["classes"] == []
        assert result["imports"] == []
        assert result["call_sites"] == []

    def test_whitespace_only(self):
        result = parse_file("blank.py", "   \n\n  \n")
        assert result["functions"] == []
        assert result["classes"] == []


# ---------------------------------------------------------------------------
# Test: syntax-error Python file (tree-sitter still parses, no crash)
# ---------------------------------------------------------------------------
class TestParseFileSyntaxError:
    def test_broken_python(self):
        broken_code = "def foo(\n    class = broken syntax {{{"
        result = parse_file("broken.py", broken_code)
        # Should not raise — tree-sitter is error-tolerant
        assert result["path"] == "broken.py"
        assert isinstance(result["functions"], list)
        assert isinstance(result["classes"], list)
        assert isinstance(result["imports"], list)
        assert isinstance(result["call_sites"], list)


# ---------------------------------------------------------------------------
# Test: node id format
# ---------------------------------------------------------------------------
class TestNodeIdFormat:
    def test_function_id(self):
        code = "def my_func():\n    pass\n"
        result = parse_file("pkg/module.py", code)
        assert len(result["functions"]) == 1
        assert result["functions"][0]["id"] == "pkg/module.py::my_func"

    def test_class_id(self):
        code = "class MyClass:\n    pass\n"
        result = parse_file("pkg/module.py", code)
        assert len(result["classes"]) == 1
        assert result["classes"][0]["id"] == "pkg/module.py::MyClass"


# ---------------------------------------------------------------------------
# Test: parse_repo on a two-file mock ingestion output
# ---------------------------------------------------------------------------
class TestParseRepo:
    def test_two_file_mock(self):
        ingestion_output = {
            "repo": "owner/repo",
            "commit_sha": "abc12345",
            "files": [
                {
                    "path": "src/main.py",
                    "content": "import os\n\ndef main():\n    print('hello')\n",
                },
                {
                    "path": "src/utils.py",
                    "content": "class Helper:\n    def run(self):\n        pass\n",
                },
            ],
        }
        result = parse_repo(ingestion_output)

        assert result["repo"] == "owner/repo"
        assert result["commit_sha"] == "abc12345"
        assert len(result["parsed_files"]) == 2

        paths = [pf["path"] for pf in result["parsed_files"]]
        assert "src/main.py" in paths
        assert "src/utils.py" in paths

        main_file = next(pf for pf in result["parsed_files"] if pf["path"] == "src/main.py")
        assert any(f["name"] == "main" for f in main_file["functions"])
        assert len(main_file["imports"]) >= 1

        utils_file = next(pf for pf in result["parsed_files"] if pf["path"] == "src/utils.py")
        assert any(c["name"] == "Helper" for c in utils_file["classes"])

    def test_skips_bad_files(self):
        """If one file is unparseable content-wise, the other still succeeds."""
        ingestion_output = {
            "repo": "test/repo",
            "commit_sha": "deadbeef",
            "files": [
                {"path": "good.py", "content": "x = 1\n"},
                {"path": "bad.py", "content": None},  # None content edge case
            ],
        }
        result = parse_repo(ingestion_output)
        # Should parse at least the good file (bad file might be skipped or empty)
        assert result["repo"] == "test/repo"
        assert len(result["parsed_files"]) >= 1
