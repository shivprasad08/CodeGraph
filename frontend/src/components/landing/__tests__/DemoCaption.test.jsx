// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { DemoCaption } from '../LiveDemo';
import { graphStats } from '../../../lib/graphStats';

afterEach(cleanup);

// jsdom tests run with cwd = frontend/ (import.meta.url is not a file: URL here)
const demo = JSON.parse(readFileSync(resolve(process.cwd(), 'public/demo/mini_redis.json'), 'utf8'));

describe('demo caption', () => {
  it('computes the numbers from the saved graph JSON', () => {
    const expected = graphStats(demo);
    expect(expected).toEqual({
      name: 'mini_redis',
      files: demo.nodes.filter((n) => n.type === 'file').length,
      nodes: demo.nodes.length,
      edges: demo.edges.length,
    });
    const { container } = render(<DemoCaption graph={demo} />);
    expect(container.textContent).toBe(
      `mini_redis · ${expected.files} files · ${expected.nodes.toLocaleString('en-US')} nodes · ${expected.edges.toLocaleString('en-US')} edges`,
    );
  });

  it('is not hardcoded: a different graph gives different numbers', () => {
    const graph = {
      repo: 'acme/tiny',
      nodes: [
        { id: 'a.py', type: 'file' },
        { id: 'a.py::f', type: 'function' },
        { id: 'a.py::g', type: 'function' },
      ],
      edges: [{ source: 'a.py', target: 'a.py::f' }],
    };
    const { container } = render(<DemoCaption graph={graph} />);
    expect(container.textContent).toBe('tiny · 1 files · 3 nodes · 1 edges');
  });
});
