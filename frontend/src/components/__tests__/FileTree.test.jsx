// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import FileTree from '../FileTree';
import { rankNode } from '../app/CommandPalette';

beforeAll(() => {
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
});
afterEach(cleanup);

const graph = {
  nodes: [
    { id: 'pkg/a.py', type: 'file' },
    { id: 'pkg/a.py::run', label: 'run', type: 'function', file: 'pkg/a.py', lines: [3, 9] },
    { id: 'pkg/b.py', type: 'file' },
    { id: 'main.py', type: 'file' },
  ],
  edges: [],
};

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));
const row = (name) => screen.getAllByRole('treeitem').find((el) => el.textContent.startsWith(name));

describe('FileTree keyboard', () => {
  it('moves with arrows, collapses/expands with Left/Right, selects with Enter', async () => {
    const onFileSelect = vi.fn();
    render(<FileTree graph={graph} onFileSelect={onFileSelect} onNodeSelect={vi.fn()} />);
    const tree = screen.getByRole('tree', { name: 'Files' });

    const pkg = row('pkg');
    expect(pkg.getAttribute('aria-expanded')).toBe('true');
    expect(pkg.tabIndex).toBe(0); // roving tabindex starts on the first row
    pkg.focus();

    fireEvent.keyDown(tree, { key: 'ArrowLeft' });
    await flush();
    expect(row('pkg').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('a.py')).toBeNull();

    fireEvent.keyDown(tree, { key: 'ArrowRight' });
    await flush();
    expect(row('pkg').getAttribute('aria-expanded')).toBe('true');

    fireEvent.keyDown(tree, { key: 'ArrowRight' }); // into the first child
    await flush();
    expect(document.activeElement).toBe(row('a.py'));

    fireEvent.keyDown(tree, { key: 'Enter' });
    expect(onFileSelect).toHaveBeenCalledWith('pkg/a.py');

    fireEvent.keyDown(tree, { key: 'ArrowLeft' }); // file → parent folder
    await flush();
    expect(document.activeElement).toBe(row('pkg'));

    fireEvent.keyDown(tree, { key: 'End' });
    await flush();
    expect(document.activeElement).toBe(row('main.py'));
  });

  it('lists the selected file’s functions and marks the selected one', () => {
    render(<FileTree graph={graph} onFileSelect={vi.fn()} onNodeSelect={vi.fn()} selectedFilePath="pkg/a.py" selectedNodeId="pkg/a.py::run" />);
    const fn = row('run');
    expect(fn.getAttribute('aria-selected')).toBe('true');
    expect(row('a.py').getAttribute('aria-expanded')).toBe('true');
  });

  it('filters files by path', () => {
    render(<FileTree graph={graph} onFileSelect={vi.fn()} onNodeSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Filter files' }));
    fireEvent.change(screen.getByLabelText('Filter files'), { target: { value: 'b.py' } });
    const names = screen.getAllByRole('treeitem').map((el) => el.textContent);
    expect(names).toEqual(['pkg', 'b.py']);
  });
});

describe('command palette ranking', () => {
  it('prefers name prefix, then name contains, then path; rejects scattered letters', () => {
    expect(rankNode('x', 'rep', ['repair_now', 'src/node.py'])).toBe(1);
    expect(rankNode('x', 'pair', ['repair_now', 'src/node.py'])).toBe(0.8);
    expect(rankNode('x', 'node.py', ['repair_now', 'src/node.py'])).toBe(0.5);
    expect(rankNode('x', 'rpnw', ['repair_now', 'src/node.py'])).toBe(0);
  });
});
