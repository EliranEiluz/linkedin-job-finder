// @vitest-environment jsdom
//
// Tests for <JobActionsPopover /> — specifically the pin / unpin
// affordance added for issue #124. The component already has implicit
// coverage via JobsTable integration; this file focuses on the new
// pin button's label-flip + onTogglePin wiring.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JobActionsPopover } from './JobActionsPopover';
import type { Job } from './types';
import { useRef } from 'react';

const makeJob = (overrides: Partial<Job> = {}): Job => ({
  id: 'job-1',
  title: 'Senior SWE',
  company: 'Acme',
  location: 'Remote',
  url: 'https://example.com/job-1',
  query: 'engineer',
  category: 'keyword',
  found_at: '2026-05-01T10:00:00Z',
  priority: false,
  msc_required: null,
  fit: 'good',
  score: 8,
  fit_reasons: [],
  scored_by: 'claude',
  source: 'guest',
  ...overrides,
});

// Wrapper that supplies the anchorRef so we don't have to fake it in
// every test. We also stub the floating-popover positioning by providing
// a non-null anchor element via a wrapping <button>.
const Harness = (props: {
  isPinned: boolean;
  onTogglePin?: (id: string, pinned: boolean) => void;
  onRate?: (
    id: string,
    rating: number | null,
    comment?: string | null,
  ) => Promise<{ ok: boolean; error?: string }>;
}) => {
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={anchorRef} type="button">anchor</button>
      <JobActionsPopover
        job={makeJob()}
        isApplied={false}
        onApply={() => undefined}
        onUnapply={() => undefined}
        applyMovesToEnd={null}
        onSetApplyPref={() => undefined}
        onRate={props.onRate ?? (() => Promise.resolve({ ok: true }))}
        onDelete={() => Promise.resolve({ ok: true })}
        isPinned={props.isPinned}
        onTogglePin={props.onTogglePin}
        anchorRef={anchorRef}
        onClose={() => undefined}
      />
    </>
  );
};

describe('JobActionsPopover — pin/unpin (#124)', () => {
  beforeEach(() => {
    // Force desktop viewport so the popover renders the floating variant
    // rather than the bottom-sheet (we don't care about layout here).
    Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true });
    // jsdom doesn't ship a matchMedia implementation. useViewport.ts wires
    // it as the source of truth for the desktop/mobile branch — stub it
    // to "always desktop" so the popover renders its floating variant.
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
    window.dispatchEvent(new Event('resize'));
  });
  afterEach(() => {
    cleanup();
  });

  it('shows "Pin as example" when isPinned=false', () => {
    render(<Harness isPinned={false} onTogglePin={() => undefined} />);
    expect(screen.getByText(/Pin as example/i)).toBeInTheDocument();
    // Unpin label must NOT also be present.
    expect(screen.queryByText(/Unpin example/i)).not.toBeInTheDocument();
  });

  it('shows "Unpin example" when isPinned=true', () => {
    render(<Harness isPinned={true} onTogglePin={() => undefined} />);
    expect(screen.getByText(/Unpin example/i)).toBeInTheDocument();
    expect(screen.queryByText(/Pin as example/i)).not.toBeInTheDocument();
  });

  it('clicking "Pin as example" calls onTogglePin(id, true)', async () => {
    const onTogglePin = vi.fn();
    const user = userEvent.setup();
    render(<Harness isPinned={false} onTogglePin={onTogglePin} />);

    await user.click(screen.getByText(/Pin as example/i));
    expect(onTogglePin).toHaveBeenCalledTimes(1);
    expect(onTogglePin).toHaveBeenCalledWith('job-1', true);
  });

  it('clicking "Unpin example" calls onTogglePin(id, false)', async () => {
    const onTogglePin = vi.fn();
    const user = userEvent.setup();
    render(<Harness isPinned={true} onTogglePin={onTogglePin} />);

    await user.click(screen.getByText(/Unpin example/i));
    expect(onTogglePin).toHaveBeenCalledTimes(1);
    expect(onTogglePin).toHaveBeenCalledWith('job-1', false);
  });

  it('hides the affordance entirely when onTogglePin is undefined', () => {
    render(<Harness isPinned={false} />);
    expect(screen.queryByText(/Pin as example/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Unpin example/i)).not.toBeInTheDocument();
  });
});
