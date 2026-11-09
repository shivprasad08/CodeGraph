// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Search } from 'lucide-react';
import { Button, IconButton, Input, Tabs, TabsContent, TabsList, TabsTrigger } from '..';

afterEach(cleanup);

describe('IconButton', () => {
  it('uses the label prop as its accessible name', () => {
    render(
      <IconButton label="Search nodes" shortcut="/">
        <Search aria-hidden="true" />
      </IconButton>,
    );
    const button = screen.getByRole('button', { name: 'Search nodes' });
    expect(button.getAttribute('aria-label')).toBe('Search nodes');
  });
});

describe('Button', () => {
  it('sets aria-busy and blocks clicks while loading', async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Analyze repo
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Analyze repo' });
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.disabled).toBe(true);

    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('clicks normally when not loading', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Analyze repo</Button>);
    const button = screen.getByRole('button', { name: 'Analyze repo' });
    expect(button.hasAttribute('aria-busy')).toBe(false);

    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('Input', () => {
  it('links hint and error text with aria-describedby and sets aria-invalid', () => {
    render(<Input label="Repository" hint="owner/repo" error="Enter a repository as owner/name." />);
    const input = screen.getByLabelText('Repository');
    const describedBy = input.getAttribute('aria-describedby').split(' ');

    const error = screen.getByText('Enter a repository as owner/name.');
    const hint = screen.getByText('owner/repo');
    expect(describedBy).toContain(error.id);
    expect(describedBy).toContain(hint.id);
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('has no aria-describedby or aria-invalid without hint or error', () => {
    render(<Input label="Repository" />);
    const input = screen.getByLabelText('Repository');
    expect(input.hasAttribute('aria-describedby')).toBe(false);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
  });
});

describe('Tabs', () => {
  it('switches tabs with the arrow keys', async () => {
    const user = userEvent.setup();
    render(
      <Tabs defaultValue="summary">
        <TabsList aria-label="Node details">
          <TabsTrigger value="summary">Summary</TabsTrigger>
          <TabsTrigger value="source">Source</TabsTrigger>
          <TabsTrigger value="impact">Impact</TabsTrigger>
        </TabsList>
        <TabsContent value="summary">Summary panel</TabsContent>
        <TabsContent value="source">Source panel</TabsContent>
        <TabsContent value="impact">Impact panel</TabsContent>
      </Tabs>,
    );
    const summary = screen.getByRole('tab', { name: 'Summary' });
    const source = screen.getByRole('tab', { name: 'Source' });
    expect(summary.getAttribute('aria-selected')).toBe('true');

    await user.click(summary);
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(source);
    expect(source.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').textContent).toBe('Source panel');

    await user.keyboard('{ArrowLeft}');
    expect(summary.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').textContent).toBe('Summary panel');
  });
});
