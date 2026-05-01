// Step 6 — Notifications. Three radio options:
//   - Local only (default)        : digest.html on disk, no setup.
//   - Email me (SMTP)             : expanded form + Test/Save buttons.
//   - Webhook (coming soon)       : disabled radio.
//
// Save flow for the email path: POST /api/notifications/save-smtp first
// (so test-smtp reads from saved env), THEN POST /api/notifications/test-smtp.
// On test success the user can hit "Save & continue" — it's already saved,
// so the button just advances. Empty password = preserve the saved one
// (status returns smtp_configured but never the password value).

import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { Banner, BackButton } from '../components';
import type {
  NotificationsActionResponse,
  NotificationsStatusResponse,
} from '../types';

type Choice = 'local' | 'email' | 'webhook';

// Keep this list small + provider-agnostic. The SMTP defaults match the
// .linkedin-jobs.env.example file shipped at the repo root.
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
    // Regular Gmail passwords don't work for SMTP — Google blocks them.
    // Surface the link inline so the user doesn't have to dig through docs.
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

export const Step6Notifications = ({
  onAdvance,
  onBack,
}: {
  onAdvance: () => void;
  onBack: () => void;
}) => {
  const [choice, setChoice] = useState<Choice>('local');
  const [presetId, setPresetId] = useState<string>('gmail');
  const [host, setHost] = useState('smtp.gmail.com');
  const [port, setPort] = useState<string>('587');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [emailTo, setEmailTo] = useState('');
  const [useSsl, setUseSsl] = useState(false);
  // Tri-state: have we already loaded /api/notifications/status?
  // Drives the placeholder ("(saved — leave blank to keep)") so the user
  // doesn't get tricked into thinking we lost their password.
  const [smtpAlreadyConfigured, setSmtpAlreadyConfigured] = useState(false);
  const [actionState, setActionState] = useState<
    | { kind: 'idle' }
    | { kind: 'loading'; verb: 'test' | 'save' }
    | { kind: 'ok'; message: string; canAdvance: boolean }
    | { kind: 'err'; message: string }
  >({ kind: 'idle' });

  // Load existing config on mount. If smtp_configured=true, pre-fill the
  // visible fields and switch the radio to "Email me" so the user can
  // tell the option is active. Password stays blank — never round-tripped.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/notifications/status?t=${Date.now().toString()}`);
        if (!res.ok) return;
        const body = (await res.json()) as NotificationsStatusResponse;
        if (!body.ok) return;
        if (body.smtp_configured) {
          setSmtpAlreadyConfigured(true);
          setChoice('email');
          setHost(body.host || 'smtp.gmail.com');
          setPort(body.port != null ? String(body.port) : '587');
          setUser(body.user || '');
          setEmailTo(body.email_to || '');
          setUseSsl(body.ssl);
          setPresetId(findPreset(body.host || '', body.port ?? 587, body.ssl));
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

  // Auto-toggle SSL when the user types port 465. Spec: SSL implicit on
  // port 465 (SMTPS); the backend mirrors this same logic so the wizard
  // and the nightly send agree on SSL state.
  const onPortChange = useCallback((next: string) => {
    setPort(next);
    if (next.trim() === '465') setUseSsl(true);
  }, []);

  const buildPayload = useCallback(() => {
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

  // Validation mirrors notifications_ctl._validate_save_payload — keep them
  // in sync. The backend rechecks anyway, but failing fast in the UI gives
  // a tighter feedback loop than waiting for a 400.
  const validate = useCallback((): string | null => {
    if (!host.trim()) return 'SMTP host is required';
    const p = parseInt(port.trim(), 10);
    if (!Number.isFinite(p) || p < 1 || p > 65535) return 'Port must be 1-65535';
    if (!user.trim()) return 'Username is required';
    // Empty password OK only when smtp_configured (preserve the saved one).
    if (!password && !smtpAlreadyConfigured) return 'App password is required';
    return null;
  }, [host, port, user, password, smtpAlreadyConfigured]);

  const onTest = useCallback(async () => {
    const v = validate();
    if (v) { setActionState({ kind: 'err', message: v }); return; }
    setActionState({ kind: 'loading', verb: 'test' });
    try {
      // 1) Save first — test-smtp reads from disk, not from the request.
      const saveRes = await fetch('/api/notifications/save-smtp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload()),
      });
      const saveBody = (await saveRes.json()) as NotificationsActionResponse;
      if (!saveBody.ok) {
        setActionState({ kind: 'err', message: saveBody.error ?? 'save failed' });
        return;
      }
      // 2) Test connection.
      const testRes = await fetch('/api/notifications/test-smtp', { method: 'POST' });
      const testBody = (await testRes.json()) as NotificationsActionResponse;
      if (testBody.ok) {
        // Drop the in-memory password — it's safely on disk now.
        setPassword('');
        setSmtpAlreadyConfigured(true);
        setActionState({
          kind: 'ok',
          message: testBody.message ?? 'Test email sent.',
          canAdvance: true,
        });
      } else {
        setActionState({
          kind: 'err',
          message: testBody.error ?? 'test failed',
        });
      }
    } catch (e) {
      setActionState({ kind: 'err', message: (e as Error).message });
    }
  }, [validate, buildPayload]);

  const onSave = useCallback(async () => {
    const v = validate();
    if (v) { setActionState({ kind: 'err', message: v }); return; }
    setActionState({ kind: 'loading', verb: 'save' });
    try {
      const res = await fetch('/api/notifications/save-smtp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload()),
      });
      const body = (await res.json()) as NotificationsActionResponse;
      if (body.ok) {
        setPassword('');
        setSmtpAlreadyConfigured(true);
        // Save-without-test still advances — user explicitly asked to.
        onAdvance();
      } else {
        setActionState({ kind: 'err', message: body.error ?? 'save failed' });
      }
    } catch (e) {
      setActionState({ kind: 'err', message: (e as Error).message });
    }
  }, [validate, buildPayload, onAdvance]);

  return (
    <div>
      <h2 className="mb-2 text-base font-semibold text-slate-800">Notifications</h2>
      <p className="mb-4 text-sm text-slate-600">
        How should the scraper deliver new jobs? You can change this later
        by editing <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">~/.linkedin-jobs.env</code>.
      </p>

      <div className="space-y-3">
        {/* Local only (default) */}
        <label
          className={clsx(
            'flex cursor-pointer items-start gap-3 rounded border p-3 transition',
            choice === 'local'
              ? 'border-indigo-500 bg-indigo-50/50 ring-1 ring-indigo-300'
              : 'border-slate-200 bg-white hover:border-indigo-300',
          )}
        >
          <input
            type="radio"
            name="notif-choice"
            value="local"
            checked={choice === 'local'}
            onChange={() => { setChoice('local'); }}
            className="mt-1"
          />
          <div>
            <div className="font-medium text-slate-800">
              Local only <span className="text-xs font-normal text-slate-500">(recommended)</span>
            </div>
            <p className="mt-1 text-xs text-slate-600">
              Each scrape writes <code className="rounded bg-slate-100 px-1 py-0.5">digest.html</code>{' '}
              in your repo root; open it in a browser to see new jobs. No setup needed.
            </p>
          </div>
        </label>

        {/* Email me (SMTP) */}
        <label
          className={clsx(
            'flex cursor-pointer items-start gap-3 rounded border p-3 transition',
            choice === 'email'
              ? 'border-indigo-500 bg-indigo-50/50 ring-1 ring-indigo-300'
              : 'border-slate-200 bg-white hover:border-indigo-300',
          )}
        >
          <input
            type="radio"
            name="notif-choice"
            value="email"
            checked={choice === 'email'}
            onChange={() => { setChoice('email'); }}
            className="mt-1"
          />
          <div className="flex-1">
            <div className="font-medium text-slate-800">
              Email me{' '}
              {smtpAlreadyConfigured && (
                <span className="ml-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                  Configured
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-slate-600">
              Send an HTML digest to your inbox after each scrape via SMTP.
            </p>
          </div>
        </label>

        {choice === 'email' && (
          <div className="ml-7 space-y-3 rounded border border-slate-200 bg-slate-50 p-3">
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
                  smtpAlreadyConfigured
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
                onClick={() => void onTest()}
                disabled={actionState.kind === 'loading'}
                className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {actionState.kind === 'loading' && actionState.verb === 'test'
                  ? 'Testing…'
                  : 'Test connection'}
              </button>
              <button
                type="button"
                onClick={() => void onSave()}
                disabled={actionState.kind === 'loading'}
                className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {actionState.kind === 'loading' && actionState.verb === 'save'
                  ? 'Saving…'
                  : 'Save & continue'}
              </button>
            </div>

            {actionState.kind === 'ok' && (
              <Banner kind="ok">{actionState.message}</Banner>
            )}
            {actionState.kind === 'err' && (
              <Banner kind="err">{actionState.message}</Banner>
            )}
          </div>
        )}

        {/* Webhook (disabled) */}
        <label
          className={clsx(
            'flex cursor-not-allowed items-start gap-3 rounded border p-3 opacity-60',
            'border-slate-200 bg-white',
          )}
        >
          <input
            type="radio"
            name="notif-choice"
            value="webhook"
            checked={choice === 'webhook'}
            disabled
            className="mt-1"
          />
          <div>
            <div className="font-medium text-slate-800">
              Webhook{' '}
              <span className="text-xs font-normal text-slate-500">(coming soon)</span>
            </div>
            <p className="mt-1 text-xs text-slate-600">
              Slack / Discord / Telegram. Not wired up yet.
            </p>
          </div>
        </label>
      </div>

      <div className="mt-5 flex justify-between gap-2">
        <BackButton onBack={onBack} />
        <button
          type="button"
          onClick={onAdvance}
          // For "Local only" the user can advance immediately. For the
          // email path, the inline Save button advances after a successful
          // save — but we still expose Continue here so a user who already
          // configured SMTP previously can skip without re-saving.
          className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-indigo-700"
        >
          {choice === 'local' ? 'Continue →' : 'Skip & continue →'}
        </button>
      </div>
    </div>
  );
};
