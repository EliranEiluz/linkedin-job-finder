import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { Dot } from './Dot';

// "Access from anywhere" panel for the Crawler Config tab. Surfaces the
// install/run state of two off-network access tools — Tailscale (private
// mesh) and Cloudflare Tunnel (public URL with auth gate) — plus a
// best-effort host-binding heuristic for the Vite dev server.
//
// Read-only: this card NEVER auto-installs or auto-configures anything.
// The user runs the actual `tailscale up` / `cloudflared tunnel create`
// commands in their terminal. We surface status, copy-paste commands in
// collapsed setup steps, and link out to docs/remote-access.md for the
// full walkthrough. Auto-installing system tools would be a security and
// trust foot-gun.
//
// Caveats are surfaced in always-visible amber callouts (NOT buried in
// the collapsed setup-steps blocks):
//
//   Tailscale  → Mac must be awake (sleeping = phone shows error)
//   Cloudflare → (1) dashboard ships zero local auth; public exposure
//                    REQUIRES Cloudflare Access turned on
//                (2) trust dependency: Cloudflare decrypts at edge
//                (3) Mac must be awake (sleeping = tunnel down)
//
// Layout mirrors SchedulerCard: rounded white card with a header row, a
// short paragraph, and per-tool sub-cards. Refresh button re-fetches
// /api/remote-access/status.

const STATUS_URL = '/api/remote-access/status';
const DOCS_URL =
  'https://github.com/EliranEiluz/linkedin-job-finder/blob/main/docs/remote-access.md';
// Fixed delay before swapping the loading shimmer for content. Without it
// the badge flashes from "checking" to "ok" on a fast local response,
// which reads as broken to the eye.
const LOADING_MIN_MS = 500;

interface TailscaleStatus {
  installed: boolean;
  running?: boolean;
  hostname?: string;
  ipv4?: string;
  url?: string;
  error?: string;
}

interface CloudflareTunnel {
  name: string;
  status: string;
}

interface CloudflareStatus {
  installed: boolean;
  tunnels?: CloudflareTunnel[];
  error?: string;
}

interface ViteHostBinding {
  all_interfaces: boolean;
  note: string;
}

export interface RemoteAccessStatus {
  ok: boolean;
  tailscale: TailscaleStatus;
  cloudflare: CloudflareStatus;
  vite_host_binding: ViteHostBinding;
}

// Small label+dot status chip — same neutral chip + semantic dot pattern
// as SchedulerCard's StatusBadge.
const StatusChip = ({
  color,
  label,
}: {
  color: 'good' | 'warn' | 'bad';
  label: string;
}) => (
  <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
    <Dot color={color} /> {label}
  </span>
);

// Always-visible amber callout for the caveats. Not part of the collapsed
// setup-steps block — the Cloudflare three (zero-local-auth, trust at edge,
// awake Mac) and the Tailscale one (awake Mac) are not optional small
// print and must be loud at all times.
const CaveatBox = ({ items }: { items: string[] }) => (
  <div className="mt-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
    <ul className="space-y-1">
      {items.map((line, i) => (
        <li key={i} className="flex gap-1.5">
          <span className="select-none text-amber-700">!</span>
          <span>{line}</span>
        </li>
      ))}
    </ul>
  </div>
);

// Small inline copy-to-clipboard button. Returns to its idle label after
// a short flash so the user sees confirmation. The promise's reject path
// silently no-ops (older browsers / non-secure contexts / permission
// denied) — the URL is still visible above the button so manual copy
// always works.
const CopyButton = ({ text }: { text: string }) => {
  const [copied, setCopied] = useState(false);
  const onClick = useCallback(() => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        window.setTimeout(() => { setCopied(false); }, 1500);
      },
      () => {
        /* clipboard write rejected — no-op, user can copy manually */
      },
    );
  }, [text]);
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-700 hover:bg-slate-50"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
};

// Tailscale sub-card. Three visible states:
//   - not installed → setup steps expanded by default + "Not installed" badge
//   - installed but not running → "Tailscale installed but not connected"
//   - running → URL row with copy + status chip
const TailscaleSection = ({ status }: { status: TailscaleStatus }) => {
  const [setupOpen, setSetupOpen] = useState(!status.installed);

  let chip: React.ReactNode;
  if (!status.installed) {
    chip = <StatusChip color="bad" label="Not installed" />;
  } else if (!status.running) {
    chip = <StatusChip color="warn" label="Installed (not connected)" />;
  } else {
    chip = <StatusChip color="good" label="Running" />;
  }

  return (
    <div className="rounded border border-slate-200 bg-slate-50 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="text-xs font-semibold text-slate-700">
          Tailscale (private mesh)
        </div>
        {chip}
      </div>

      {status.installed && status.running && status.url ? (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-slate-700">
          <span className="text-slate-500">Your URL:</span>
          <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-slate-900">
            {status.url}
          </code>
          <CopyButton text={status.url} />
        </div>
      ) : status.installed && !status.running ? (
        <div className="mb-2 text-xs text-slate-600">
          Tailscale is installed but not connected. Run{' '}
          <code className="rounded bg-white px-1 font-mono text-[11px]">
            tailscale up
          </code>{' '}
          in your terminal.
          {status.error && (
            <div className="mt-1 break-all text-[11px] text-slate-500">
              ({status.error})
            </div>
          )}
        </div>
      ) : null}

      <CaveatBox
        items={[
          'Mac must be awake. A sleeping Mac means your phone will show a connection error.',
        ]}
      />

      <details
        className="mt-2 rounded border border-slate-200 bg-white"
        open={setupOpen}
        onToggle={(e) => { setSetupOpen((e.currentTarget).open); }}
      >
        <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50">
          Setup steps for Tailscale
        </summary>
        <div className="border-t border-slate-200 px-3 py-2 text-xs text-slate-700">
          <ol className="ml-4 list-decimal space-y-1">
            <li>Install: <code className="rounded bg-slate-100 px-1 font-mono text-[11px]">brew install --cask tailscale</code> (or download from tailscale.com).</li>
            <li>Sign in via the menu-bar icon (Google / GitHub / email — your choice).</li>
            <li>Install Tailscale on your phone too and sign in to the same account.</li>
            <li>From your terminal, confirm the connection: <code className="rounded bg-slate-100 px-1 font-mono text-[11px]">tailscale status</code>.</li>
            <li>Make sure the Vite dev server binds to all interfaces — set <code className="rounded bg-slate-100 px-1 font-mono text-[11px]">"dev": "vite --host"</code> in <code className="rounded bg-slate-100 px-1 font-mono text-[11px]">ui/package.json</code>, then restart <code className="rounded bg-slate-100 px-1 font-mono text-[11px]">npm run dev</code>.</li>
            <li>Open the URL above on your phone (same Tailscale account).</li>
          </ol>
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-2 inline-block text-brand-700 hover:text-brand-800 hover:underline"
          >
            Learn more →
          </a>
        </div>
      </details>
    </div>
  );
};

// Cloudflare Tunnel sub-card. States parallel Tailscale's three:
//   - not installed → "Not installed" badge + setup expanded
//   - installed, no tunnels yet → "No tunnels configured"
//   - installed, tunnels list → per-tunnel chips + healthy summary
const CloudflareSection = ({ status }: { status: CloudflareStatus }) => {
  const [setupOpen, setSetupOpen] = useState(!status.installed);

  const tunnels = status.tunnels ?? [];
  const healthyCount = tunnels.filter(
    (t) => t.status.toUpperCase() === 'HEALTHY',
  ).length;

  let chip: React.ReactNode;
  if (!status.installed) {
    chip = <StatusChip color="bad" label="Not installed" />;
  } else if (tunnels.length === 0) {
    chip = <StatusChip color="warn" label="Installed (no tunnels)" />;
  } else if (healthyCount > 0) {
    chip = (
      <StatusChip
        color="good"
        label={`${String(healthyCount)} of ${String(tunnels.length)} HEALTHY`}
      />
    );
  } else {
    chip = <StatusChip color="warn" label={`${String(tunnels.length)} tunnel(s) — none HEALTHY`} />;
  }

  return (
    <div className="rounded border border-slate-200 bg-slate-50 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="text-xs font-semibold text-slate-700">
          Cloudflare Tunnel (public URL with auth gate)
        </div>
        {chip}
      </div>

      {status.installed && tunnels.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5 text-xs">
          {tunnels.map((t) => (
            <span
              key={t.name}
              className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-2 py-0.5 font-mono text-[11px] text-slate-800"
            >
              <Dot
                color={t.status.toUpperCase() === 'HEALTHY' ? 'good' : 'warn'}
              />
              {t.name} ({t.status})
            </span>
          ))}
        </div>
      )}

      {status.installed && tunnels.length === 0 && !status.error && (
        <div className="mb-2 text-xs text-slate-600">
          No tunnels configured yet. Run{' '}
          <code className="rounded bg-white px-1 font-mono text-[11px]">
            cloudflared tunnel create &lt;name&gt;
          </code>{' '}
          to create one.
        </div>
      )}

      {status.installed && status.error && (
        <div className="mb-2 break-all text-xs text-slate-600">
          {status.error}
        </div>
      )}

      <CaveatBox
        items={[
          'WARNING: the dashboard ships zero local auth. Public exposure REQUIRES Cloudflare Access turned on for this hostname.',
          'Trust dependency: Cloudflare terminates TLS at the edge and can technically inspect traffic.',
          'Mac must be awake. A sleeping Mac means the tunnel goes down and the public URL returns an error.',
        ]}
      />

      <details
        className="mt-2 rounded border border-slate-200 bg-white"
        open={setupOpen}
        onToggle={(e) => { setSetupOpen((e.currentTarget).open); }}
      >
        <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50">
          Setup steps for Cloudflare Tunnel
        </summary>
        <div className="border-t border-slate-200 px-3 py-2 text-xs text-slate-700">
          <ol className="ml-4 list-decimal space-y-1">
            <li>Install: <code className="rounded bg-slate-100 px-1 font-mono text-[11px]">brew install cloudflared</code>.</li>
            <li>Authenticate: <code className="rounded bg-slate-100 px-1 font-mono text-[11px]">cloudflared tunnel login</code> (opens a browser; pick a domain you own on Cloudflare).</li>
            <li>Create the tunnel: <code className="rounded bg-slate-100 px-1 font-mono text-[11px]">cloudflared tunnel create linkedin-jobs</code>.</li>
            <li>Add a config file at <code className="rounded bg-slate-100 px-1 font-mono text-[11px]">~/.cloudflared/config.yml</code> mapping a hostname to <code className="rounded bg-slate-100 px-1 font-mono text-[11px]">http://localhost:5173</code>.</li>
            <li>Route DNS: <code className="rounded bg-slate-100 px-1 font-mono text-[11px]">cloudflared tunnel route dns linkedin-jobs jobs.example.com</code>.</li>
            <li><strong>Turn on Cloudflare Access</strong> for that hostname (Zero Trust dashboard → Access → Applications). This is the auth gate; without it the dashboard is fully public.</li>
            <li>Run the tunnel: <code className="rounded bg-slate-100 px-1 font-mono text-[11px]">cloudflared tunnel run linkedin-jobs</code>.</li>
          </ol>
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-2 inline-block text-brand-700 hover:text-brand-800 hover:underline"
          >
            Learn more →
          </a>
        </div>
      </details>
    </div>
  );
};

export const RemoteAccessCard = () => {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; data: RemoteAccessStatus }
    | { kind: 'error'; message: string }
  >({ kind: 'loading' });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (silent: boolean) => {
    if (!silent) setState({ kind: 'loading' });
    setRefreshing(silent);
    const startedAt = Date.now();
    try {
      const res = await fetch(`${STATUS_URL}?t=${Date.now().toString()}`);
      if (!res.ok) {
        throw new Error(`HTTP ${String(res.status)}`);
      }
      const data = (await res.json()) as RemoteAccessStatus;
      // Honor LOADING_MIN_MS for the initial mount only — refresh-button
      // clicks should feel instant.
      if (!silent) {
        const elapsed = Date.now() - startedAt;
        if (elapsed < LOADING_MIN_MS) {
          await new Promise((r) => setTimeout(r, LOADING_MIN_MS - elapsed));
        }
      }
      setState({ kind: 'ready', data });
    } catch (e) {
      setState({ kind: 'error', message: (e as Error).message });
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-600">
          Access from anywhere
        </h2>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={refreshing || state.kind === 'loading'}
          className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          title="Re-poll status"
        >
          {refreshing ? '…' : '↻'} Refresh status
        </button>
      </div>
      <p className="mb-3 text-xs text-slate-500">
        The dashboard binds to localhost by default. Two ways to reach it
        from your phone or off-network — pick whichever fits. The full
        walkthrough lives in the remote-access doc; this panel just shows
        what's installed and gives you the URL to open.
      </p>

      {state.kind === 'loading' && (
        <div className="space-y-2">
          <div className="h-20 animate-pulse rounded border border-slate-200 bg-slate-100" />
          <div className="h-20 animate-pulse rounded border border-slate-200 bg-slate-100" />
        </div>
      )}

      {state.kind === 'error' && (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <div className="font-semibold">Could not read remote-access status</div>
          <div className="mt-0.5 break-all">{state.message}</div>
          <div className="mt-1 text-[11px] text-red-600/80">
            Check that <code>backend/ctl/remote_access_ctl.py</code> exists
            and is executable.
          </div>
        </div>
      )}

      {state.kind === 'ready' && (
        <div className="space-y-3">
          <TailscaleSection status={state.data.tailscale} />
          <CloudflareSection status={state.data.cloudflare} />

          {!state.data.vite_host_binding.all_interfaces && (
            <div
              className={clsx(
                'rounded border px-3 py-2 text-xs',
                'border-amber-300 bg-amber-50 text-amber-900',
              )}
            >
              <div className="font-semibold">Vite is bound to localhost only</div>
              <div className="mt-0.5">{state.data.vite_host_binding.note}</div>
            </div>
          )}
        </div>
      )}
    </section>
  );
};
