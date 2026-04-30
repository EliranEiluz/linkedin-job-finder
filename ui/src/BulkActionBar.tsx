import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';

interface Props {
  // Selected ids (page-visible only — selection is ephemeral table state).
  selectedCount: number;
  // Count of all rows currently passing the filters (visible + paginated).
  // Drives the "Delete all N filtered" right-side button label.
  filteredCount: number;
  // True when the active FilterState is non-default (computed in CorpusPage).
  hasFilter: boolean;
  // True when EVERY selected row is currently applied — controls whether
  // the "Mark unapplied" affordance renders.
  allSelectedApplied: boolean;
  onClear: () => void;
  onDeleteSelected: () => void;
  onApplySelected: () => void;
  onMarkUnappliedSelected: () => void;
  onDeleteAllFiltered: () => void;
}

/**
 * Bulk-action bar shown above JobsTable when the user has selected rows
 * OR a non-default filter is active. Centralises the multi-row mutations
 * (delete, apply, mark-unapplied) and the one-shot "Delete all N filtered"
 * affordance the user asked for.
 *
 * Visual: brand-50 background to read as a different "mode" from the table
 * body's white. Compact (1.5/3 padding) so it doesn't crowd the StatsBar.
 *
 * Delete actions follow the existing single-click-confirm pattern from the
 * row-level inline trash (4s window). "Delete all filtered" is gated by a
 * native confirm() because N can be 100+ and that's worth a system dialog.
 */
export const BulkActionBar = ({
  selectedCount, filteredCount, hasFilter, allSelectedApplied,
  onClear, onDeleteSelected, onApplySelected, onMarkUnappliedSelected,
  onDeleteAllFiltered,
}: Props) => {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const confirmTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (confirmTimerRef.current) window.clearTimeout(confirmTimerRef.current);
    },
    [],
  );

  const armDelete = () => {
    if (confirmDelete) {
      if (confirmTimerRef.current) {
        window.clearTimeout(confirmTimerRef.current);
        confirmTimerRef.current = null;
      }
      setConfirmDelete(false);
      onDeleteSelected();
      return;
    }
    setConfirmDelete(true);
    confirmTimerRef.current = window.setTimeout(() => {
      setConfirmDelete(false);
      confirmTimerRef.current = null;
    }, 4000);
  };

  const handleDeleteAllFiltered = () => {
    const n = filteredCount;
    if (n === 0) return;
    const ok = window.confirm(
      `Delete all ${n} jobs matching the current filter?\n\n` +
      `They'll be pinned in seen_jobs.json so they won't re-appear on the next scrape.`,
    );
    if (ok) onDeleteAllFiltered();
  };

  const hasSelection = selectedCount > 0;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-brand-100 bg-brand-50 px-3 py-2 text-xs">
      {hasSelection ? (
        <>
          <span className="font-medium text-slate-700">
            {selectedCount} selected
          </span>
          <button
            type="button"
            onClick={onClear}
            className="text-brand-700 hover:underline"
          >
            Clear
          </button>
          <span className="text-slate-300">·</span>
          <button
            type="button"
            onClick={armDelete}
            className={clsx(
              'inline-flex min-h-[28px] items-center rounded border px-2 py-0.5 text-xs font-medium transition-colors',
              confirmDelete
                ? 'border-red-600 bg-red-600 text-white hover:bg-red-700'
                : 'border-slate-300 bg-white text-slate-700 hover:bg-red-50 hover:text-red-700 hover:border-red-300',
            )}
            title={
              confirmDelete
                ? 'Click again to confirm permanent delete'
                : `Delete ${selectedCount} selected (pins in seen so they won't re-appear)`
            }
          >
            {confirmDelete ? 'Click again to confirm' : 'Delete selected'}
          </button>
          <button
            type="button"
            onClick={onApplySelected}
            className="inline-flex min-h-[28px] items-center rounded border border-emerald-600 bg-white px-2 py-0.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50"
            title={`Mark ${selectedCount} selected as applied`}
          >
            Apply selected
          </button>
          {allSelectedApplied && (
            <button
              type="button"
              onClick={onMarkUnappliedSelected}
              className="inline-flex min-h-[28px] items-center rounded border border-slate-300 bg-white px-2 py-0.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              title={`Mark ${selectedCount} selected as not applied`}
            >
              Mark unapplied
            </button>
          )}
        </>
      ) : (
        // Selection-empty state still renders the bar IFF a filter is active.
        // The left side becomes a quiet "filter is narrowing the view" hint;
        // the right side carries the delete-all-filtered button.
        <span className="text-slate-600">
          {filteredCount.toLocaleString()} jobs match the current filter
        </span>
      )}

      {/* Right-aligned: Delete all N filtered. Only renders when a filter is
          active (regardless of selection state). */}
      {hasFilter && filteredCount > 0 && (
        <button
          type="button"
          onClick={handleDeleteAllFiltered}
          className="ml-auto inline-flex min-h-[28px] items-center rounded border border-red-300 bg-white px-2 py-0.5 text-xs font-medium text-red-700 hover:bg-red-50"
          title={`Delete all ${filteredCount} jobs matching the current filter (pins in seen)`}
        >
          Delete all {filteredCount.toLocaleString()} filtered jobs
        </button>
      )}
    </div>
  );
};
