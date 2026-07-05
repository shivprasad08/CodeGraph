function depthToSeverity(depth) {
  if (depth === 1) return "critical";   // direct dependency
  if (depth === 2) return "high";
  if (depth <= 4) return "medium";
  return "low";
}

export function computeBlastRadius(graph, sourceNodeIds, maxDepth = 6) {
  // Build adjacency map from edges
  // An edge A->B means: if A changes, B may be affected
  // For "calls" and "imports" edges: the caller/importer is affected
  // Direction: we want REVERSE reachability
  // i.e. "who depends on the changed file"
  
  // Build reverse adjacency: nodeId -> [nodes that depend on it]
  const reverseDeps = {};
  for (const edge of graph.edges) {
    if (edge.type === "calls" || edge.type === "imports" || edge.type === "defines") {
      const targetId = typeof edge.target === 'object' ? edge.target.id : edge.target;
      const sourceId = typeof edge.source === 'object' ? edge.source.id : edge.source;
      
      if (!reverseDeps[targetId]) reverseDeps[targetId] = [];
      reverseDeps[targetId].push(sourceId);
    }
  }
  
  // BFS from source nodes through reverse dependency graph
  const affected = new Map();
  const queue = [];
  
  // Initialize with source nodes at depth 0
  for (const id of sourceNodeIds) {
    affected.set(id, { depth: 0, severity: "source", paths: [[id]] });
    queue.push({ id, depth: 0, path: [id] });
  }
  
  while (queue.length > 0) {
    const { id, depth, path } = queue.shift();
    
    if (depth >= maxDepth) continue;
    
    const dependents = reverseDeps[id] ?? [];
    
    for (const depId of dependents) {
      const newDepth = depth + 1;
      const newPath = [...path, depId];
      
      if (!affected.has(depId)) {
        affected.set(depId, {
          depth: newDepth,
          severity: depthToSeverity(newDepth),
          paths: [newPath]
        });
        queue.push({ id: depId, depth: newDepth, path: newPath });
      } else {
        // Already found - add this path as an alternate route
        const existing = affected.get(depId);
        if (existing.paths.length < 3) {   // cap at 3 paths per node
          existing.paths.push(newPath);
        }
      }
    }
  }
  
  // Compute stats
  const byDepth = {};
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  
  for (const [_, data] of affected) {
    byDepth[data.depth] = (byDepth[data.depth] ?? 0) + 1;
    if (data.severity !== "source") {
        bySeverity[data.severity] = (bySeverity[data.severity] || 0) + 1;
    }
  }
  
  return {
    affected,
    stats: { total: affected.size - sourceNodeIds.length, byDepth, bySeverity }
  };
}

export function detectBrokenPipelines(graph, affectedNodeIds) {
  /*
  Identifies which pipeline paths are broken:
  entry_points that can no longer reach their dependencies.
  
  A "pipeline" is defined as: entry_point -> ... -> affected_node
  If any node along the path is affected, the pipeline is at risk.
  */
  
  const entryPoints = graph.nodes.filter(n => n.is_entry_point);
  const broken = [];
  
  for (const ep of entryPoints) {
    // Find all paths from this entry point to affected nodes
    // Use simple BFS (forward direction this time)
    const forwardDeps = {};
    for (const edge of graph.edges) {
      if (edge.type === "calls" || edge.type === "imports") {
        const targetId = typeof edge.target === 'object' ? edge.target.id : edge.target;
        const sourceId = typeof edge.source === 'object' ? edge.source.id : edge.source;
          
        if (!forwardDeps[sourceId]) forwardDeps[sourceId] = [];
        forwardDeps[sourceId].push(targetId);
      }
    }
    
    // BFS from entry point
    const visited = new Set();
    const q = [ep.id];
    const reachesAffected = [];
    
    while (q.length > 0) {
      const curr = q.shift();
      if (visited.has(curr)) continue;
      visited.add(curr);
      
      if (affectedNodeIds.has(curr) && curr !== ep.id) {
        reachesAffected.push(curr);
      }
      
      for (const next of (forwardDeps[curr] ?? [])) {
        q.push(next);
      }
    }
    
    if (reachesAffected.length > 0) {
      broken.push({
        entryPoint: ep,
        affectedInPath: reachesAffected,
        risk: reachesAffected.some(id =>
          graph.nodes.find(n => n.id === id)?.issue_severity === "high"
        ) ? "high" : "medium"
      });
    }
  }
  
  return broken;
}
