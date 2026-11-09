import { describe, expect, it } from 'vitest';
import { ALWAYS_LABELLED, LABEL_GAP, decorate, labelBox, layoutSpec, pickLabels } from '../FlowDiagram';

const tokens = { borderStrong: '#555', canvas: '#000', text: '#fff', secondary: '#aaa', tertiary: '#888' };
const spec = {
  direction: 'TB',
  nodes: [
    { id: 'a', label: 'A', sublabel: '1 file · 2 functions', members: ['x.py'], cluster: 'x.py' },
    { id: 'b', label: 'B', cluster: 'y.py' },
    { id: 'c', label: 'C', cluster: 'z.py' },
    { id: 'lonely1', label: 'L1' },
    { id: 'lonely2', label: 'L2' },
  ],
  edges: [
    { source: 'a', target: 'b', weight: 10, label: '10 calls' },
    { source: 'b', target: 'c', weight: 1 },
    { source: 'c', target: 'c', weight: 5 }, // self-loop
    { source: 'a', target: 'missing', weight: 3 }, // unknown node
  ],
};

describe('layoutSpec', () => {
  const layout = layoutSpec(spec);
  const out = decorate(layout, { tokens });
  const pos = Object.fromEntries(layout.nodes.map((n) => [n.id, n.position]));

  it('lays linked nodes out top-to-bottom and puts unlinked ones in a grid below', () => {
    expect(pos.a.y).toBeLessThan(pos.b.y);
    expect(pos.b.y).toBeLessThan(pos.c.y);
    expect(pos.lonely1.y).toBeGreaterThan(pos.c.y);
    expect(pos.lonely1.y).toBe(pos.lonely2.y); // same grid row
  });

  it('drops self-loops and unknown targets; bezier edges 1–3px by weight with proportional arrows', () => {
    expect(out.edges.map((e) => `${e.source}→${e.target}`)).toEqual(['a→b', 'b→c']);
    const [ab, bc] = out.edges;
    expect(ab.type).toBe('default');
    expect(ab.style.strokeWidth).toBe(3);
    expect(bc.style.strokeWidth).toBe(1);
    expect(ab.markerEnd.width).toBeGreaterThan(bc.markerEnd.width);
    expect(ab.markerEnd.markerUnits).toBe('userSpaceOnUse');
    expect(ab.label).toBe('10 calls');
    expect(ab.ariaLabel).toBe('A to B, 10 calls');
  });

  it('frames only the linked part for the first fit and marks clickable nodes', () => {
    expect(layout.focusBox.y2).toBeLessThan(pos.lonely1.y);
    expect(layout.nodes.find((n) => n.id === 'a').data.clickable).toBe(true);
    expect(layout.nodes.find((n) => n.id === 'b').data.clickable).toBe(false);
    expect(layout.nodes.find((n) => n.id === 'a').ariaLabel).toBe('A, 1 file · 2 functions');
  });

  it('gives each cluster its own --cg-cluster-* colour', () => {
    const colors = layout.nodes.filter((n) => n.data.cluster).map((n) => n.data.color);
    expect(new Set(colors).size).toBe(3);
    for (const c of colors) expect(c).toMatch(/^var\(--cg-cluster-\d\)$/);
    expect(layout.nodes.find((n) => n.id === 'lonely1').data.color).toBeNull();
  });
});

// A fan: hub → n0..n11, one rank, so label midpoints sit on one row
function fan(count, weightOf = (i) => count - i) {
  return {
    direction: 'TB',
    nodes: [{ id: 'hub', label: 'Hub' }, ...Array.from({ length: count }, (_, i) => ({ id: `n${i}`, label: `N${i}` }))],
    edges: Array.from({ length: count }, (_, i) => ({ source: 'hub', target: `n${i}`, weight: weightOf(i), label: `${weightOf(i)} calls` })),
  };
}

describe('edge labels', () => {
  it(`shows only the top ${ALWAYS_LABELLED} labels by weight when nothing is active`, () => {
    // Spread edges far apart so collisions cannot interfere with the rule
    const layout = layoutSpec(fan(12));
    layout.edges.forEach((e, i) => Object.assign(e, { labelX: i * 500, labelY: 0 }));
    const { edges } = decorate(layout, { tokens });
    const labelled = edges.filter((e) => e.label).map((e) => e.target);
    expect(labelled).toHaveLength(ALWAYS_LABELLED);
    expect(labelled).toEqual(['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7']); // heaviest first
  });

  it('shows a hidden label when its edge or a connected node is active', () => {
    const layout = layoutSpec(fan(12));
    layout.edges.forEach((e, i) => Object.assign(e, { labelX: i * 500, labelY: 0 }));
    const lightest = layout.edges.find((e) => e.target === 'n11');
    expect(decorate(layout, { tokens }).edges.find((e) => e.id === lightest.id).label).toBeUndefined();
    expect(decorate(layout, { tokens, activeEdgeId: lightest.id }).edges.find((e) => e.id === lightest.id).label).toBe('1 calls');
    expect(decorate(layout, { tokens, activeNodeId: 'n11' }).edges.find((e) => e.id === lightest.id).label).toBe('1 calls');
  });

  it(`never renders two labels within ${LABEL_GAP}px; the lower-weight one is skipped`, () => {
    const edges = [
      { id: 'heavy', label: '9 calls', weight: 9, labelX: 100, labelY: 100 },
      { id: 'light', label: '2 calls', weight: 2, labelX: 100, labelY: 100 + 19 + LABEL_GAP - 1 }, // boxes are 19px tall → 23px gap
      { id: 'far', label: '1 call', weight: 1, labelX: 100, labelY: 100 + 19 + LABEL_GAP + 19 },
    ];
    const all = new Set(edges.map((e) => e.id));
    expect([...pickLabels(edges, all)]).toEqual(['heavy', 'far']);
    // Active edges beat heavier inactive ones
    expect([...pickLabels(edges, all, new Set(['light']))].sort()).toEqual(['light']);
  });

  it('keeps every rendered label at least LABEL_GAP apart in a real layout', () => {
    const layout = layoutSpec(fan(12, () => 5));
    const { edges } = decorate(layout, { tokens, activeNodeId: 'hub' });
    const shown = edges.filter((e) => e.label).map((e) => layout.edges.find((l) => l.id === e.id));
    expect(shown.length).toBeGreaterThan(0);
    const boxes = shown.map((e) => labelBox(e.label, e.labelX, e.labelY));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        expect(Math.max(a.x1 - b.x2, b.x1 - a.x2, a.y1 - b.y2, b.y1 - a.y2)).toBeGreaterThanOrEqual(LABEL_GAP);
      }
    }
  });
});

describe('hover / selection', () => {
  const chain = {
    direction: 'TB',
    nodes: ['a', 'b', 'c', 'd'].map((id) => ({ id, label: id.toUpperCase() })),
    edges: [
      { source: 'a', target: 'b', weight: 4, label: '4 calls' },
      { source: 'b', target: 'c', weight: 1, label: '1 call' },
      { source: 'c', target: 'd', weight: 2, label: '2 calls' },
    ],
  };
  const layout = layoutSpec(chain);

  it('dims nothing when no module is active', () => {
    const { nodes, edges } = decorate(layout, { tokens });
    expect([...nodes, ...edges].some((x) => x.className?.includes('cg-flow-dim'))).toBe(false);
  });

  it("highlights the active module's in/out edges and dims everything else", () => {
    const { nodes, edges } = decorate(layout, { tokens, activeNodeId: 'b' });
    const dimmed = (list) => list.filter((x) => x.className?.includes('cg-flow-dim')).map((x) => x.id);
    expect(dimmed(nodes)).toEqual(['d']); // a, b, c are connected to b
    const byPair = Object.fromEntries(edges.map((e) => [`${e.source}→${e.target}`, e]));
    expect(byPair['c→d'].className).toContain('cg-flow-dim');
    for (const k of ['a→b', 'b→c']) {
      expect(byPair[k].className).toContain('cg-flow-active');
      expect(byPair[k].style.stroke).toBe(tokens.text);
      expect(byPair[k].style.strokeWidth).toBeGreaterThanOrEqual(1.5);
      expect(byPair[k].style.strokeWidth).toBeLessThanOrEqual(2.5);
      expect(byPair[k].markerEnd.color).toBe(tokens.text);
    }
    expect(byPair['a→b'].style.strokeWidth).toBe(2.5); // heaviest
    expect(byPair['b→c'].style.strokeWidth).toBe(1.5); // lightest
    expect(byPair['c→d'].style.stroke).toBe(tokens.borderStrong);
  });

  it('a hovered edge lights its two ends only', () => {
    const cd = layout.edges.find((e) => e.source === 'c').id;
    const { nodes } = decorate(layout, { tokens, activeEdgeId: cd });
    expect(nodes.filter((n) => !n.className).map((n) => n.id)).toEqual(['c', 'd']);
  });
});
