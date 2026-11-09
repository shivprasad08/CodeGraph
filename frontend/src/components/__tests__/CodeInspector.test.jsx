// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../api', async (orig) => ({
  ...(await orig()),
  fetchFileSource: vi.fn(async () => ({
    content: ['class A:', '    def get(self):', '        pass', '', 'class B:', '    def get(self):', '        pass', ''].join('\n'),
  })),
}));

import CodeInspector from '../CodeInspector';

const graph = {
  nodes: [
    { id: 'm.py', type: 'file', label: 'm.py', file: 'm.py' },
    { id: 'm.py::A', type: 'class', label: 'A', file: 'm.py', lines: [1, 3] },
    { id: 'm.py::A.get', type: 'function', label: 'get', file: 'm.py', lines: [2, 3] },
    { id: 'm.py::B', type: 'class', label: 'B', file: 'm.py', lines: [5, 7] },
    { id: 'm.py::B.get', type: 'function', label: 'get', file: 'm.py', lines: [6, 7] },
  ],
  edges: [],
};

describe('CodeInspector', () => {
  it('links each same-named method definition to its own node', async () => {
    const { container } = render(
      <CodeInspector filePath="m.py" graph={graph} repo="o/r" commitSha="abc" onClose={() => {}} onNodeClick={() => {}} />,
    );
    await waitFor(() => expect(container.querySelectorAll('.codegraph-fn-link').length).toBeGreaterThanOrEqual(4));
    const getLinks = [...container.querySelectorAll('.codegraph-fn-link')].filter((el) => el.textContent === 'get');
    expect(getLinks.map((el) => el.dataset.id)).toEqual(['m.py::A.get', 'm.py::B.get']);
    expect(screen.getAllByText('get')).toHaveLength(2);
  });
});
