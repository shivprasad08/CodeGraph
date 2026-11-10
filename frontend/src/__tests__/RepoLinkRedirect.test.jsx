// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The landing page is replaced by a stub that shows where the router sent us
vi.mock('../views/LandingPageView', () => ({
  default: function LandingStub() {
    const location = useLocation();
    return <p data-testid="landing">{`${location.pathname}${location.search}`}</p>;
  },
}));

import App from '../App';

afterEach(cleanup);

describe('/graph/:owner/:repo', () => {
  it('no longer analyses by URL: redirects to the landing page with the repo prefilled', async () => {
    render(
      <MemoryRouter initialEntries={['/graph/pallets/flask']}>
        <App />
      </MemoryRouter>,
    );
    expect((await screen.findByTestId('landing')).textContent).toBe('/?repo=pallets%2Fflask');
  });
});
