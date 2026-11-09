// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ArchitectureView from '../app/ArchitectureView';

afterEach(cleanup);

describe('ArchitectureView', () => {
  it('offers a re-run when the graph has no architecture yet', () => {
    const onRerun = vi.fn();
    render(<ArchitectureView graph={{ nodes: [], edges: [] }} onRerun={onRerun} />);
    expect(screen.getByRole('heading', { name: 'Re-run analysis to see the architecture view' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Re-run analysis' }));
    expect(onRerun).toHaveBeenCalledTimes(1);
  });

  it('disables the button while a re-run is in progress', () => {
    render(<ArchitectureView graph={{ nodes: [], edges: [] }} onRerun={vi.fn()} rerunning />);
    expect(screen.getByRole('button', { name: 'Re-run analysis' }).disabled).toBe(true);
  });
});
