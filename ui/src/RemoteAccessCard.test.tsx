// @vitest-environment jsdom
//
// UI test for RemoteAccessCard — covers the three states the panel
// renders against /api/remote-access/status:
//
//   1. loading shimmer (no fetch resolved yet)
//   2. both CLIs installed + tailscale running → URL + HEALTHY tunnel
//   3. neither CLI installed → "Not installed" badges + caveats still visible
//
// Caveat assertions are the load-bearing part — the brief calls them out
// as "always visible, not buried in setup steps" so a future refactor
// that accidentally tucks them inside the <details> block must fail this
// test.
//
// jsdom (not happy-dom) because the card calls `res.json()` and happy-dom
// 15.x has a known interop bug with MSW v2's response stream — see
// __tests__/msw.ts for the bug threads.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { http, HttpResponse, delay } from 'msw';
import { server } from './__tests__/msw';
import { RemoteAccessCard, type RemoteAccessStatus } from './RemoteAccessCard';

beforeAll(() => { server.listen({ onUnhandledRequest: 'error' }); });
afterEach(() => { server.resetHandlers(); });
afterAll(() => { server.close(); });

const happyStatus: RemoteAccessStatus = {
  ok: true,
  tailscale: {
    installed: true,
    running: true,
    hostname: 'eliran-mac.tail-scale.ts.net',
    ipv4: '100.64.1.2',
    url: 'http://eliran-mac.tail-scale.ts.net:5173',
  },
  cloudflare: {
    installed: true,
    tunnels: [{ name: 'linkedin-jobs', status: 'HEALTHY' }],
  },
  vite_host_binding: {
    all_interfaces: true,
    note: 'ui/package.json `dev` script includes --host',
  },
};

const noneInstalledStatus: RemoteAccessStatus = {
  ok: true,
  tailscale: { installed: false },
  cloudflare: { installed: false },
  vite_host_binding: {
    all_interfaces: false,
    note: 'ui/package.json `dev` script does NOT include --host',
  },
};

describe('RemoteAccessCard', () => {
  it('shows a loading shimmer while the fetch is pending', () => {
    server.use(
      http.get('/api/remote-access/status', async () => {
        // Hold the response open so the loading branch stays mounted.
        await delay(2_000);
        return HttpResponse.json(happyStatus);
      }),
    );
    render(<RemoteAccessCard />);
    // Title + a refresh button render immediately.
    expect(screen.getByText('Access from anywhere')).toBeInTheDocument();
    // The two pulsing skeleton bars carry no text — assert by class.
    const shimmer = document.querySelectorAll('.animate-pulse');
    expect(shimmer.length).toBeGreaterThan(0);
  });

  it('renders the URL + tunnel chip when both CLIs are installed and running', async () => {
    server.use(
      http.get('/api/remote-access/status', () => HttpResponse.json(happyStatus)),
    );
    render(<RemoteAccessCard />);

    // Tailscale URL surfaces as a code block.
    await waitFor(() => {
      expect(
        screen.getByText('http://eliran-mac.tail-scale.ts.net:5173'),
      ).toBeInTheDocument();
    });

    // Status chips: "Running" for tailscale, "1 of 1 HEALTHY" for cloudflared.
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('1 of 1 HEALTHY')).toBeInTheDocument();

    // Tunnel chip mentions the tunnel name and its HEALTHY status.
    expect(screen.getByText(/linkedin-jobs \(HEALTHY\)/)).toBeInTheDocument();

    // Caveats are visible (not gated behind <details>). The assertion is
    // load-bearing — the brief calls them out as always visible. Each
    // section's caveat strings include a unique phrase we can match on.
    expect(
      screen.getByText(/Mac must be awake\. A sleeping Mac means your phone/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/dashboard ships zero local auth/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Cloudflare terminates TLS at the edge/),
    ).toBeInTheDocument();
  });

  it('shows "Not installed" badges and caveats when neither CLI is present', async () => {
    server.use(
      http.get('/api/remote-access/status', () =>
        HttpResponse.json(noneInstalledStatus),
      ),
    );
    render(<RemoteAccessCard />);

    // Both sections show the "Not installed" chip — there are exactly two.
    await waitFor(() => {
      expect(screen.getAllByText('Not installed')).toHaveLength(2);
    });

    // The Vite-bind warning surfaces as an amber callout when
    // all_interfaces=false (otherwise hidden).
    expect(
      screen.getByText('Vite is bound to localhost only'),
    ).toBeInTheDocument();

    // Caveats remain visible even with nothing installed — they're a
    // permanent part of the card, not gated on a particular state.
    expect(
      screen.getByText(/Mac must be awake\. A sleeping Mac means your phone/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/dashboard ships zero local auth/),
    ).toBeInTheDocument();

    // "Learn more →" link points at the public docs URL. Two such links
    // exist (one per sub-card); the first is the Tailscale section's.
    const learnMore = screen.getAllByText('Learn more →');
    expect(learnMore.length).toBeGreaterThan(0);
    const firstLink = learnMore[0];
    if (!firstLink) throw new Error('expected a Learn more link');
    expect(firstLink.closest('a')).toHaveAttribute(
      'href',
      'https://github.com/EliranEiluz/linkedin-job-finder/blob/main/docs/remote-access.md',
    );
  });

  it('renders an error banner when the API returns non-200', async () => {
    server.use(
      http.get('/api/remote-access/status', () =>
        HttpResponse.json({ ok: false, error: 'spawn failed' }, { status: 500 }),
      ),
    );
    render(<RemoteAccessCard />);
    // The component triggers a >=500ms artificial delay on first load
    // (LOADING_MIN_MS); flush timers so the error state renders inside
    // act() to avoid the React act-warning + timeout flake.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    await waitFor(() => {
      expect(
        screen.getByText('Could not read remote-access status'),
      ).toBeInTheDocument();
    });
  });
});
