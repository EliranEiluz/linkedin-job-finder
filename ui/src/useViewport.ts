import { useEffect, useState } from 'react';

/**
 * Reactive viewport hook gated on Tailwind's default `md` breakpoint (768px).
 *
 * Mirrors Tailwind's `md:` prefix: `isMobile` is true below 768px, false at
 * 768px and above. Hydrates synchronously from `window.innerWidth` on first
 * render so there's no SSR-style "flash of desktop layout" on mount (this is
 * a Vite SPA — no SSR — but the same pattern keeps the initial paint stable
 * across navigations).
 *
 * Subscribes to `window.matchMedia('(min-width: 768px)')` change events. No
 * resize listener — `matchMedia` only fires when the breakpoint is crossed,
 * which is what we want.
 */
const MD_BREAKPOINT_PX = 768;
const MQ = `(min-width: ${MD_BREAKPOINT_PX}px)`;

const readIsMobile = (): boolean => {
  if (typeof window === 'undefined') return false;
  return window.innerWidth < MD_BREAKPOINT_PX;
};

export const useViewport = (): { isMobile: boolean } => {
  const [isMobile, setIsMobile] = useState<boolean>(readIsMobile);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia(MQ);
    const onChange = (e: MediaQueryListEvent) => { setIsMobile(!e.matches); };
    // Sync once in case innerWidth shifted between the synchronous initial
    // render and this effect (e.g. responsive devtools toggled mid-mount).
    setIsMobile(!mql.matches);
    // MediaQueryList.addEventListener is supported back to Safari 14 — the
    // deprecated `addListener` fallback was kept around when the codebase
    // still cared about Safari 13 and below; not worth carrying anymore.
    mql.addEventListener('change', onChange);
    return () => { mql.removeEventListener('change', onChange); };
  }, []);

  return { isMobile };
};
