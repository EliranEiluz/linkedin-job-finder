// @vitest-environment jsdom
//
// Tests for ConfigSubNav, the desktop-only left-rail switcher between
// the Run & Infra / AI Pipeline / Search Shape sub-sections (#117).
//
// What we cover:
//   1. Clicking a row fires onChange with that section's id.
//   2. The active row has aria-current="page" so screen readers can
//      announce it.
//   3. Dirty dots render per-section when the parent says so.
//   4. Summary chips render per-section when the parent passes them.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfigSubNav } from './ConfigSubNav';

describe('ConfigSubNav', () => {
  it('marks the active row with aria-current=page', () => {
    render(<ConfigSubNav active="pipeline" onChange={() => undefined} />);
    const activeRow = screen.getByRole('button', { name: /AI Pipeline/i });
    expect(activeRow).toHaveAttribute('aria-current', 'page');
    const inactiveRow = screen.getByRole('button', { name: /Run & Infra/i });
    expect(inactiveRow).not.toHaveAttribute('aria-current');
  });

  it('fires onChange with the row id when clicked', () => {
    const onChange = vi.fn();
    render(<ConfigSubNav active="run" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Search Shape/i }));
    expect(onChange).toHaveBeenCalledWith('search');
  });

  it('renders a dirty dot next to a section when dirty[id] is true', () => {
    render(
      <ConfigSubNav
        active="run"
        onChange={() => undefined}
        dirty={{ pipeline: true, search: false }}
      />,
    );
    // The dirty dot uses aria-label="Unsaved changes" — we want exactly
    // one (pipeline) to render.
    expect(screen.getAllByLabelText('Unsaved changes')).toHaveLength(1);
  });

  it('renders a summary chip next to a section when provided', () => {
    render(
      <ConfigSubNav
        active="run"
        onChange={() => undefined}
        summaries={{
          pipeline: <span data-testid="pipeline-chip">Auto</span>,
        }}
      />,
    );
    expect(screen.getByTestId('pipeline-chip')).toBeInTheDocument();
  });
});
