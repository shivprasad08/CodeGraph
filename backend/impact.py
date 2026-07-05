import json
import logging
import re
from chat import groq_client

logger = logging.getLogger(__name__)

def build_relevant_context(graph, source_node):
    """
    Extract the most relevant edges for this node to give the LLM context.
    """
    node_id = source_node["id"]
    
    # Who calls this node
    callers = [
        e["source"] for e in graph["edges"]
        if e["target"] == node_id and e["type"] == "calls"
    ][:5]
    
    # What this node calls
    callees = [
        e["target"] for e in graph["edges"]
        if e["source"] == node_id and e["type"] == "calls"
    ][:5]
    
    # Files that import this file
    importers = [
        e["source"] for e in graph["edges"]
        if e["target"] == source_node.get("file") and e["type"] == "imports"
    ][:5]
    
    return f"""
    Called by: {callers}
    Calls: {callees}
    Imported by: {importers}
    """

def build_impact_prompt(
    graph: dict,
    source_node: dict,
    change_description: str,
    blast_radius_data: dict
) -> str:
    system_prompt = """You are a senior software architect performing impact analysis for a 
proposed code change. You have been given:
1. The file/function being changed
2. A description of the intended change
3. A pre-computed blast radius showing which nodes depend on the changed code

Your job is to provide a structured impact analysis covering:
- What is likely to break immediately (direct dependents)
- What might break transitively (indirect dependents)  
- Which pipeline entry points are at risk
- What the developer should test or verify before making the change
- Whether the change seems safe, risky, or dangerous

Be specific. Reference actual file and function names from the graph data.
Keep your analysis to 6-8 sentences. Be direct — no padding.

IMPORTANT: End with a RISK_LEVEL: line:
RISK_LEVEL: SAFE | CAUTION | RISKY | DANGEROUS
"""

    user_prompt = f"""Repository: {graph.get('repo', 'unknown')}

CHANGED NODE:
  ID: {source_node.get("id")}
  Type: {source_node.get("type")}
  Summary: {source_node.get("summary")}
  File: {source_node.get("file")}

PROPOSED CHANGE:
  {change_description}

BLAST RADIUS (pre-computed):
  Total affected nodes: {blast_radius_data.get("affected_count")}
  
  Critical (direct dependents):
  {json.dumps(blast_radius_data.get("critical_nodes", []), indent=2)}
  
  Broken pipelines at risk:
  {json.dumps(blast_radius_data.get("broken_pipelines", []), indent=2)}
  
  Key relationships in the graph:
  {build_relevant_context(graph, source_node)}

Analyze the impact of this change. What breaks? What needs testing?
End with RISK_LEVEL: [SAFE|CAUTION|RISKY|DANGEROUS]
"""
    return system_prompt + "\n\n---\n\n" + user_prompt

async def stream_impact_analysis(job_id: str, graph: dict, source_node: dict, change_description: str, blast_radius_data: dict):
    if not groq_client:
        yield f"data: {json.dumps({'token': 'Error: Groq API key not configured.', 'done': True, 'risk_level': 'RISKY', 'nodes': []})}\n\n"
        return
        
    prompt = build_impact_prompt(graph, source_node, change_description, blast_radius_data)
    
    messages = [
        {"role": "user", "content": prompt}
    ]
    
    full_response = ""
    
    try:
        stream = await groq_client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=messages,
            max_tokens=800,
            temperature=0.2,
            stream=True
        )
        
        async for chunk in stream:
            token = chunk.choices[0].delta.content or ""
            if token:
                full_response += token
                yield f"data: {json.dumps({'token': token, 'done': False})}\n\n"
        
        # Parse RISK_LEVEL from response
        match = re.search(r'RISK_LEVEL:\s*(SAFE|CAUTION|RISKY|DANGEROUS)', full_response, re.IGNORECASE)
        risk_level = match.group(1).upper() if match else "CAUTION"
        
        # Parse inline nodes if any, assuming standard NODE: syntax or just inline `node::id` logic is handled on frontend.
        # Let's just return done and risk_level.
        yield f"data: {json.dumps({'token': '', 'done': True, 'risk_level': risk_level, 'nodes': []})}\n\n"
        
    except Exception as e:
        logger.error(f"Impact Analysis error: {e}")
        error_msg = f'\n\n**Sorry, I encountered an error:** {str(e)}'
        yield f"data: {json.dumps({'token': error_msg, 'done': True, 'risk_level': 'RISKY', 'nodes': []})}\n\n"
