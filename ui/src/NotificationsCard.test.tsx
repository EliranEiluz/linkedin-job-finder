// @vitest-environment jsdom
//
// UI test for NotificationsCard — the thin Crawler-Config-tab wrapper
// around NotificationsConfigPanel. We don't re-test the panel's form
// behaviour here (that's covered by NotificationsConfigPanel.test.tsx).
// What this file pins down is the wrapper-specific contract:
//
//   1. The card's title chrome renders ("NOTIFICATIONS").
//   2. The card mounts the shared panel — which in turn fires the initial
//      /api/notifications/status fetch. If a future refactor accidentally
//      drops the panel mount, this test fails.
//
// jsdom for the same MSW v2 + happy-dom interop reason documented in
// __tests__/msw.ts.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from './__tests__/msw';
import { NotificationsCard } from './NotificationsCard';

beforeAll(() => { server.listen({ onUnhandledRequest: 'error' }); });
afterEach(() => { server.resetHandlers(); });
afterAll(() => { server.close(); });

describe('NotificationsCard', () => {
  it('renders the card chrome and fetches /api/notifications/status on mount', async () => {
    let statusCalled = false;
    server.use(
      http.get('/api/notifications/status', () => {
        statusCalled = true;
        return HttpResponse.json({
          ok: true,
          channels: {
            email: { configured: false, host: '', port: null, user: '', email_to: '', ssl: false },
            telegram: { configured: false, chat_id: '' },
          },
        });
      }),
    );

    render(<NotificationsCard />);

    // Card chrome — the uppercase-tracking title comes from the card
    // wrapper. The shared panel does NOT render its own title.
    expect(screen.getByText('Notifications')).toBeInTheDocument();

    // Channel labels prove the embedded panel mounted.
    expect(screen.getByText('Email')).toBeInTheDocument();
    expect(screen.getByText('Telegram')).toBeInTheDocument();

    await waitFor(() => {
      expect(statusCalled).toBe(true);
    });
  });

  it('shows the Configured badge when /api/notifications/status reports email configured', async () => {
    server.use(
      http.get('/api/notifications/status', () =>
        HttpResponse.json({
          ok: true,
          channels: {
            email: {
              configured: true,
              host: 'smtp.example.com',
              port: 587,
              user: 'alice@example.com',
              email_to: 'alice@example.com',
              ssl: false,
            },
            telegram: { configured: false, chat_id: '' },
          },
        }),
      ),
    );

    render(<NotificationsCard />);

    // Email channel surfaces a Configured badge.
    await waitFor(() => {
      expect(screen.getByText('Configured')).toBeInTheDocument();
    });
  });
});
