import networkx as nx

def build_graph(parse_output: dict) -> dict:
    G = nx.DiGraph()
    repo = parse_output.get("repo", "")
    commit_sha = parse_output.get("commit_sha", "")
    parsed_files = parse_output.get("parsed_files", [])
    
    name_lookup = {}
    
    # 1. Add all definitions as nodes
    for f_data in parsed_files:
        path = f_data["path"]
        
        G.add_node(path, id=path, label=path, type="file", file=path, summary="", lines=[], centrality=0.0, is_entry_point=False)
        
        for cls in f_data.get("classes", []):
            node_id = cls["id"]
            name = cls["name"]
            G.add_node(node_id, id=node_id, label=name, type="class", file=path, summary="", lines=[cls["start_line"], cls["end_line"]], centrality=0.0, is_entry_point=False)
            G.add_edge(path, node_id, type="defines")
            name_lookup.setdefault(name, []).append(node_id)
            
        for func in f_data.get("functions", []):
            node_id = func["id"]
            name = func["name"]
            G.add_node(node_id, id=node_id, label=name, type="function", file=path, summary="", lines=[func["start_line"], func["end_line"]], centrality=0.0, is_entry_point=False)
            
            # If it's a method, we could link it to the class via contains, but we'll just link to file via defines for simplicity
            G.add_edge(path, node_id, type="defines")
            name_lookup.setdefault(name, []).append(node_id)

    # 2. Add edges (calls and imports)
    for f_data in parsed_files:
        path = f_data["path"]
        
        for call in f_data.get("call_sites", []):
            caller_name = call["caller_function"]
            callee_name = call["callee"]
            
            caller_id = path if caller_name == "__module__" else f"{path}::{caller_name}"
            
            possible_callees = name_lookup.get(callee_name, [])
            if not possible_callees and "." in callee_name:
                possible_callees = name_lookup.get(callee_name.split(".")[-1], [])
                
            for callee_id in possible_callees:
                if caller_id in G and callee_id in G:
                    G.add_edge(caller_id, callee_id, type="calls")
                    
        for imp in f_data.get("imports", []):
            mod_path = imp["module"].replace(".", "/") + ".py"
            if mod_path in G:
                G.add_edge(path, mod_path, type="imports")

    # 3. Compute PageRank centrality
    if len(G.nodes) > 0:
        try:
            centrality = nx.pagerank(G, alpha=0.85)
            for node, cent in centrality.items():
                G.nodes[node]["centrality"] = round(cent, 4)
        except Exception:
            pass
            
    # 4. Identify entry points
    for n in G.nodes():
        if G.nodes[n]["type"] == "function":
            incoming_calls = [u for u, v, d in G.in_edges(n, data=True) if d.get("type") == "calls"]
            if len(incoming_calls) == 0:
                G.nodes[n]["is_entry_point"] = True

    nodes = [data for n, data in G.nodes(data=True)]
    edges = [{"source": u, "target": v, "type": d.get("type", "unknown")} for u, v, d in G.edges(data=True)]
        
    return {
        "repo": repo,
        "commit_sha": commit_sha,
        "nodes": nodes,
        "edges": edges
    }
