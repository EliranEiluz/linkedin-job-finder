import clsx from 'clsx';

// Small inline semantic dot used as a colored prefix for status/fit labels.
// Replaces the old emoji+colored-bg badge pattern (🔐 🌐 ✅ ❌ ⏸ etc.).
// The badge wrapper around the dot is neutral — the dot is the only color.
//
// Sizes:
//   xs = h-1.5 w-1.5 (6px) — default, used inside table chips
//   sm = h-2 w-2  (8px)    — slightly bigger for headline summary numbers
//
// Usage:
//   <Dot color="good" /> good
//   <Dot color="bad" />  Not installed

export type DotColor = 'good' | 'warn' | 'bad' | 'neutral' | 'brand';

const COLOR_CLASS: Record<DotColor, string> = {
  good: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-red-500',
  // `neutral` = a quiet slate dot; used for "skip", "unscored", "guest", etc.
  // The shade is intentionally lighter than warn/bad/good so it reads as
  // "muted/unspecified" rather than "alert".
  neutral: 'bg-slate-400',
  brand: 'bg-brand-700',
};

export const Dot = ({
  color,
  size = 'xs',
  className,
}: {
  color: DotColor;
  size?: 'xs' | 'sm';
  className?: string;
}) => (
  <span
    className={clsx(
      'inline-block shrink-0 rounded-full align-middle',
      size === 'xs' ? 'h-1.5 w-1.5' : 'h-2 w-2',
      COLOR_CLASS[color],
      className,
    )}
    aria-hidden="true"
  />
);
