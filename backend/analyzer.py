import re
import uuid
import networkx as nx

def analyze_repo(parse_output: dict, source_files: dict, graph: dict) -> dict:
    """
    Analyzes the repo for security, quality, and patterns.
    """
    issues = []
    patterns = []
    
    # 1. File-level Security and Quality Issues
    # Hardcoded secrets patterns
    secret_patterns = [
        (r'(password|passwd|pwd)\s*=\s*["\'][^"\']{4,}["\']', "password"),
        (r'(api_key|apikey|api_secret)\s*=\s*["\'][^"\']{8,}["\']', "api_key"),
        (r'(secret_key|secret)\s*=\s*["\'][^"\']{8,}["\']', "secret_key"),
        (r'(token)\s*=\s*["\'][^"\']{10,}["\']', "token"),
        (r'(aws_access_key_id|aws_secret)\s*=\s*["\']', "aws_key")
    ]
    secret_exclude_terms = ["example", "placeholder", "your_", "YOUR_", "<", ">", "os.getenv", "os.environ", "config."]
    
    sql_injection_pattern = re.compile(r'execute\s*\(\s*f["\']|execute\s*\(\s*["\'].*\+.*["\']')
    eval_pattern = re.compile(r'\beval\s*\(')
    
    debug_patterns = [
        re.compile(r'\bpdb\.set_trace\(\)'),
        re.compile(r'\bbreakpoint\(\)'),
        re.compile(r'\bprint\s*\(\s*["\']DEBUG')
    ]
    
    todo_pattern = re.compile(r'#\s*(TODO|FIXME|HACK|XXX|BUG)[\s:](.*)', re.IGNORECASE)
    
    for file_path, content in source_files.items():
        if not content:
            continue
        
        is_test_file = file_path.startswith("test_") or "/test_" in file_path or "/tests/" in file_path
        
        lines = content.split('\n')
        for i, line in enumerate(lines):
            line_idx = i + 1
            # Exclude comments for eval and SQL, but we might just do a basic check
            is_comment = line.lstrip().startswith('#')
            
            # Check secrets
            if not is_comment:
                has_exclude = any(term in line for term in secret_exclude_terms)
                if not has_exclude:
                    for pat, type_str in secret_patterns:
                        if re.search(pat, line, re.IGNORECASE):
                            issues.append({
                                "id": str(uuid.uuid4()),
                                "file": file_path,
                                "line": line_idx,
                                "severity": "high",
                                "type": "security",
                                "message": f"Possible hardcoded {type_str} detected",
                                "function": None
                            })
                            break # One secret per line is enough
                
                # Check SQL Injection
                if sql_injection_pattern.search(line):
                    issues.append({
                        "id": str(uuid.uuid4()),
                        "file": file_path,
                        "line": line_idx,
                        "severity": "high",
                        "type": "security",
                        "message": "Potential SQL injection via string formatting",
                        "function": None
                    })
                    
                # Check Dangerous Eval
                if eval_pattern.search(line):
                    issues.append({
                        "id": str(uuid.uuid4()),
                        "file": file_path,
                        "line": line_idx,
                        "severity": "high",
                        "type": "security",
                        "message": "Use of eval() — arbitrary code execution risk",
                        "function": None
                    })
            
            # Check Debug Statements
            if not is_test_file and not is_comment:
                for d_pat in debug_patterns:
                    if d_pat.search(line):
                        issues.append({
                            "id": str(uuid.uuid4()),
                            "file": file_path,
                            "line": line_idx,
                            "severity": "medium",
                            "type": "quality",
                            "message": "Debug statement left in production code",
                            "function": None
                        })
                        break
                        
            # Check TODO/FIXME
            todo_match = todo_pattern.search(line)
            if todo_match:
                content_match = todo_match.group(2).strip()[:60]
                issues.append({
                    "id": str(uuid.uuid4()),
                    "file": file_path,
                    "line": line_idx,
                    "severity": "low",
                    "type": "quality",
                    "message": f"TODO/FIXME comment: {content_match}",
                    "function": None
                })
                
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
        
        if length > 50:
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
            
            # Parameters
            params = p_fn.get("args", [])
            if len(params) > 6:
                issues.append({
                    "id": str(uuid.uuid4()),
                    "file": file_path,
                    "line": start_line,
                    "severity": "medium",
                    "type": "quality",
                    "message": f"Function {fn_name} has {len(params)} parameters — may indicate poor design",
                    "function": fn_name
                })
            
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
            
        # Patterns inside classes
        for p_cls in parsed_file.get("classes", []):
            cls_name = p_cls.get("name", "")
            methods = p_cls.get("methods", [])
            class_vars = p_cls.get("class_variables", [])
            
            # God Object
            if len(methods) > 15:
                issues.append({
                    "id": str(uuid.uuid4()),
                    "file": file_path,
                    "line": p_cls.get("start_line", 1),
                    "severity": "medium",
                    "type": "quality",
                    "message": f"Class {cls_name} has {len(methods)} methods — possible God Object anti-pattern",
                    "function": None
                })
                
            # Singleton
            is_singleton = any(m.get("name") in ("get_instance", "getInstance") for m in methods) or "_instance" in class_vars
            if is_singleton:
                patterns.append({
                    "name": "Singleton",
                    "file": file_path,
                    "class": cls_name,
                    "description": "Ensures a class has only one instance and provides a global point of access to it."
                })
                
            # Factory
            is_factory = any("factory" in m.get("name", "").lower() or m.get("name", "").startswith("create_") for m in methods)
            if "factory" in cls_name.lower() or is_factory:
                patterns.append({
                    "name": "Factory",
                    "file": file_path,
                    "class": cls_name,
                    "description": "Creates objects without specifying the exact class to create."
                })
                
            # Repository
            repo_methods = {"get", "find", "save", "delete", "update", "list"}
            cls_method_names = {m.get("name") for m in methods}
            if len(repo_methods.intersection(cls_method_names)) >= 3:
                patterns.append({
                    "name": "Repository",
                    "file": file_path,
                    "class": cls_name,
                    "description": "Mediates between the domain and data mapping layers using a collection-like interface."
                })
                
            # Context Manager
            if "__enter__" in cls_method_names and "__exit__" in cls_method_names:
                patterns.append({
                    "name": "Context Manager",
                    "file": file_path,
                    "class": cls_name,
                    "description": "Implements the context management protocol (__enter__, __exit__) for resource management."
                })
                
        # Factory or Decorator in module-level functions
        for p_fn in parsed_file.get("functions", []):
            fn_name = p_fn.get("name", "")
            if "factory" in fn_name.lower() or fn_name.startswith("create_"):
                # We might double count if it was a method, but module level funcs are here
                patterns.append({
                    "name": "Factory",
                    "file": file_path,
                    "class": fn_name,
                    "description": "Function acting as a factory to create and return objects."
                })
                
            # Decorator
            params = p_fn.get("args", [])
            if any(p in ("func", "fn", "decorated") for p in params):
                # Loose heuristic for returning a function is harder without AST body inspection, but param is a good hint
                patterns.append({
                    "name": "Decorator",
                    "file": file_path,
                    "class": fn_name,
                    "description": "Function that modifies the behavior of another function."
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
            
    # Dead code
    # calculate in-degrees for functions
    in_degrees = {n["id"]: 0 for n in functions}
    for e in graph.get("edges", []):
        if e.get("target") in in_degrees:
            in_degrees[e.get("target")] += 1
            
    for fn in functions:
        fn_id = fn["id"]
        fn_name = fn.get("label", "")
        if in_degrees.get(fn_id, 0) == 0:
            if not fn_name.startswith("_") and not fn_name.startswith("test_"):
                if fn_name not in ("main", "__init__", "__str__", "__repr__", "__eq__"):
                    issues.append({
                        "id": str(uuid.uuid4()),
                        "file": fn.get("file"),
                        "line": fn.get("lines", [1])[0],
                        "severity": "low",
                        "type": "dead_code",
                        "message": f"Function {fn_name} appears to be unused",
                        "function": fn_name
                    })

    # Deduplicate patterns
    unique_patterns = []
    seen_patterns = set()
    for p in patterns:
        key = (p["name"], p["file"], p.get("class"))
        if key not in seen_patterns:
            seen_patterns.add(key)
            unique_patterns.append(p)
            
    # Deduplicate issues
    unique_issues = []
    seen_issues = set()
    for i in issues:
        key = (i["file"], i["line"], i["message"])
        if key not in seen_issues:
            seen_issues.add(key)
            unique_issues.append(i)

    # 3. Compute Health Score
    health_result = compute_health_score(unique_issues, graph, unique_patterns)
    
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
    health_result["patterns"] = unique_patterns
    health_result["by_file"] = by_file
    
    return health_result

def compute_health_score(issues: list[dict], graph: dict, patterns: list[dict]) -> dict:
    score = 100
    
    high_count = sum(1 for i in issues if i["severity"] == "high")
    med_count = sum(1 for i in issues if i["severity"] == "medium")
    low_count = sum(1 for i in issues if i["severity"] == "low")
    
    score -= (high_count * 8)
    score -= (med_count * 3)
    score -= (low_count * 1)
    score += (len(patterns) * 2)
    
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
    
    if circular_import_count > 0:
        score -= (circular_import_count * 10)
        
    if total_functions > 0 and (dead_code_count / total_functions) > 0.2:
        score -= 10
        
    if avg_function_length > 40:
        score -= 5
        
    score = max(0, min(100, int(score))) # clamp 0-100
    
    if score >= 90:
        grade = "A"
        grade_color = "#22c55e" # green
    elif score >= 80:
        grade = "B"
        grade_color = "#4ade80" # light green
    elif score >= 70:
        grade = "C"
        grade_color = "#eab308" # yellow
    elif score >= 60:
        grade = "D"
        grade_color = "#f97316" # orange
    else:
        grade = "F"
        grade_color = "#ef4444" # red
        
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
