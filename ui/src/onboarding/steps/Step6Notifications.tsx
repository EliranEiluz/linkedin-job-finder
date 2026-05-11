// Step 6 — Notifications. Thin wizard wrapper around the shared
// NotificationsConfigPanel. The panel owns ALL of the per-channel UI and
// state (Email + Telegram); this file just adds the wizard's heading,
// intro paragraph, BackButton + "Save & continue" button.
//
// Save flow on Continue: the shared panel exposes
// `saveEnabledChannels()` via ref — it returns false when an enabled
// channel fails validation, so the wizard keeps the user on this step
// until they fix it.
//
// The post-onboarding Crawler Config "Notifications" card (issue #113)
// renders the same panel via NotificationsCard.tsx — the panel itself is
// the single source of truth for the form.

import { useCallback, useRef, useState } from 'react';
import { BackButton } from '../components';
import {
  NotificationsConfigPanel,
  type NotificationsConfigPanelHandle,
} from '../../NotificationsConfigPanel';

export const Step6Notifications = ({
  onAdvance,
  onBack,
}: {
  onAdvance: () => void;
  onBack: () => void;
}) => {
  const panelRef = useRef<NotificationsConfigPanelHandle>(null);
  const [busy, setBusy] = useState(false);

  const onContinue = useCallback(async () => {
    if (!panelRef.current) {
      onAdvance();
      return;
    }
    setBusy(true);
    try {
      const ok = await panelRef.current.saveEnabledChannels();
      if (ok) onAdvance();
    } finally {
      setBusy(false);
    }
  }, [onAdvance]);

  return (
    <div>
      <h2 className="mb-2 text-base font-semibold text-slate-800">Notifications</h2>
      <p className="mb-4 text-sm text-slate-600">
        How should the scraper deliver new jobs? Pick any combination — each
        channel runs independently. You can change this later by editing{' '}
        <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">~/.linkedin-jobs.env</code>
        {' '}or from the Crawler Config tab.
      </p>

      {/* The wizard owns its own combined Save-and-continue button at the
          bottom of the step, so suppress the per-channel Save buttons —
          Test connection is still surfaced inside the panel. */}
      <NotificationsConfigPanel
        ref={panelRef}
        showLocal
        showSaveButtons={false}
      />

      <div className="mt-5 flex justify-between gap-2">
        <BackButton onBack={onBack} />
        <button
          type="button"
          onClick={() => void onContinue()}
          disabled={busy}
          className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save & continue →'}
        </button>
      </div>
    </div>
  );
};
