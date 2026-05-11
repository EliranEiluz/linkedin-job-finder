// Shared notifications panel — used both by the onboarding wizard's
// Step 6 (with the wizard nav wrapper around it) and by the post-onboarding
// Crawler Config card (NotificationsCard.tsx). Renders BOTH delivery
// channels in one panel:
//
//   1. Email (SMTP) — host / port / user / password / recipient / SSL,
//      a per-channel "Test connection" button + "Save" button.
//   2. Telegram — bot token + chat ID, same Test/Save buttons.
//
// The two channels are independent — both can be enabled, both can be off.
// The dispatcher in backend/send_digest.py fans out to whichever are
// enabled. We also surface an optional "Local — always on" informational
// row (`showLocal` prop) which is wizard-only framing.
//
// Secret hygiene: the SMTP password and Telegram bot_token are NEVER
// round-tripped from the /api/notifications/status response — the backend
// already redacts them. Inputs render empty after status load; the user
// types only to overwrite. An empty input on save = "preserve the saved
// secret" (the ctl validates that fallback).
//
// Save flow per channel:
//   - "Test connection" first POSTs save-{smtp|telegram} then test-{...}.
//     The test step reads from disk, so save must come first.
//   - "Save" just persists. Used by the wizard's combined Continue button
//     and by the standalone-card layout, surfaced via a ref-exposed
//     `saveEnabledChannels()` so a parent can chain save→advance.

import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react';
import clsx from 'clsx';
import { Banner } from './onboarding/components';
import type {
  NotificationsActionResponse,
  NotificationsStatusResponse,
} from './onboarding/types';

// SMTP provider presets — provider-agnostic copy, no model versioning.
interface ProviderPreset {
  id: string;
  label: string;
  host: string;
  port: number;
  ssl: boolean;
  hint?: string;
}
const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'gmail',
    label: 'Gmail',
    host: 'smtp.gmail.com',
    port: 587,
    ssl: false,
    hint: 'Generate an app password at https://myaccount.google.com/apppasswords',
  },
  {
    id: 'icloud',
    label: 'iCloud',
    host: 'smtp.mail.me.com',
    port: 587,
    ssl: false,
    hint: 'iCloud requires an app-specific password (Apple ID security settings).',
  },
  {
    id: 'fastmail',
    label: 'Fastmail',
    host: 'smtp.fastmail.com',
    port: 465,
    ssl: true,
  },
  {
    id: 'outlook',
    label: 'Outlook',
    host: 'smtp.office365.com',
    port: 587,
    ssl: false,
  },
  { id: 'custom', label: 'Custom', host: '', port: 587, ssl: false },
];

const findPreset = (host: string, port: number, ssl: boolean): string => {
  const m = PROVIDER_PRESETS.find(
    (p) => p.id !== 'custom' && p.host === host && p.port === port && p.ssl === ssl,
  );
  return m ? m.id : 'custom';
};

type ActionState =
  | { kind: 'idle' }
  | { kind: 'loading'; verb: 'test' | 'save' }
  | { kind: 'ok'; message: string }
  | { kind: 'err'; message: string };

export interface NotificationsConfigPanelHandle {
  /** Save whichever channels are currently checked. Returns false if any
   * enabled channel fails validation or save (so the wizard's Continue
   * button can keep the user on the page until they fix it). Disabled
   * channels are NOT touched — toggling them off is purely UI state, the
   * backend keeps the saved creds either way. */
  saveEnabledChannels: () => Promise<boolean>;
}

export interface NotificationsConfigPanelProps {
  /** When true, render the wizard's "Local — always on" informational
   * row above the two real channels. The post-onboarding ConfigPage card
   * omits this — the user already knows local digest exists by then. */
  showLocal?: boolean;
  /** When true (default), surface a per-channel "Save" button alongside
   * "Test connection". The wizard sets this to false because it owns the
   * combined Save-and-continue button at the bottom of the step. */
  showSaveButtons?: boolean;
}

export const NotificationsConfigPanel = forwardRef<
  NotificationsConfigPanelHandle,
  NotificationsConfigPanelProps
>(function NotificationsConfigPanel(
  { showLocal = false, showSaveButtons = true },
  ref,
) {
  // Multi-select per channel. Both can be on; both off = local-only fallback.
  //
  // Pre-#117 the "enabled" checkbox doubled as the show/hide chevron for
  // each channel's form — un-tick to hide the form, re-tick to see it.
  // That conflated two ideas: "I don't want this channel" vs "I'm just
  // collapsing the form for now". #117 decouples them:
  //
  //   emailEnabled / telegramEnabled
  //       → semantic on/off. Drives saveEnabledChannels() and which
  //         channels the digest actually fires through.
  //
  //   emailExpanded / telegramExpanded
  //       → purely visual. Drives whether the credentials form is
  //         shown. Toggled by clicking anywhere on the channel header.
  //
  // Default expanded-state mirrors enabled-state at mount (so configured
  // channels are visible right away), but the two diverge as soon as
  // the user toggles either independently.
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [telegramEnabled, setTelegramEnabled] = useState(false);
  const [emailExpanded, setEmailExpanded] = useState(false);
  const [telegramExpanded, setTelegramExpanded] = useState(false);

  // SMTP form state.
  const [presetId, setPresetId] = useState<string>('gmail');
  const [host, setHost] = useState('smtp.gmail.com');
  const [port, setPort] = useState<string>('587');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [emailTo, setEmailTo] = useState('');
  const [useSsl, setUseSsl] = useState(false);
  const [emailConfigured, setEmailConfigured] = useState(false);
  const [emailAction, setEmailAction] = useState<ActionState>({ kind: 'idle' });

  // Telegram form state. Bot token is treated like the SMTP password —
  // never round-tripped from /status, blank input = preserve the saved one.
  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [telegramConfigured, setTelegramConfigured] = useState(false);
  const [telegramAction, setTelegramAction] = useState<ActionState>({ kind: 'idle' });

  // Load existing config on mount. If a channel is already configured,
  // expand it + pre-fill the visible fields. Secrets stay blank.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/notifications/status?t=${Date.now().toString()}`);
        if (!res.ok) return;
        const body = (await res.json()) as NotificationsStatusResponse;
        if (!body.ok) return;

        const email = body.channels.email;
        if (email.configured) {
          setEmailEnabled(true);
          // Configured channels open by default so the user sees their
          // existing settings without having to click. Independent of
          // emailEnabled — toggling enable later won't re-collapse.
          setEmailExpanded(true);
          setEmailConfigured(true);
          setHost(email.host || 'smtp.gmail.com');
          setPort(email.port != null ? String(email.port) : '587');
          setUser(email.user || '');
          setEmailTo(email.email_to || '');
          setUseSsl(email.ssl);
          setPresetId(findPreset(email.host || '', email.port ?? 587, email.ssl));
        }

        const telegram = body.channels.telegram;
        if (telegram.configured) {
          setTelegramEnabled(true);
          setTelegramExpanded(true);
          setTelegramConfigured(true);
          setChatId(telegram.chat_id || '');
        }
      } catch {
        /* leave defaults — first-time user */
      }
    })();
  }, []);

  const onPresetChange = useCallback((id: string) => {
    setPresetId(id);
    const p = PROVIDER_PRESETS.find((x) => x.id === id);
    if (!p) return;
    if (id !== 'custom') {
      setHost(p.host);
      setPort(String(p.port));
      setUseSsl(p.ssl);
    }
  }, []);

  // Auto-toggle SSL on port 465 (SMTPS implicit). Backend mirrors this
  // logic so wizard and nightly send agree on SSL state.
  const onPortChange = useCallback((next: string) => {
    setPort(next);
    if (next.trim() === '465') setUseSsl(true);
  }, []);

  // ---- Email channel handlers ----------------------------------------

  const buildEmailPayload = useCallback(() => {
    const portInt = parseInt(port.trim(), 10);
    return {
      host: host.trim(),
      port: Number.isFinite(portInt) ? portInt : 587,
      user: user.trim(),
      password,
      email_to: emailTo.trim(),
      use_ssl: useSsl,
    };
  }, [host, port, user, password, emailTo, useSsl]);

  const validateEmail = useCallback((): string | null => {
    if (!host.trim()) return 'SMTP host is required';
    const p = parseInt(port.trim(), 10);
    if (!Number.isFinite(p) || p < 1 || p > 65535) return 'Port must be 1-65535';
    if (!user.trim()) return 'Username is required';
    if (!password && !emailConfigured) return 'App password is required';
    return null;
  }, [host, port, user, password, emailConfigured]);

  const onTestEmail = useCallback(async () => {
    const v = validateEmail();
    if (v) { setEmailAction({ kind: 'err', message: v }); return; }
    setEmailAction({ kind: 'loading', verb: 'test' });
    try {
      const saveRes = await fetch('/api/notifications/save-smtp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildEmailPayload()),
      });
      const saveBody = (await saveRes.json()) as NotificationsActionResponse;
      if (!saveBody.ok) {
        setEmailAction({ kind: 'err', message: saveBody.error ?? 'save failed' });
        return;
      }
      const testRes = await fetch('/api/notifications/test-smtp', { method: 'POST' });
      const testBody = (await testRes.json()) as NotificationsActionResponse;
      if (testBody.ok) {
        setPassword('');
        setEmailConfigured(true);
        setEmailAction({ kind: 'ok', message: testBody.message ?? 'Test email sent.' });
      } else {
        setEmailAction({ kind: 'err', message: testBody.error ?? 'test failed' });
      }
    } catch (e) {
      setEmailAction({ kind: 'err', message: (e as Error).message });
    }
  }, [validateEmail, buildEmailPayload]);

  const onSaveEmail = useCallback(async (): Promise<boolean> => {
    const v = validateEmail();
    if (v) { setEmailAction({ kind: 'err', message: v }); return false; }
    setEmailAction({ kind: 'loading', verb: 'save' });
    try {
      const res = await fetch('/api/notifications/save-smtp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildEmailPayload()),
      });
      const body = (await res.json()) as NotificationsActionResponse;
      if (body.ok) {
        setPassword('');
        setEmailConfigured(true);
        setEmailAction({ kind: 'ok', message: 'Saved.' });
        return true;
      }
      setEmailAction({ kind: 'err', message: body.error ?? 'save failed' });
      return false;
    } catch (e) {
      setEmailAction({ kind: 'err', message: (e as Error).message });
      return false;
    }
  }, [validateEmail, buildEmailPayload]);

  // ---- Telegram channel handlers -------------------------------------

  const buildTelegramPayload = useCallback(() => ({
    bot_token: botToken,
    chat_id: chatId.trim(),
  }), [botToken, chatId]);

  const validateTelegram = useCallback((): string | null => {
    if (!chatId.trim()) return 'Chat ID is required';
    if (!botToken && !telegramConfigured) return 'Bot token is required';
    return null;
  }, [chatId, botToken, telegramConfigured]);

  const onTestTelegram = useCallback(async () => {
    const v = validateTelegram();
    if (v) { setTelegramAction({ kind: 'err', message: v }); return; }
    setTelegramAction({ kind: 'loading', verb: 'test' });
    try {
      const saveRes = await fetch('/api/notifications/save-telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildTelegramPayload()),
      });
      const saveBody = (await saveRes.json()) as NotificationsActionResponse;
      if (!saveBody.ok) {
        setTelegramAction({ kind: 'err', message: saveBody.error ?? 'save failed' });
        return;
      }
      const testRes = await fetch('/api/notifications/test-telegram', { method: 'POST' });
      const testBody = (await testRes.json()) as NotificationsActionResponse;
      if (testBody.ok) {
        setBotToken('');
        setTelegramConfigured(true);
        setTelegramAction({ kind: 'ok', message: testBody.message ?? 'Test message sent.' });
      } else {
        setTelegramAction({ kind: 'err', message: testBody.error ?? 'test failed' });
      }
    } catch (e) {
      setTelegramAction({ kind: 'err', message: (e as Error).message });
    }
  }, [validateTelegram, buildTelegramPayload]);

  const onSaveTelegram = useCallback(async (): Promise<boolean> => {
    const v = validateTelegram();
    if (v) { setTelegramAction({ kind: 'err', message: v }); return false; }
    setTelegramAction({ kind: 'loading', verb: 'save' });
    try {
      const res = await fetch('/api/notifications/save-telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildTelegramPayload()),
      });
      const body = (await res.json()) as NotificationsActionResponse;
      if (body.ok) {
        setBotToken('');
        setTelegramConfigured(true);
        setTelegramAction({ kind: 'ok', message: 'Saved.' });
        return true;
      }
      setTelegramAction({ kind: 'err', message: body.error ?? 'save failed' });
      return false;
    } catch (e) {
      setTelegramAction({ kind: 'err', message: (e as Error).message });
      return false;
    }
  }, [validateTelegram, buildTelegramPayload]);

  // Expose a single "save whatever is checked" handle so a parent (wizard
  // step) can chain save → advance behind its own Continue button.
  useImperativeHandle(
    ref,
    () => ({
      saveEnabledChannels: async () => {
        if (emailEnabled) {
          const ok = await onSaveEmail();
          if (!ok) return false;
        }
        if (telegramEnabled) {
          const ok = await onSaveTelegram();
          if (!ok) return false;
        }
        return true;
      },
    }),
    [emailEnabled, telegramEnabled, onSaveEmail, onSaveTelegram],
  );

  return (
    <div className="space-y-3">
      {showLocal && (
        /* Local — always on, informational only. Wizard-only framing; the
           post-onboarding card omits this row because the user already
           knows about digest.html by then. */
        <div className="flex items-start gap-3 rounded border border-slate-200 bg-slate-50 p-3">
          <input
            type="checkbox"
            checked
            disabled
            className="mt-1 cursor-not-allowed"
            aria-label="Local digest (always on)"
          />
          <div>
            <div className="font-medium text-slate-800">
              Local <span className="ml-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">Always on</span>
            </div>
            <p className="mt-1 text-xs text-slate-600">
              Each scrape writes <code className="rounded bg-slate-100 px-1 py-0.5">digest.html</code>{' '}
              in your repo root; open it in a browser (or the Run History tab) to see new jobs. No setup needed.
            </p>
          </div>
        </div>
      )}

      {/* Email channel — header row toggles the form's visibility
          (emailExpanded); the Enable checkbox inside controls the
          semantic on/off (emailEnabled). The two are independent so
          un-ticking Enable doesn't hide the form (the #117 pain point).
          The whole header is the click target — chevron + label + tag +
          configured badge. Min-h-[44px] for mobile tap targets. */}
      <div
        className={clsx(
          'rounded border transition-colors duration-150',
          emailEnabled
            ? 'border-indigo-500 bg-indigo-50/50 ring-1 ring-indigo-300'
            : 'border-slate-200 bg-white',
        )}
      >
        <button
          type="button"
          onClick={() => { setEmailExpanded((v) => !v); }}
          aria-expanded={emailExpanded}
          aria-controls="email-channel-body"
          className={clsx(
            'flex min-h-[44px] w-full items-center gap-3 rounded p-3 text-left transition-colors duration-150',
            'hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-300',
            emailEnabled && 'hover:bg-indigo-50',
          )}
        >
          <span
            aria-hidden="true"
            className={clsx(
              'inline-block text-slate-400 transition-transform duration-150 ease-out',
              emailExpanded ? 'rotate-90' : 'rotate-0',
            )}
          >
            ▶
          </span>
          <div className="flex-1">
            <div className="font-medium text-slate-800">
              Email{' '}
              {emailConfigured && (
                <span className="ml-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                  Configured
                </span>
              )}
              {!emailEnabled && emailConfigured && (
                <span
                  className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500"
                  title="Saved credentials present, but this channel won't fire on the next scrape."
                >
                  Off
                </span>
              )}
              {!emailEnabled && !emailConfigured && (
                <span className="ml-1 text-[11px] font-normal italic text-slate-400">
                  no key set
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-slate-600">
              Send the HTML digest to your inbox after each scrape via SMTP.
            </p>
            {/* When configured, show a one-line summary of where we'd send. The
                password is intentionally absent — see the file header. */}
            {emailConfigured && !emailExpanded && (
              <p className="mt-1 text-[11px] text-slate-500">
                <span className="font-mono">{host}</span>
                {user && (
                  <>
                    {' '}as <span className="font-mono">{user}</span>
                  </>
                )}
              </p>
            )}
          </div>
          {/* Enable toggle. Lives in the header row but does NOT toggle
              the form visibility — clicking the checkbox stops
              propagation so the surrounding button doesn't fire. */}
          <label
            className="inline-flex shrink-0 items-center gap-1.5 rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 hover:border-slate-300"
            onClick={(e) => { e.stopPropagation(); }}
            onKeyDown={(e) => { e.stopPropagation(); }}
          >
            <input
              type="checkbox"
              checked={emailEnabled}
              onChange={(e) => {
                const next = e.target.checked;
                setEmailEnabled(next);
                // Auto-expand on enable (so the user lands in the form
                // ready to type). Disabling does NOT auto-collapse — the
                // #117 decoupling means the user keeps the form on
                // screen as long as they want.
                if (next) setEmailExpanded(true);
              }}
              aria-label="Enable email channel"
              className="h-3.5 w-3.5"
            />
            Enable
          </label>
        </button>
      </div>

      {emailExpanded && (
        <div
          id="email-channel-body"
          className="ml-7 space-y-3 rounded border border-slate-200 bg-slate-50 p-3"
          // Scroll-margin so iOS doesn't bury a focused input under the
          // sticky tab nav when the soft keyboard opens.
          style={{ scrollMarginTop: '5rem' }}
        >
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">
              Provider preset
            </label>
            <select
              value={presetId}
              onChange={(e) => { onPresetChange(e.target.value); }}
              className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
            >
              {PROVIDER_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
            {(() => {
              const p = PROVIDER_PRESETS.find((x) => x.id === presetId);
              return p?.hint ? (
                <div className="mt-1 text-xs text-slate-500">{p.hint}</div>
              ) : null;
            })()}
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">SMTP host</label>
              <input
                type="text"
                value={host}
                onChange={(e) => { setHost(e.target.value); }}
                placeholder="smtp.gmail.com"
                autoComplete="off"
                className="w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
              />
            </div>
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <label className="mb-1 block text-xs font-medium text-slate-600">SMTP port</label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={port}
                  onChange={(e) => { onPortChange(e.target.value); }}
                  placeholder="587"
                  autoComplete="off"
                  className="w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                />
              </div>
              <label className="mb-1 inline-flex items-center gap-1.5 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={useSsl}
                  onChange={(e) => { setUseSsl(e.target.checked); }}
                />
                use SSL
              </label>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Username</label>
            <input
              type="text"
              value={user}
              onChange={(e) => { setUser(e.target.value); }}
              placeholder="you@example.com"
              autoComplete="off"
              className="w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">App password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); }}
              placeholder={
                emailConfigured
                  ? '(saved — leave blank to keep)'
                  : 'paste app password…'
              }
              autoComplete="new-password"
              className="w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">
              Recipient <span className="font-normal text-slate-500">(defaults to username)</span>
            </label>
            <input
              type="text"
              value={emailTo}
              onChange={(e) => { setEmailTo(e.target.value); }}
              placeholder={user || 'you@example.com'}
              autoComplete="off"
              className="w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
            />
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => void onTestEmail()}
              disabled={emailAction.kind === 'loading'}
              className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {emailAction.kind === 'loading' && emailAction.verb === 'test'
                ? 'Testing…'
                : 'Test connection'}
            </button>
            {showSaveButtons && (
              <button
                type="button"
                onClick={() => void onSaveEmail()}
                disabled={emailAction.kind === 'loading'}
                className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {emailAction.kind === 'loading' && emailAction.verb === 'save'
                  ? 'Saving…'
                  : 'Save'}
              </button>
            )}
          </div>

          {emailAction.kind === 'ok' && (
            <Banner kind="ok">{emailAction.message}</Banner>
          )}
          {emailAction.kind === 'err' && (
            <Banner kind="err">{emailAction.message}</Banner>
          )}
        </div>
      )}

      {/* Telegram channel — same decoupled header pattern as Email
          (#117). Header toggles telegramExpanded; the Enable checkbox
          inside toggles telegramEnabled. */}
      <div
        className={clsx(
          'rounded border transition-colors duration-150',
          telegramEnabled
            ? 'border-indigo-500 bg-indigo-50/50 ring-1 ring-indigo-300'
            : 'border-slate-200 bg-white',
        )}
      >
        <button
          type="button"
          onClick={() => { setTelegramExpanded((v) => !v); }}
          aria-expanded={telegramExpanded}
          aria-controls="telegram-channel-body"
          className={clsx(
            'flex min-h-[44px] w-full items-center gap-3 rounded p-3 text-left transition-colors duration-150',
            'hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-300',
            telegramEnabled && 'hover:bg-indigo-50',
          )}
        >
          <span
            aria-hidden="true"
            className={clsx(
              'inline-block text-slate-400 transition-transform duration-150 ease-out',
              telegramExpanded ? 'rotate-90' : 'rotate-0',
            )}
          >
            ▶
          </span>
          <div className="flex-1">
            <div className="font-medium text-slate-800">
              Telegram{' '}
              {telegramConfigured && (
                <span className="ml-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                  Configured
                </span>
              )}
              {!telegramEnabled && telegramConfigured && (
                <span
                  className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500"
                  title="Saved credentials present, but this channel won't fire on the next scrape."
                >
                  Off
                </span>
              )}
              {!telegramEnabled && !telegramConfigured && (
                <span className="ml-1 text-[11px] font-normal italic text-slate-400">
                  no key set
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-slate-600">
              Send a message via a bot after each scrape. Free, no SMTP, no email account needed.
            </p>
            {telegramConfigured && !telegramExpanded && chatId && (
              <p className="mt-1 text-[11px] text-slate-500">
                chat <span className="font-mono">{chatId}</span>
              </p>
            )}
          </div>
          <label
            className="inline-flex shrink-0 items-center gap-1.5 rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 hover:border-slate-300"
            onClick={(e) => { e.stopPropagation(); }}
            onKeyDown={(e) => { e.stopPropagation(); }}
          >
            <input
              type="checkbox"
              checked={telegramEnabled}
              onChange={(e) => {
                const next = e.target.checked;
                setTelegramEnabled(next);
                if (next) setTelegramExpanded(true);
              }}
              aria-label="Enable telegram channel"
              className="h-3.5 w-3.5"
            />
            Enable
          </label>
        </button>
      </div>

      {telegramExpanded && (
        <div
          id="telegram-channel-body"
          className="ml-7 space-y-3 rounded border border-slate-200 bg-slate-50 p-3"
          style={{ scrollMarginTop: '5rem' }}
        >
          <div className="rounded border border-indigo-100 bg-indigo-50/50 p-2.5 text-xs text-slate-700">
            <div className="font-medium text-slate-800">How to set up:</div>
            <ol className="mt-1 list-decimal pl-4 leading-relaxed">
              <li>
                Talk to{' '}
                <a
                  href="https://t.me/BotFather"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-indigo-700 hover:underline"
                >
                  @BotFather
                </a>{' '}
                on Telegram, run <code className="rounded bg-white px-1">/newbot</code>, copy the token it gives you.
              </li>
              <li>
                Start a chat with your new bot and send any message (e.g.{' '}
                <code className="rounded bg-white px-1">hi</code>).
              </li>
              <li>
                Visit{' '}
                <code className="rounded bg-white px-1">
                  https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates
                </code>{' '}
                in a browser, look for{' '}
                <code className="rounded bg-white px-1">{`"chat":{"id":...}`}</code> — that number is your chat ID.
              </li>
            </ol>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Bot token</label>
            <input
              type="password"
              value={botToken}
              onChange={(e) => { setBotToken(e.target.value); }}
              placeholder={
                telegramConfigured
                  ? '(saved — leave blank to keep)'
                  : 'paste bot token…'
              }
              autoComplete="new-password"
              className="w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Chat ID</label>
            <input
              type="text"
              value={chatId}
              onChange={(e) => { setChatId(e.target.value); }}
              placeholder="e.g. 123456789"
              autoComplete="off"
              className="w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
            />
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => void onTestTelegram()}
              disabled={telegramAction.kind === 'loading'}
              className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {telegramAction.kind === 'loading' && telegramAction.verb === 'test'
                ? 'Testing…'
                : 'Test connection'}
            </button>
            {showSaveButtons && (
              <button
                type="button"
                onClick={() => void onSaveTelegram()}
                disabled={telegramAction.kind === 'loading'}
                className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {telegramAction.kind === 'loading' && telegramAction.verb === 'save'
                  ? 'Saving…'
                  : 'Save'}
              </button>
            )}
          </div>

          {telegramAction.kind === 'ok' && (
            <Banner kind="ok">{telegramAction.message}</Banner>
          )}
          {telegramAction.kind === 'err' && (
            <Banner kind="err">{telegramAction.message}</Banner>
          )}
        </div>
      )}
    </div>
  );
});
