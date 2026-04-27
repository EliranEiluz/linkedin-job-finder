import { useCallback, useEffect, useState, type ReactNode } from 'react';
import clsx from 'clsx';

interface ProfilesResponse {
  ok: boolean;
  active?: string;
  profiles?: string[];
  error?: string;
}

type Action =
  | { kind: 'idle' }
  | { kind: 'create' }       // typing a new name to create from current
  | { kind: 'rename' }       // renaming the active profile
  | { kind: 'confirmDelete' };

const PROFILE_NAME_RE = /^[a-zA-Z0-9_-]{1,40}$/;

const isValidName = (s: string): boolean => PROFILE_NAME_RE.test(s);

const fetchProfiles = async (): Promise<ProfilesResponse> => {
  try {
    const r = await fetch('/api/profiles', { cache: 'no-store' });
    return (await r.json()) as ProfilesResponse;
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
};

const post = async (path: string, body: object): Promise<ProfilesResponse> => {
  try {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await r.json()) as ProfilesResponse;
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
};

interface Props {
  // Called whenever the active profile changes so the parent (ConfigPage)
  // can refetch /api/config and refresh its form fields.
  onActiveChange?: () => void;
  // Right-aligned slot in the action row — used by ConfigPage to mount the
  // "Suggest from feedback" button next to the profile selector, since the
  // suggestion is always scoped to the active profile's config.
  extraActions?: ReactNode;
}

export const ProfileSwitcher = ({ onActiveChange, extraActions }: Props) => {
  const [data, setData] = useState<ProfilesResponse>({ ok: false });
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<Action>({ kind: 'idle' });
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setData(await fetchProfiles());
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Auto-clear toast after a beat.
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 2500);
    return () => window.clearTimeout(id);
  }, [toast]);

  const triggerActiveChange = useCallback(() => {
    onActiveChange?.();
    // Also tell the rest of the app the corpus may now reflect a different
    // profile — the corpus page (and others) listen for this.
    window.dispatchEvent(new CustomEvent('linkedinjobs:corpus-stale'));
  }, [onActiveChange]);

  const onSwitch = useCallback(async (name: string) => {
    if (name === data.active) return;
    setBusy(true);
    const r = await post('/api/profiles/activate', { name });
    setBusy(false);
    if (r.ok) {
      setToast(`Switched to "${name}"`);
      await refresh();
      triggerActiveChange();
    } else {
      setToast(`✗ ${r.error || 'switch failed'}`);
    }
  }, [data.active, refresh, triggerActiveChange]);

  const submit = useCallback(async () => {
    if (action.kind === 'idle') return;
    const name = draft.trim();
    if (!isValidName(name)) {
      setToast('Name must be 1–40 chars: letters, digits, _ , -');
      return;
    }
    setBusy(true);
    let r: ProfilesResponse;
    if (action.kind === 'create') {
      // Create from a copy of the currently active profile so the user
      // doesn't lose their queries when iterating on a variant.
      r = await post('/api/profiles/create',
                     data.active ? { name, from: data.active } : { name });
    } else if (action.kind === 'rename') {
      if (!data.active) { setBusy(false); return; }
      r = await post('/api/profiles/rename', { old: data.active, new: name });
    } else {
      // confirmDelete uses the active profile name from data, not draft.
      r = await post('/api/profiles/delete', { name: data.active });
    }
    setBusy(false);
    if (r.ok) {
      setToast(action.kind === 'create' ? `Created "${name}" and switched`
             : action.kind === 'rename' ? `Renamed to "${name}"`
             : `Deleted "${data.active}"`);
      setAction({ kind: 'idle' });
      setDraft('');
      await refresh();
      triggerActiveChange();
    } else {
      setToast(`✗ ${r.error || 'failed'}`);
    }
  }, [action, draft, data.active, refresh, triggerActiveChange]);

  const cancel = useCallback(() => {
    setAction({ kind: 'idle' });
    setDraft('');
  }, []);

  // —— render ——
  const active = data.active ?? '(none)';
  const profiles = data.profiles ?? [];

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-slate-700">Profile</span>
          {loading && <span className="text-xs text-slate-400">loading…</span>}
          {!loading && data.error && (
            <span className="text-xs text-red-600">⚠ {data.error}</span>
          )}
        </div>
        {toast && (
          <span className="text-xs italic text-slate-500">{toast}</span>
        )}
      </div>

      {action.kind === 'idle' && (
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={active}
            disabled={busy || loading || profiles.length === 0}
            onChange={(e) => void onSwitch(e.target.value)}
            className="rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-800 focus:border-brand-700 focus:outline-none focus:ring-1 focus:ring-brand-700 disabled:opacity-50"
          >
            {profiles.length === 0 && <option>(none)</option>}
            {profiles.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy}
            onClick={() => { setAction({ kind: 'create' }); setDraft(''); }}
            className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700 hover:bg-brand-50 hover:text-brand-700"
            title="Create a new profile from a copy of the current one"
          >
            + New
          </button>
          <button
            type="button"
            disabled={busy || !data.active}
            onClick={() => { setAction({ kind: 'rename' }); setDraft(active); }}
            className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Rename
          </button>
          <button
            type="button"
            disabled={busy || profiles.length <= 1}
            onClick={() => setAction({ kind: 'confirmDelete' })}
            className="rounded border border-red-200 bg-white px-2.5 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
            title={profiles.length <= 1 ? 'Cannot delete the only profile' : `Delete "${active}"`}
          >
            Delete
          </button>
          {extraActions && <span className="ml-auto">{extraActions}</span>}
        </div>
      )}

      {(action.kind === 'create' || action.kind === 'rename') && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
              if (e.key === 'Escape') cancel();
            }}
            placeholder={action.kind === 'create' ? 'new profile name' : 'new name'}
            className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-sm focus:border-brand-700 focus:outline-none focus:ring-1 focus:ring-brand-700"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            className={clsx(
              'rounded px-3 py-1 text-xs font-medium',
              busy
                ? 'bg-slate-300 text-slate-600'
                : 'bg-brand-700 text-white hover:bg-brand-800',
            )}
          >
            {busy ? '…' : action.kind === 'create' ? 'Create + switch' : 'Rename'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={cancel}
            className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <p className="basis-full text-[11px] text-slate-400">
            Allowed: letters, digits, <code>_</code>, <code>-</code>. Max 40 chars.
            {action.kind === 'create' && ` Will be a copy of the current profile "${active}".`}
          </p>
        </div>
      )}

      {action.kind === 'confirmDelete' && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-slate-700">
            Delete <span className="font-semibold">{active}</span>? This is permanent.
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            className="rounded bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700"
          >
            {busy ? '…' : 'Yes, delete'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={cancel}
            className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
};
