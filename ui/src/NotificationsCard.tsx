// Notifications card for the Crawler Config tab. Renders the shared
// NotificationsConfigPanel inside the standard card chrome used by
// SchedulerCard / RemoteAccessCard — rounded white section, uppercase
// tracking-wider slate-600 title.
//
// This card lets the user change Email (SMTP) and Telegram notification
// credentials AFTER onboarding. Before this card existed the only way to
// edit those was to re-run the welcome wizard or hand-edit
// ~/.linkedin-jobs.env. Issue #113.
//
// The panel itself owns the form state + the /api/notifications/* calls;
// this wrapper is purely presentational chrome. Per-channel Save buttons
// stay enabled (showSaveButtons defaults to true) — the wizard variant
// is the one that hides them.

import { NotificationsConfigPanel } from './NotificationsConfigPanel';

export const NotificationsCard = () => {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-600">
          Notifications
        </h2>
      </div>
      <p className="mb-3 text-xs text-slate-500">
        Where to deliver each scrape's digest. Email (SMTP) and Telegram are
        independent — enable either, both, or neither. With both off, the
        scraper still writes <code className="rounded bg-slate-100 px-1 py-0.5">digest.html</code>{' '}
        locally; the Run History tab surfaces it.
      </p>
      <NotificationsConfigPanel />
    </section>
  );
};
