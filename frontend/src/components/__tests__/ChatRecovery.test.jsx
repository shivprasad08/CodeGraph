// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const chatScript = { run: null };
vi.mock('../../api', async () => {
  const actual = await vi.importActual('../../api');
  return {
    ...actual,
    fetchChatSuggestions: vi.fn(async () => []),
    // Each test scripts what the stream does via chatScript.run
    streamChatMessage: vi.fn((repo, sha, msg, history, onToken, onDone, onError, hooks) => {
      chatScript.run({ onToken, onDone, onError, hooks });
      return () => {};
    }),
  };
});

import { API_ERROR, ApiError } from '../../api';
import ChatSidebar from '../ChatSidebar';

beforeAll(() => {
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
});
afterEach(cleanup);

const graph = { repo: 'owner/repo', commit_sha: 'abc', nodes: [], edges: [] };

function send(text = 'Where does it start?') {
  fireEvent.change(screen.getByLabelText('Ask about this codebase'), { target: { value: text } });
  fireEvent.keyDown(screen.getByLabelText('Ask about this codebase'), { key: 'Enter' });
}

describe('chat recovery UI', () => {
  it('keeps the question, shows the reload status, then the retried answer', async () => {
    let finish;
    chatScript.run = ({ onToken, onDone, hooks }) => {
      hooks.onRecovering();
      finish = () => {
        hooks.onRecovered({ commitSha: 'abc', changed: false, jobId: 'j1' });
        onToken('It starts in main.');
        onDone([]);
      };
    };
    render(<ChatSidebar graph={graph} onNodeSelect={vi.fn()} />);
    await act(async () => send());

    expect(screen.getByText('Where does it start?')).toBeTruthy(); // user message stays
    expect(screen.getByText('Reloading this analysis on the server…')).toBeTruthy();

    await act(async () => finish());
    expect(screen.getByText('It starts in main.')).toBeTruthy();
    expect(screen.queryByText(/repository changed/)).toBeNull();
  });

  it('second failure: friendly error with a working "Re-run analysis" button', async () => {
    chatScript.run = ({ onError, hooks }) => {
      hooks.onRecovering();
      const err = new ApiError(API_ERROR.CACHE_MISS, "This analysis is no longer on the server and couldn't be reloaded.");
      onError(err.message, err);
    };
    const onRerun = vi.fn();
    render(<ChatSidebar graph={graph} onNodeSelect={vi.fn()} onRerun={onRerun} />);
    await act(async () => send());

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain("This analysis is no longer on the server and couldn't be reloaded.");
    expect(alert.textContent).not.toMatch(/Graph data|not found in cache/);
    expect(screen.getByText('Where does it start?')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Re-run analysis' }));
    expect(onRerun).toHaveBeenCalledTimes(1);
  });

  it('other errors: friendly message without the re-run button', async () => {
    chatScript.run = ({ onError }) => {
      const err = new ApiError(API_ERROR.RATE_LIMITED, 'Too many requests right now. Try again in a minute.');
      onError(err.message, err);
    };
    render(<ChatSidebar graph={graph} onNodeSelect={vi.fn()} onRerun={vi.fn()} />);
    await act(async () => send());
    expect(screen.getByRole('alert').textContent).toContain('Too many requests right now.');
    expect(screen.queryByRole('button', { name: 'Re-run analysis' })).toBeNull();
  });

  it('commit changed: one line with "Reload graph"', async () => {
    chatScript.run = ({ onToken, onDone, hooks }) => {
      hooks.onRecovering();
      hooks.onRecovered({ commitSha: 'new', changed: true, jobId: 'job-9' });
      onToken('Fresh answer.');
      onDone([]);
    };
    const onReloadGraph = vi.fn();
    render(<ChatSidebar graph={graph} onNodeSelect={vi.fn()} onReloadGraph={onReloadGraph} />);
    await act(async () => send());

    expect(screen.getByText('The repository changed since this analysis — showing answers for the latest commit.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reload graph' }));
    expect(onReloadGraph).toHaveBeenCalledWith('job-9');
  });
});
