// @vitest-environment jsdom
//
// Tests for the shared CollapsibleCard used across the Crawler Config
// sub-section wrappers (#117). The two behaviors that this card is
// load-bearing for:
//
//   1. The ENTIRE header row is the click target (not just a chevron).
//      Clicking anywhere on the header — title text, chevron area —
//      toggles the open state. Space + Enter on the focused header
//      button also toggle (keyboard a11y).
//   2. Summary slot only renders while collapsed; goes away as soon as
//      the card is open. The dirty dot is always visible.
//   3. LocalStorage persistence under `crawler_config_card_open_<key>`.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CollapsibleCard } from './CollapsibleCard';

beforeEach(() => {
  // Reset localStorage between tests so persistKey behavior is isolated.
  window.localStorage.clear();
});

describe('CollapsibleCard', () => {
  it('toggles open state when the user clicks the header', () => {
    render(
      <CollapsibleCard title="Section A" defaultOpen={false}>
        <p>body</p>
      </CollapsibleCard>,
    );
    // Closed initially — body shouldn't be in the DOM. We use the title
    // as the header button's accessible name.
    expect(screen.queryByText('body')).not.toBeInTheDocument();
    const header = screen.getByRole('button', { name: /Section A/i });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(header);
    expect(screen.getByText('body')).toBeInTheDocument();
    expect(header).toHaveAttribute('aria-expanded', 'true');
  });

  it('toggles via the Space key on the focused header', () => {
    render(
      <CollapsibleCard title="Section B" defaultOpen={false}>
        <p>body</p>
      </CollapsibleCard>,
    );
    const header = screen.getByRole('button', { name: /Section B/i });
    header.focus();
    // Space is captured by the card's onKeyDown rather than the native
    // button's Enter handler — the brief explicitly required Space.
    fireEvent.keyDown(header, { key: ' ' });
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  it('renders summary chip only while collapsed', () => {
    render(
      <CollapsibleCard
        title="Section C"
        defaultOpen={false}
        summary={<span data-testid="chip">3 items</span>}
      >
        <p>body</p>
      </CollapsibleCard>,
    );
    expect(screen.getByTestId('chip')).toBeInTheDocument();
    // Open it — chip should disappear because the body now conveys the
    // same info.
    fireEvent.click(screen.getByRole('button', { name: /Section C/i }));
    expect(screen.queryByTestId('chip')).not.toBeInTheDocument();
  });

  it('renders the dirty dot when `dirty` is true regardless of open state', () => {
    const { rerender } = render(
      <CollapsibleCard title="Section D" defaultOpen={false} dirty>
        <p>body</p>
      </CollapsibleCard>,
    );
    expect(screen.getByLabelText('Unsaved changes')).toBeInTheDocument();
    // Open it — the dirty dot stays.
    rerender(
      <CollapsibleCard title="Section D" defaultOpen dirty>
        <p>body</p>
      </CollapsibleCard>,
    );
    expect(screen.getByLabelText('Unsaved changes')).toBeInTheDocument();
  });

  it('persists open/closed state to localStorage when persistKey is set', () => {
    const { unmount } = render(
      <CollapsibleCard title="Section E" defaultOpen={false} persistKey="sectionE">
        <p>body</p>
      </CollapsibleCard>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Section E/i }));
    // Confirm the LS key was written.
    expect(window.localStorage.getItem('crawler_config_card_open_sectionE'))
      .toBe('true');
    unmount();
    // Remount with defaultOpen=false — LS should win.
    render(
      <CollapsibleCard title="Section E" defaultOpen={false} persistKey="sectionE">
        <p>body</p>
      </CollapsibleCard>,
    );
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  it('does not propagate clicks on interactive content inside the right slot', () => {
    const onAction = vi.fn();
    render(
      <CollapsibleCard
        title="Section F"
        defaultOpen={false}
        right={
          <button type="button" onClick={onAction} data-testid="rb">
            refresh
          </button>
        }
      >
        <p>body</p>
      </CollapsibleCard>,
    );
    // Click the right-slot button — should fire onAction but NOT expand
    // the card.
    act(() => {
      fireEvent.click(screen.getByTestId('rb'));
    });
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('body')).not.toBeInTheDocument();
  });
});
