// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

// React Flow needs real layout; the lazy renderer is swapped for a plain list
vi.mock('../diagram/FlowDiagram', () => ({
  default: ({ spec, onNodeClick, ariaLabel }) => (
    <ul aria-label={ariaLabel} data-testid="flow-diagram" data-direction={spec.direction}>
      {spec.nodes.map((n) => (
        <li key={n.id}>
          <button type="button" onClick={() => onNodeClick?.(n)}>
            {n.label}
          </button>
          <span>{n.sublabel}</span>
        </li>
      ))}
    </ul>
  ),
}));

const chatScript = { run: null };
vi.mock('../../api', async () => {
  const actual = await vi.importActual('../../api');
  return {
    ...actual,
    fetchChatSuggestions: vi.fn(async () => []),
    streamChatMessage: vi.fn((repo, sha, msg, history, onToken, onDone, onError, hooks) => {
      chatScript.run({ onToken, onDone, onError, hooks, msg });
      return () => {};
    }),
  };
});

import ChatSidebar from '../ChatSidebar';
import ChatMarkdown, { cleanAnswer, stripDiagram } from '../app/ChatMarkdown';
import { ReferenceChips } from '../app/ChatDiagrams';

beforeAll(() => {
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
});
afterEach(cleanup);

const file = (id) => ({ id, type: 'file' });
const fn = (f, name) => ({ id: `${f}::${name}`, label: name, type: 'function', file: f });
const graph = {
  repo: 'owner/repo',
  commit_sha: 'abc',
  nodes: [
    file('src/app/api/routes.py'),
    file('src/app/db/models.py'),
    file('src/app/node.py'),
    file('scripts/node.py'),
    fn('src/app/api/routes.py', 'index'),
    fn('src/app/api/routes.py', 'login'),
    fn('src/app/db/models.py', 'load'),
    fn('src/app/db/models.py', 'save'),
    fn('src/app/node.py', 'start'),
    fn('scripts/node.py', 'start'),
  ],
  edges: [
    { source: 'src/app/api/routes.py::index', target: 'src/app/db/models.py::load', type: 'calls' },
    { source: 'src/app/api/routes.py::login', target: 'src/app/db/models.py::save', type: 'calls' },
  ],
};

const DIAGRAM_TEXT = 'Login checks the user.\n\n```diagram\n{"nodes":[{"id":"n1","ref":"x"}]}\n```\n\nReferences:\nNODE: src/app/api/routes.py::login';

function send(text) {
  fireEvent.change(screen.getByLabelText('Ask about this codebase'), { target: { value: text } });
  fireEvent.keyDown(screen.getByLabelText('Ask about this codebase'), { key: 'Enter' });
}

describe('diagram block is never shown as text', () => {
  it('removes complete, still-streaming and partially opened blocks, keeping normal code', () => {
    expect(cleanAnswer(DIAGRAM_TEXT)).toBe('Login checks the user.');
    expect(stripDiagram('Prose.\n\n```diagram\n{"nodes":[{"id"')).toBe('Prose.\n\n');
    expect(stripDiagram('Prose.\n``')).toBe('Prose.\n');
    expect(stripDiagram('Prose.\n```dia')).toBe('Prose.\n');
    expect(stripDiagram('Use `foo`')).toBe('Use `foo`');
    const code = 'See:\n```python\nprint(1)\n```';
    expect(stripDiagram(code)).toBe(code);
  });

  it('renders prose without the JSON', () => {
    render(<ChatMarkdown text={DIAGRAM_TEXT} nodeIds={new Set()} onNode={() => {}} />);
    expect(screen.getByText('Login checks the user.')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/"nodes"|```|References/);
  });
});

describe('chat diagram cards', () => {
  it('renders a flow card from the final event and selects nodes from it', async () => {
    chatScript.run = ({ onToken, onDone }) => {
      onToken(DIAGRAM_TEXT.slice(0, 30));
      onToken(DIAGRAM_TEXT.slice(30));
      onDone(['src/app/api/routes.py::login'], {
        diagram: {
          direction: 'LR',
          nodes: [
            { id: 'n1', ref: 'src/app/api/routes.py::login', label: 'Log in' },
            { id: 'n2', ref: 'src/app/db/models.py::save', label: 'Save session' },
          ],
          edges: [{ source: 'n1', target: 'n2' }],
        },
      });
    };
    const onDiagramNodeClick = vi.fn();
    render(<ChatSidebar graph={graph} onNodeSelect={vi.fn()} onDiagramNodeClick={onDiagramNodeClick} />);
    await act(async () => send('What happens when a user logs in?'));

    expect(screen.getByText('Flow · checked against the code graph')).toBeTruthy();
    const diagram = await screen.findByTestId('flow-diagram');
    expect(diagram.getAttribute('data-direction')).toBe('LR');
    expect(within(diagram).getByText('models.py')).toBeTruthy(); // sublabel = file of the ref
    expect(document.body.textContent).not.toMatch(/"ref"|```diagram/);
    expect(screen.queryByText('Architecture · computed from the code graph')).toBeNull();

    fireEvent.click(within(diagram).getByRole('button', { name: 'Save session' }));
    expect(onDiagramNodeClick).toHaveBeenCalledWith(expect.objectContaining({ nodeRef: 'src/app/db/models.py::save' }));
  });

  it('adds the architecture card for architecture questions, without a flow card', async () => {
    chatScript.run = ({ onToken, onDone }) => {
      onToken('The app has an API layer over a database layer.');
      onDone([], { diagram: null });
    };
    render(<ChatSidebar graph={graph} onNodeSelect={vi.fn()} onDiagramNodeClick={vi.fn()} />);
    await act(async () => send('Explain the overall architecture of this project'));

    expect(screen.getByText('Architecture · computed from the code graph')).toBeTruthy();
    const diagram = await screen.findByTestId('flow-diagram');
    expect(within(diagram).getByRole('button', { name: 'api' })).toBeTruthy();
    expect(within(diagram).getByRole('button', { name: 'db' })).toBeTruthy();
    expect(screen.queryByText('Flow · checked against the code graph')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open full screen' })).toBeTruthy();
  });

  it('shows no card for ordinary questions', async () => {
    chatScript.run = ({ onToken, onDone }) => {
      onToken('It loads a model.');
      onDone([], { diagram: null });
    };
    render(<ChatSidebar graph={graph} onNodeSelect={vi.fn()} />);
    await act(async () => send('What does load do?'));
    expect(screen.queryByTestId('flow-diagram')).toBeNull();
  });
});

describe('reference chips', () => {
  it('dedupes, disambiguates colliding labels and caps at 10', () => {
    const ids = [
      'src/app/node.py::start',
      'scripts/node.py::start',
      'src/app/node.py::start', // duplicate
      'src/app/db/models.py::load',
      ...Array.from({ length: 10 }, (_, i) => `m.py::f${i}`),
    ];
    const onSelect = vi.fn();
    render(<ReferenceChips ids={ids} onSelect={onSelect} />);
    const chips = screen.getAllByRole('button');
    expect(chips).toHaveLength(10);
    expect(chips[0].textContent).toBe('start · node.py');
    expect(chips[1].textContent).toBe('start · node.py');
    expect(chips[0].title).toBe('src/app/node.py::start');
    expect(chips[1].title).toBe('scripts/node.py::start');
    expect(chips[2].textContent).toBe('load');
    expect(screen.getByText('+3 more')).toBeTruthy(); // 13 unique ids, 10 shown

    fireEvent.click(chips[1]);
    expect(onSelect).toHaveBeenCalledWith('scripts/node.py::start');
  });
});
