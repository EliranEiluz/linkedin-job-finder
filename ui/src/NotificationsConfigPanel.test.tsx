// @vitest-environment jsdom
//
// UI tests for NotificationsConfigPanel — the shared notifications form
// rendered by both the onboarding wizard's Step 6 and the post-onboarding
// Crawler Config "Notifications" card.
//
// Load-bearing behaviours we verify:
//   1. /api/notifications/status is fetched on mount and the "Configured"
//      badge appears for whichever channel the backend reports configured.
//   2. SMTP password and Telegram bot_token inputs render EMPTY after the
//      status load, even when the channel is configured — the backend
//      already redacts, but the input must not display anything either.
//   3. The Email "Save" button POSTs the SMTP payload to save-smtp.
//   4. The Email "Test connection" button POSTs save-smtp followed by
//      test-smtp (save must come first because test-smtp reads from disk).
//   5. Same wiring for the Telegram channel.
//
// jsdom (not happy-dom) because we call `res.json()` — see
// __tests__/msw.ts for the bug threads.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse, type JsonBodyType } from 'msw';
import { server } from './__tests__/msw';
import { NotificationsConfigPanel } from './NotificationsConfigPanel';

beforeAll(() => { server.listen({ onUnhandledRequest: 'error' }); });
afterEach(() => { server.resetHandlers(); });
afterAll(() => { server.close(); });

// Mount the panel and resolve the initial /status fetch before returning.
// `statusResponse` controls what the mock backend reports for that load.
const mountWithStatus = async (
  statusResponse: JsonBodyType,
): Promise<void> => {
  server.use(
    http.get('/api/notifications/status', () =>
      HttpResponse.json(statusResponse),
    ),
  );
  render(<NotificationsConfigPanel />);
  // Give the panel's mount-effect a tick to resolve so the status-driven
  // state is committed before tests inspect the DOM.
  await waitFor(() => {
    // The Email and Telegram channel labels always render — we use them
    // as a "first paint complete" sentinel rather than a state assertion.
    expect(screen.getByText('Email')).toBeInTheDocument();
    expect(screen.getByText('Telegram')).toBeInTheDocument();
  });
};

describe('NotificationsConfigPanel', () => {
  it('fetches /api/notifications/status on mount and shows neither channel as configured when both are blank', async () => {
    let statusCalled = false;
    server.use(
      http.get('/api/notifications/status', () => {
        statusCalled = true;
        return HttpResponse.json({
          ok: true,
          channels: {
            email: {
              configured: false,
              host: '',
              port: null,
              user: '',
              email_to: '',
              ssl: false,
            },
            telegram: { configured: false, chat_id: '' },
          },
        });
      }),
    );
    render(<NotificationsConfigPanel />);
    await waitFor(() => {
      expect(statusCalled).toBe(true);
    });
    // No "Configured" badges render when neither channel is set up.
    expect(screen.queryByText('Configured')).not.toBeInTheDocument();
  });

  it('renders the Configured badge for whichever channels the backend reports configured', async () => {
    await mountWithStatus({
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
        telegram: { configured: true, chat_id: '123456789' },
      },
    });

    // Both channels render a Configured badge (one per channel = 2 total).
    await waitFor(() => {
      expect(screen.getAllByText('Configured')).toHaveLength(2);
    });
  });

  it('renders password + bot_token inputs EMPTY after status load even when the channel is configured', async () => {
    await mountWithStatus({
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
        telegram: { configured: true, chat_id: '123456789' },
      },
    });

    // When configured, the channels are auto-enabled and the secret inputs
    // expand into view. Both must be empty even though /status reports
    // configured — the backend redacts the secrets and the panel never
    // round-trips them into a typed value. The two secret inputs share
    // the same "(saved — leave blank to keep)" placeholder (one per
    // channel) — we assert both render with empty values via the
    // type=password selector, which is unambiguous (only the two secret
    // inputs use it).
    await waitFor(() => {
      const secretInputs = document.querySelectorAll('input[type="password"]');
      expect(secretInputs).toHaveLength(2);
    });
    const secretInputs = document.querySelectorAll('input[type="password"]');
    for (const el of secretInputs) {
      expect((el as HTMLInputElement).value).toBe('');
    }
  });

  it('posts save-smtp when the user clicks the Email Save button', async () => {
    let savedBody: unknown = null;
    await mountWithStatus({
      ok: true,
      channels: {
        email: {
          configured: false,
          host: '',
          port: null,
          user: '',
          email_to: '',
          ssl: false,
        },
        telegram: { configured: false, chat_id: '' },
      },
    });
    server.use(
      http.post('/api/notifications/save-smtp', async ({ request }) => {
        savedBody = await request.json();
        return HttpResponse.json({ ok: true, vars_written: [] });
      }),
    );

    const user = userEvent.setup();
    // Enable the email channel (un-checked initially since not configured).
    // Both channels render labels-wrapping-checkboxes — we can't use
    // getByLabelText('Email') because that substring also matches the
    // Telegram description ("no email account needed"). Grab the channel
    // checkboxes by role and pick the first; Email is rendered first.
    //
    // Use fireEvent.click rather than userEvent.click — the input sits
    // inside a clickable <label>, and userEvent's synthetic pointer
    // pipeline can fire the label's implicit click on top of the input
    // click, toggling the checkbox twice and back to false. fireEvent
    // dispatches the bare change event on the input.
    const checkboxes = screen.getAllByRole('checkbox');
    const emailCheckbox = checkboxes[0];
    if (!emailCheckbox) throw new Error('expected an Email checkbox');
    act(() => {
      fireEvent.click(emailCheckbox);
    });

    // Wait for the email form to expand, then fill it in. The form
    // labels aren't programmatically wired to their inputs (no htmlFor),
    // and the Username + Recipient fields share placeholder
    // "you@example.com" when Username is empty (Recipient defaults to
    // user). Grab them as a pair and use the first (Username, rendered
    // earlier). Password's placeholder differs by configured-state
    // (here: not-configured -> "paste app password…").
    const userFields = await screen.findAllByPlaceholderText('you@example.com');
    const userField = userFields[0];
    if (!userField) throw new Error('expected a Username field');
    await user.type(userField, 'alice@example.com');
    const passwordField = screen.getByPlaceholderText('paste app password…');
    await user.type(passwordField, 'app-password-xyz');

    const saveButton = screen.getByRole('button', { name: /^Save$/ });
    await user.click(saveButton);

    await waitFor(() => {
      expect(savedBody).not.toBeNull();
    });
    expect(savedBody).toMatchObject({
      host: 'smtp.gmail.com',
      port: 587,
      user: 'alice@example.com',
      password: 'app-password-xyz',
    });
  });

  it('chains save-smtp → test-smtp when the user clicks "Test connection"', async () => {
    const calls: string[] = [];
    await mountWithStatus({
      ok: true,
      channels: {
        email: {
          configured: true,
          host: 'smtp.gmail.com',
          port: 587,
          user: 'alice@example.com',
          email_to: 'alice@example.com',
          ssl: false,
        },
        telegram: { configured: false, chat_id: '' },
      },
    });
    server.use(
      http.post('/api/notifications/save-smtp', () => {
        calls.push('save-smtp');
        return HttpResponse.json({ ok: true, vars_written: [] });
      }),
      http.post('/api/notifications/test-smtp', () => {
        calls.push('test-smtp');
        return HttpResponse.json({ ok: true, message: 'Sent test email' });
      }),
    );

    const user = userEvent.setup();
    // Email auto-enables when status reports configured, so the form is
    // already expanded. Empty-password fallback is allowed here because
    // emailConfigured is true.
    const testButton = screen.getAllByRole('button', {
      name: /Test connection/,
    })[0];
    if (!testButton) throw new Error('expected a Test connection button');
    await user.click(testButton);

    await waitFor(() => {
      expect(calls).toEqual(['save-smtp', 'test-smtp']);
    });
    // Success banner.
    expect(await screen.findByText('Sent test email')).toBeInTheDocument();
  });

  it('chains save-telegram → test-telegram when the user clicks the Telegram Test button', async () => {
    const calls: string[] = [];
    await mountWithStatus({
      ok: true,
      channels: {
        email: { configured: false, host: '', port: null, user: '', email_to: '', ssl: false },
        telegram: { configured: true, chat_id: '987654321' },
      },
    });
    server.use(
      http.post('/api/notifications/save-telegram', () => {
        calls.push('save-telegram');
        return HttpResponse.json({ ok: true, vars_written: [] });
      }),
      http.post('/api/notifications/test-telegram', () => {
        calls.push('test-telegram');
        return HttpResponse.json({ ok: true, message: 'Telegram message sent' });
      }),
    );

    const user = userEvent.setup();
    // Telegram auto-expanded because the backend reports configured.
    const testButtons = screen.getAllByRole('button', {
      name: /Test connection/,
    });
    // Two Test connection buttons render — one per channel; the second is
    // Telegram (email was reported as not-configured so its form stays
    // collapsed, but Test connection still renders inside it only if the
    // channel is enabled). Here email is OFF, so only one button should
    // be visible.
    expect(testButtons.length).toBe(1);
    const telegramTestButton = testButtons[0];
    if (!telegramTestButton) throw new Error('expected a Test connection button');
    await user.click(telegramTestButton);

    await waitFor(() => {
      expect(calls).toEqual(['save-telegram', 'test-telegram']);
    });
    expect(await screen.findByText('Telegram message sent')).toBeInTheDocument();
  });

  it('decouples enable-toggle from form visibility (un-ticking Enable does NOT collapse)', async () => {
    // #117: previously the only way to hide the SMTP/Telegram form was
    // to un-tick "Enable email channel" — semantic disable conflated
    // with visual collapse. Now the checkbox sets enabled/disabled and
    // the form stays on screen as long as the user wants. The form is
    // gated on `emailExpanded`, not `emailEnabled`.
    await mountWithStatus({
      ok: true,
      channels: {
        email: {
          configured: true,
          host: 'smtp.gmail.com',
          port: 587,
          user: 'alice@example.com',
          email_to: 'alice@example.com',
          ssl: false,
        },
        telegram: { configured: false, chat_id: '' },
      },
    });
    // Configured email auto-expands AND auto-enables. The form body's
    // "App password" input is the canary that the form is mounted.
    await waitFor(() => {
      expect(
        screen.getByPlaceholderText('(saved — leave blank to keep)'),
      ).toBeInTheDocument();
    });
    // Un-tick the "Enable email channel" checkbox.
    const enableCheckbox = screen.getByLabelText('Enable email channel');
    expect((enableCheckbox as HTMLInputElement).checked).toBe(true);
    act(() => {
      fireEvent.click(enableCheckbox);
    });
    expect((enableCheckbox as HTMLInputElement).checked).toBe(false);
    // Form body STILL on screen — the password input must still be in
    // the DOM even though the channel is now disabled.
    expect(
      screen.getByPlaceholderText('(saved — leave blank to keep)'),
    ).toBeInTheDocument();
  });

  it('the header row click toggles form visibility WITHOUT toggling enable', async () => {
    // Inverse of the previous test: clicking the chevron / title region
    // should collapse the form; the Enable checkbox must NOT flip.
    await mountWithStatus({
      ok: true,
      channels: {
        email: {
          configured: true,
          host: 'smtp.gmail.com',
          port: 587,
          user: 'alice@example.com',
          email_to: 'alice@example.com',
          ssl: false,
        },
        telegram: { configured: false, chat_id: '' },
      },
    });
    const enableCheckbox = screen.getByLabelText('Enable email channel');
    // Initially auto-expanded + auto-enabled.
    expect((enableCheckbox as HTMLInputElement).checked).toBe(true);
    expect(
      screen.getByPlaceholderText('(saved — leave blank to keep)'),
    ).toBeInTheDocument();
    // The header button is the one with aria-expanded — find it via
    // aria-controls (we set id="email-channel-body" on the body).
    const headerButton = document.querySelector(
      'button[aria-controls="email-channel-body"]',
    );
    if (!headerButton) throw new Error('expected an email header button');
    act(() => {
      fireEvent.click(headerButton);
    });
    // Form collapsed — password input gone.
    expect(
      screen.queryByPlaceholderText('(saved — leave blank to keep)'),
    ).not.toBeInTheDocument();
    // Enable state preserved.
    expect((enableCheckbox as HTMLInputElement).checked).toBe(true);
  });

  it('saveEnabledChannels (via ref) only POSTs save for channels currently enabled', async () => {
    let smtpCalls = 0;
    let telegramCalls = 0;
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
      http.post('/api/notifications/save-smtp', () => {
        smtpCalls += 1;
        return HttpResponse.json({ ok: true });
      }),
      http.post('/api/notifications/save-telegram', () => {
        telegramCalls += 1;
        return HttpResponse.json({ ok: true });
      }),
    );

    // We need a ref to call saveEnabledChannels imperatively.
    let handle: { saveEnabledChannels: () => Promise<boolean> } | null = null;
    const Wrapper = () => (
      <NotificationsConfigPanel
        ref={(h) => {
          handle = h;
        }}
      />
    );
    render(<Wrapper />);
    await waitFor(() => {
      expect(screen.getAllByText('Configured').length).toBeGreaterThan(0);
    });

    // The forwardRef callback runs synchronously during render, so by the
    // time waitFor above resolves, `handle` is populated. ESLint's
    // narrowing sees `handle` as still potentially-null without the cast.
    const ref = handle as unknown as { saveEnabledChannels: () => Promise<boolean> };
    // Email is auto-enabled (configured). Telegram is OFF. Save should
    // only POST save-smtp, NOT save-telegram.
    let ok: boolean | undefined;
    await act(async () => {
      ok = await ref.saveEnabledChannels();
    });
    expect(ok).toBe(true);
    expect(smtpCalls).toBe(1);
    expect(telegramCalls).toBe(0);
  });
});
