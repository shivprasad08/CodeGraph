// Small, pure helpers over a CodeGraph graph ({ repo, commit_sha, nodes, edges }).

/** Counts used in the landing-page demo caption. */
export function graphStats(graph) {
  const nodes = graph?.nodes ?? [];
  return {
    name: (graph?.repo ?? '').split('/').pop(),
    files: nodes.filter((n) => n.type === 'file').length,
    nodes: nodes.length,
    edges: graph?.edges?.length ?? 0,
  };
}

/** Map of node id → number of edges touching it (as source or target). */
export function nodeDegrees(edges = []) {
  const degrees = new Map();
  for (const { source, target } of edges) {
    const s = typeof source === 'object' ? source.id : source;
    const t = typeof target === 'object' ? target.id : target;
    degrees.set(s, (degrees.get(s) ?? 0) + 1);
    degrees.set(t, (degrees.get(t) ?? 0) + 1);
  }
  return degrees;
}

/** Ids of the `count` highest-degree nodes (ties keep graph order). */
export function topNodeIdsByDegree(graph, count) {
  const degrees = nodeDegrees(graph?.edges);
  return new Set(
    [...(graph?.nodes ?? [])]
      .sort((a, b) => (degrees.get(b.id) ?? 0) - (degrees.get(a.id) ?? 0))
      .slice(0, count)
      .map((n) => n.id),
  );
}

const numberFormat = new Intl.NumberFormat('en-US');
export const formatCount = (n) => numberFormat.format(n);
