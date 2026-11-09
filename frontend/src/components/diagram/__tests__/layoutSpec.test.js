import { describe, expect, it } from 'vitest';
import { layoutSpec } from '../FlowDiagram';

const tokens = { borderStrong: '#555', canvas: '#000', secondary: '#aaa', tertiary: '#888' };
const spec = {
  direction: 'TB',
  nodes: [
    { id: 'a', label: 'A', sublabel: '1 file · 2 functions', members: ['x.py'] },
    { id: 'b', label: 'B' },
    { id: 'c', label: 'C' },
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
  const out = layoutSpec(spec, { tokens });
  const pos = Object.fromEntries(out.nodes.map((n) => [n.id, n.position]));

  it('lays linked nodes out top-to-bottom and puts unlinked ones in a grid below', () => {
    expect(pos.a.y).toBeLessThan(pos.b.y);
    expect(pos.b.y).toBeLessThan(pos.c.y);
    expect(pos.lonely1.y).toBeGreaterThan(pos.c.y);
    expect(pos.lonely1.y).toBe(pos.lonely2.y); // same grid row
  });

  it('drops self-loops and edges to unknown nodes; scales width 1–2.5px with weight', () => {
    expect(out.edges.map((e) => `${e.source}→${e.target}`)).toEqual(['a→b', 'b→c']);
    const width = Object.fromEntries(out.edges.map((e) => [`${e.source}→${e.target}`, e.style.strokeWidth]));
    expect(width['a→b']).toBe(2.5);
    expect(width['b→c']).toBe(1);
    expect(out.edges[0].type).toBe('smoothstep');
    expect(out.edges[0].label).toBe('10 calls');
  });

  it('frames only the linked part for the first fit and marks clickable nodes', () => {
    expect(out.focusBox.y2).toBeLessThan(pos.lonely1.y);
    expect(out.nodes.find((n) => n.id === 'a').data.clickable).toBe(true);
    expect(out.nodes.find((n) => n.id === 'b').data.clickable).toBe(false);
    expect(out.nodes.find((n) => n.id === 'a').ariaLabel).toBe('A, 1 file · 2 functions');
  });
});
