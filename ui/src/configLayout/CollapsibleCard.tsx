// Shared collapsible card chrome for the Crawler Config tab. Lifted out
// of ConfigPage.tsx so the new sub-section wrappers (Run & Infra / AI
// Pipeline / Search Shape) can compose the same rounded-white card style
// without re-implementing the header-row affordance every time.
//
// Anti-pattern the SMTP/Telegram panel hit pre-#117 and what this fixes:
//   The "Enable Email" checkbox doubled as the show-hide chevron for the
//   credentials form. Unticking enable was the only way to collapse the
//   form, which conflated "I don't want this channel" with "I just want
//   to hide the form". This component separates the two concerns:
//
//     - `open` / `defaultOpen` / `onOpenChange` control VISIBILITY only.
//     - `right` slot is reserved for status chips / summary / dirty dot.
//     - The chevron lives in the header row and is purely a collapse
//       affordance. Cards that ALSO have an enable concept (e.g. corpus
//       filter) keep their enable control INSIDE the body, never on the
//       header.
//
// Other polish baked in (per task #117's micro-UX list):
//   - The ENTIRE header row is the click target — not just the chevron.
//   - Hover state on the whole header row.
//   - Keyboard nav: Space / Enter toggles; tab moves focus through the
//     header button before any inner controls.
//   - Visible focus ring (focus-visible:ring-2 brand-300).
//   - Animation timing: 150ms ease for the rotate; CSS grid-rows trick
//     for the height collapse so we don't need any JS height
//     measurement. The grid-rows transition is 180ms — still inside the
//     "snappy" 150-200ms band the brief asked for.
//   - `summary` slot: rendered ONLY when collapsed, on the right side of
//     the header. Lets sub-section headers show "3 channels enabled" /
//     "Auto, gpt-4o-mini" / "12 categories" without opening the card.
//   - `dirty` dot: tiny brand-700 dot next to the title when the section
//     has unsaved input changes. Mirrors the bottom Save bar's enabled
//     state, but scoped per-card so the user sees which section is
//     dirty at a glance.
//   - `subtitle`: optional one-sentence inline help under the title.
//   - LocalStorage persistence: pass `persistKey` and the open/closed
//     state survives page reloads. Default opens are still honored on
//     the FIRST visit (when no key has been written yet).

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import clsx from 'clsx';

export interface CollapsibleCardProps {
  title: string;
  /** Optional one-sentence helper text shown directly under the title. */
  subtitle?: string;
  /** Controlled open state. Omit to let the card manage its own. */
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (next: boolean) => void;
  /** Right-of-title slot (always rendered). Used for status chips. */
  right?: React.ReactNode;
  /**
   * Summary chip rendered to the RIGHT of `right` ONLY when the card is
   * collapsed. Use this for "N items / configured / off" style hints —
   * once the card is open, the body conveys the same info and the chip
   * becomes redundant.
   */
  summary?: React.ReactNode;
  /** Renders a tiny brand-700 dot next to the title. Use for unsaved-input state. */
  dirty?: boolean;
  /**
   * Persist the open/closed state to localStorage under
   * `crawler_config_card_open_<persistKey>`. First visit honors
   * `defaultOpen`; subsequent visits read the saved value.
   */
  persistKey?: string;
  children: React.ReactNode;
  /** Extra classes on the outer <section>. */
  className?: string;
}

const lsKey = (id: string) => `crawler_config_card_open_${id}`;

const readPersisted = (id: string | undefined): boolean | null => {
  if (!id || typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(lsKey(id));
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch {
    /* localStorage blocked — silently fall back to defaultOpen */
  }
  return null;
};

const writePersisted = (id: string | undefined, value: boolean): void => {
  if (!id || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(lsKey(id), value ? 'true' : 'false');
  } catch {
    /* quota / private mode — silent */
  }
};

export const CollapsibleCard = ({
  title,
  subtitle,
  open: controlledOpen,
  defaultOpen = true,
  onOpenChange,
  right,
  summary,
  dirty = false,
  persistKey,
  children,
  className,
}: CollapsibleCardProps) => {
  // Resolve initial state once: controlled wins; otherwise localStorage
  // (if persistKey is set); otherwise defaultOpen. Re-resolving on every
  // render would clobber user toggles.
  const initialRef = useRef<boolean>(
    controlledOpen ?? readPersisted(persistKey) ?? defaultOpen,
  );
  const [innerOpen, setInnerOpen] = useState<boolean>(initialRef.current);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : innerOpen;

  const bodyId = useId();

  const toggle = useCallback(() => {
    const next = !open;
    if (!isControlled) setInnerOpen(next);
    writePersisted(persistKey, next);
    onOpenChange?.(next);
  }, [open, isControlled, persistKey, onOpenChange]);

  // Keyboard: Space + Enter both toggle the header. The native <button>
  // already handles Enter; we also catch Space for parity with the
  // ARIA-recommended treatment of expanding regions.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        toggle();
      }
    },
    [toggle],
  );

  // Sync controlled prop into innerOpen when parent flips it back.
  useEffect(() => {
    if (isControlled) setInnerOpen(controlledOpen);
  }, [isControlled, controlledOpen]);

  return (
    <section
      className={clsx(
        'rounded-lg border border-slate-200 bg-white shadow-sm',
        // Scroll-margin so iOS doesn't anchor a focused input at the very
        // top of the viewport (under the sticky tab nav). 64px clears the
        // App tab strip + a hair of breathing room.
        'scroll-mt-16',
        className,
      )}
    >
      {/* Header row. The CLICK TARGET is a button that covers the full
          row (left half = chevron + title); the right slot is rendered
          OUTSIDE that button so it can host its own interactive
          controls (e.g. a refresh button) without nesting a <button>
          inside a <button> — which the HTML parser disallows and
          React DOM warns about. The two siblings sit in a flex row;
          the button stretches via flex-1 so a click anywhere on its
          area expands the card. */}
      <div
        className={clsx(
          'flex min-h-[44px] w-full items-center gap-3 rounded-t-lg pr-4 transition-colors duration-150',
          'hover:bg-slate-50 focus-within:bg-slate-50',
          !open && 'rounded-b-lg',
        )}
      >
        <button
          type="button"
          onClick={toggle}
          onKeyDown={onKeyDown}
          aria-expanded={open}
          aria-controls={bodyId}
          className={clsx(
            'group flex flex-1 items-center gap-3 self-stretch rounded-t-lg px-4 py-3 text-left',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-300',
            !open && 'rounded-b-lg',
          )}
        >
          {/* Chevron — rotates 90deg with a 150ms ease. */}
          <span
            aria-hidden="true"
            className={clsx(
              'inline-block text-slate-400 transition-transform duration-150 ease-out',
              open ? 'rotate-90' : 'rotate-0',
            )}
          >
            ▶
          </span>
          <h2 className="flex flex-1 items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-600">
            {title}
            {dirty && (
              <span
                aria-label="Unsaved changes"
                title="Unsaved changes in this section"
                className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-brand-700"
              />
            )}
          </h2>
          {/* Summary chip: collapsed-only. Lives inside the click area
              so a tap on the chip toggles the section too. */}
          {!open && summary && (
            <span className="inline-flex items-center">{summary}</span>
          )}
        </button>
        {/* Right slot: status chips, refresh button, etc. — always
            visible. Rendered as a SIBLING of the header button so any
            interactive content it carries is valid HTML and doesn't
            need its own stopPropagation. */}
        {right && (
          <span className="inline-flex items-center gap-2">{right}</span>
        )}
      </div>
      {subtitle && open && (
        <p className="px-4 -mt-1 pb-2 text-xs text-slate-500">{subtitle}</p>
      )}
      {/* Body. CSS-grid-rows transition for the collapse animation —
          duration ~180ms keeps it inside the 150-200ms band. The inner
          wrapper is what we measure; min-h-0 + overflow-hidden lets the
          grid clip cleanly without measuring height in JS. */}
      <div
        id={bodyId}
        role="region"
        aria-label={title}
        className={clsx(
          'grid transition-[grid-template-rows] duration-150 ease-out motion-reduce:transition-none',
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div className="overflow-hidden">
          {open && (
            <div className="border-t border-slate-100 p-4">{children}</div>
          )}
        </div>
      </div>
    </section>
  );
};
