// @vitest-environment jsdom
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import Hero, { COLD_START_DELAY_MS } from '../Hero';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setup(onAnalyze = vi.fn(() => Promise.resolve())) {
  const inputRef = createRef();
  render(<Hero onAnalyze={onAnalyze} inputRef={inputRef} />);
  return {
    onAnalyze,
    input: screen.getByLabelText('GitHub repository'),
    button: screen.getByRole('button', { name: /Analyze repo/ }),
  };
}

describe('Hero', () => {
  it('strips a pasted github.com URL prefix as you type', () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: 'https://github.com/pallets/flask' } });
    expect(input.value).toBe('pallets/flask');
  });

  it.each([
    ['owner/repo', 'owner/repo'],
    ['https://github.com/pallets/flask', 'pallets/flask'],
    ['https://github.com/fastapi/fastapi.git', 'fastapi/fastapi'],
  ])('submits %s as %s when Enter is pressed', async (typed, expected) => {
    const { input, onAnalyze } = setup();
    fireEvent.change(input, { target: { value: typed } });
    await act(async () => {
      fireEvent.submit(input.closest('form')); // what Enter in the field does
    });
    expect(onAnalyze).toHaveBeenCalledWith(expected);
  });

  it('example link fills the input and focuses it', () => {
    const { input } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'encode/starlette' }));
    expect(input.value).toBe('encode/starlette');
    expect(document.activeElement).toBe(input);
  });

  it('shows an inline error linked to the field for an invalid repo, without calling onAnalyze', async () => {
    const { input, onAnalyze } = setup();
    fireEvent.change(input, { target: { value: 'not a repo' } });
    await act(async () => {
      fireEvent.submit(input.closest('form'));
    });
    expect(onAnalyze).not.toHaveBeenCalled();
    const error = screen.getByText(/Enter a repository as owner\/repo/);
    expect(input.getAttribute('aria-describedby')).toContain(error.id);
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('disables the button with aria-busy while submitting, then shows the cold-start note after 4s', async () => {
    vi.useFakeTimers();
    let resolve;
    const { input, button } = setup(vi.fn(() => new Promise((r) => (resolve = r))));
    fireEvent.change(input, { target: { value: 'psf/requests' } });
    await act(async () => {
      fireEvent.submit(input.closest('form'));
    });

    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText(/Waking up the server/)).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(COLD_START_DELAY_MS - 1);
    });
    expect(screen.queryByText(/Waking up the server/)).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText('Waking up the server — the first request can take up to a minute.')).toBeTruthy();

    await act(async () => resolve());
    expect(button.disabled).toBe(false);
    expect(screen.queryByText(/Waking up the server/)).toBeNull();
  });

  it('shows the server error with a next step when the request fails', async () => {
    const { input } = setup(vi.fn(() => Promise.reject(new Error('Repository has more than 60 Python files'))));
    fireEvent.change(input, { target: { value: 'psf/requests' } });
    await act(async () => {
      fireEvent.submit(input.closest('form'));
    });
    expect(screen.getByText(/Repository has more than 60 Python files.*Try again in a minute/)).toBeTruthy();
  });

  it('shows the rate-limit message as the server words it (it already says when to retry)', async () => {
    const limited = Object.assign(new Error("You've started 10 analyses in the last hour. Try again in 37 minutes."), { code: 'rate_limited' });
    const { input } = setup(vi.fn(() => Promise.reject(limited)));
    fireEvent.change(input, { target: { value: 'psf/requests' } });
    await act(async () => {
      fireEvent.submit(input.closest('form'));
    });
    expect(screen.getByText("You've started 10 analyses in the last hour. Try again in 37 minutes.")).toBeTruthy();
    expect(screen.queryByText(/Couldn't start the analysis/)).toBeNull();
  });

  it('prefills the repository from a shared link', () => {
    render(<Hero onAnalyze={vi.fn()} initialRepo="pallets/flask" />);
    expect(screen.getByLabelText('GitHub repository').value).toBe('pallets/flask');
  });
});
