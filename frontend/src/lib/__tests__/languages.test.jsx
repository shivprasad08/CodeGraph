// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { langOf, languageBreakdown, languageName, languageTag } from '../languages';
import { LanguageBar } from '../../components/HealthPanel';
import FileTree from '../../components/FileTree';

afterEach(cleanup);

describe('languages', () => {
  it('reads lang from the node, else from the extension (older graphs)', () => {
    expect(langOf({ id: 'a.ts', lang: 'typescript' })).toBe('typescript');
    expect(langOf({ id: 'src/x.py', type: 'file' })).toBe('python');
    expect(langOf({ id: 'src/a.go::main', file: 'src/a.go' })).toBe('go');
    expect(langOf({ id: 'README' })).toBeNull();
    expect([languageName('csharp'), languageTag('rust')]).toEqual(['C#', 'RS']);
  });

  it('breaks the repo down by lines of code, or by files when loc is missing', () => {
    const rows = languageBreakdown({
      languages: [
        { lang: 'javascript', label: 'JavaScript', files: 20, loc: 3000 },
        { lang: 'python', label: 'Python', files: 2, loc: 1000 },
      ],
    });
    expect(rows.map((r) => [r.name, r.share])).toEqual([['JavaScript', 0.75], ['Python', 0.25]]);
    const old = languageBreakdown({ nodes: [{ id: 'a.py', type: 'file' }, { id: 'b.py', type: 'file' }, { id: 'c.js', type: 'file' }] });
    expect(old.map((r) => [r.lang, r.files])).toEqual([['python', 2], ['javascript', 1]]);
  });

  it('Health shows a labelled language bar', () => {
    render(<LanguageBar graph={{ languages: [{ lang: 'go', label: 'Go', files: 3, loc: 299 }, { lang: 'rust', label: 'Rust', files: 1, loc: 1 }] }} />);
    expect(screen.getByRole('img', { name: 'Go 100%, Rust <1%' })).toBeTruthy();
    expect(screen.getByText('Languages')).toBeTruthy();
  });

  it('file rows carry a visual-only language tag', () => {
    const graph = { nodes: [{ id: 'src/app.ts', type: 'file', file: 'src/app.ts', lang: 'typescript' }], edges: [] };
    const { container } = render(<FileTree graph={graph} onFileSelect={vi.fn()} onNodeSelect={vi.fn()} />);
    const tag = container.querySelector('[data-tag]');
    expect(tag.dataset.tag).toBe('TS');
    expect(tag.getAttribute('aria-hidden')).toBe('true');
  });
});
