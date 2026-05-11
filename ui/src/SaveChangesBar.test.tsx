// @vitest-environment jsdom
//
// Tests for the SaveChangesBar component.
//
// Scope: the BAR itself — dirty-driven visibility, the three callback
// wirings, Cmd-S / Ctrl-S keyboard shortcut, the "Saved ✓" flash, and
// the safe-area-inset class hook. The save logic that actually writes
// the config lives in ConfigPage's saveConfig and is exercised by
// existing tests; we deliberately stub it here so the bar is tested in
// isolation.
//
// jsdom (not happy-dom) because:
//   - Some assertions interact with rerender + RAF + setTimeout in
//     ways that happy-dom's deferred microtask scheduling makes flaky.
//   - We don't talk HTTP here, so the MSW caveat doesn't apply; we
//     still pick jsdom to keep timer behavior boringly deterministic.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { SaveChangesBar } from './SaveChangesBar';

const noop = () => undefined;

describe('SaveChangesBar', () => {
  it('renders nothing when the form is clean', () => {
    render(
      <SaveChangesBar
        dirty={false}
        saving={false}
        onSave={noop}
        onDiscard={noop}
        onResetDefaults={noop}
      />,
    );
    expect(screen.queryByTestId('save-changes-bar')).not.toBeInTheDocument();
  });

  it('appears when dirty flips true', () => {
    const { rerender } = render(
      <SaveChangesBar
        dirty={false}
        saving={false}
        onSave={noop}
        onDiscard={noop}
        onResetDefaults={noop}
      />,
    );
    expect(screen.queryByTestId('save-changes-bar')).not.toBeInTheDocument();

    rerender(
      <SaveChangesBar
        dirty={true}
        saving={false}
        onSave={noop}
        onDiscard={noop}
        onResetDefaults={noop}
      />,
    );
    const bar = screen.getByTestId('save-changes-bar');
    expect(bar).toBeInTheDocument();
    // a11y attrs — these are the contract with assistive tech.
    expect(bar).toHaveAttribute('role', 'region');
    expect(bar).toHaveAttribute('aria-label', 'Unsaved changes');
    expect(bar).toHaveAttribute('aria-keyshortcuts', 'Meta+S Control+S');
  });

  it('applies the safe-area-inset class hook so it clears the iOS home indicator', () => {
    // happy-dom / jsdom can't compute env(safe-area-inset-bottom), but
    // they CAN verify the class hook is on the node so a real browser
    // will pick up the inline padding-bottom: max(env(...), 12px).
    render(
      <SaveChangesBar
        dirty={true}
        saving={false}
        onSave={noop}
        onDiscard={noop}
        onResetDefaults={noop}
      />,
    );
    const bar = screen.getByTestId('save-changes-bar');
    // jsdom's CSSOM REJECTS `max(env(safe-area-inset-bottom), 12px)`
    // and silently drops the property — `style.paddingBottom` comes
    // back empty even though React set it. So we can't verify the
    // computed inline style here; the class hook is the
    // jsdom-survivable contract per the task brief ("jsdom can't
    // compute env() but can verify the class is there"). A real
    // browser DOES apply the padding — manual mobile emulation
    // verifies that side.
    expect(bar).toHaveClass('save-changes-bar--safe-area');
  });

  it('clicking Save calls onSave, shows the "Saved ✓" flash, then hides when dirty flips false', async () => {
    vi.useFakeTimers();
    try {
      const onSave = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
      const { rerender } = render(
        <SaveChangesBar
          dirty={true}
          saving={false}
          onSave={onSave}
          onDiscard={noop}
          onResetDefaults={noop}
        />,
      );

      // Click Save; await the promise resolution before assertions.
      const btn = screen.getByTestId('save-changes-bar-save');
      await act(async () => {
        fireEvent.click(btn);
        // Let the await onSave() microtask resolve.
        await Promise.resolve();
      });
      expect(onSave).toHaveBeenCalledTimes(1);

      // The flash should be visible immediately after the resolved save.
      expect(screen.getByText('Saved ✓')).toBeInTheDocument();

      // Parent flips dirty=false after its state catches up. The bar
      // should run the exit animation, then unmount once the timer
      // fires (~150ms).
      rerender(
        <SaveChangesBar
          dirty={false}
          saving={false}
          onSave={onSave}
          onDiscard={noop}
          onResetDefaults={noop}
        />,
      );
      // After the exit-animation timer fires, the bar is gone.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(screen.queryByTestId('save-changes-bar')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clicking Discard calls onDiscard; bar hides once parent flips dirty=false', async () => {
    vi.useFakeTimers();
    try {
      const onDiscard = vi.fn();
      const { rerender } = render(
        <SaveChangesBar
          dirty={true}
          saving={false}
          onSave={noop}
          onDiscard={onDiscard}
          onResetDefaults={noop}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: /Discard/i }));
      expect(onDiscard).toHaveBeenCalledTimes(1);

      // Parent rolls back the draft so dirty flips false.
      rerender(
        <SaveChangesBar
          dirty={false}
          saving={false}
          onSave={noop}
          onDiscard={onDiscard}
          onResetDefaults={noop}
        />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(screen.queryByTestId('save-changes-bar')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Cmd-S triggers save when dirty', async () => {
    const onSave = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    render(
      <SaveChangesBar
        dirty={true}
        saving={false}
        onSave={onSave}
        onDiscard={noop}
        onResetDefaults={noop}
      />,
    );

    await act(async () => {
      // Cmd on macOS == metaKey. Lowercase 's' is what browsers send
      // for the keydown 'key' field even when Caps Lock is off.
      const ev = new KeyboardEvent('keydown', {
        key: 's',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(ev);
      await Promise.resolve();
    });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('Ctrl-S triggers save when dirty', async () => {
    const onSave = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    render(
      <SaveChangesBar
        dirty={true}
        saving={false}
        onSave={onSave}
        onDiscard={noop}
        onResetDefaults={noop}
      />,
    );

    await act(async () => {
      const ev = new KeyboardEvent('keydown', {
        key: 's',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(ev);
      await Promise.resolve();
    });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('Cmd-S is a no-op when the form is clean (lets the browser default through)', async () => {
    const onSave = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    render(
      <SaveChangesBar
        dirty={false}
        saving={false}
        onSave={onSave}
        onDiscard={noop}
        onResetDefaults={noop}
      />,
    );

    const ev = new KeyboardEvent('keydown', {
      key: 's',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(ev);
    await Promise.resolve();
    expect(onSave).not.toHaveBeenCalled();
    // Critically: we did NOT call preventDefault, so the browser's
    // Save Page As shortcut would still run.
    expect(ev.defaultPrevented).toBe(false);
  });

  it('Cmd-S is a no-op while a save is already in flight', async () => {
    const onSave = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    render(
      <SaveChangesBar
        dirty={true}
        saving={true}
        onSave={onSave}
        onDiscard={noop}
        onResetDefaults={noop}
      />,
    );

    const ev = new KeyboardEvent('keydown', {
      key: 's',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(ev);
    await Promise.resolve();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('Cmd-Shift-S is left alone (conventionally "Save As")', async () => {
    const onSave = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    render(
      <SaveChangesBar
        dirty={true}
        saving={false}
        onSave={onSave}
        onDiscard={noop}
        onResetDefaults={noop}
      />,
    );

    const ev = new KeyboardEvent('keydown', {
      key: 'S',
      metaKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(ev);
    await Promise.resolve();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('Save button shows "Saving…" while saving=true', () => {
    render(
      <SaveChangesBar
        dirty={true}
        saving={true}
        onSave={noop}
        onDiscard={noop}
        onResetDefaults={noop}
      />,
    );
    expect(screen.getByText('Saving…')).toBeInTheDocument();
  });
});
