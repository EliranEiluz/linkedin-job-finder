// @vitest-environment jsdom
//
// Tests for ConfigSection — the responsive wrapper that switches
// between desktop-mode (one section visible at a time, no accordion
// chrome) and mobile-mode (collapsible accordion with localStorage
// persistence) per #117.
//
// What we cover:
//   1. Mobile + active=false still renders the accordion (the user can
//      manually expand any section on mobile — `active` is desktop-only).
//   2. Desktop + active=false renders NOTHING (the parent's sub-nav is
//      the source of truth there).
//   3. Mobile accordion default-open state matches ACCORDION_DEFAULT_OPEN.
//   4. Mobile accordion persists open/closed state to localStorage under
//      `crawler_config_section_open_<id>` so reloads remember.

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfigSection } from './ConfigSection';
import { CONFIG_SECTIONS, sectionAccordionLsKey } from './types';

beforeEach(() => {
  window.localStorage.clear();
});

describe('ConfigSection', () => {
  it('desktop: renders nothing when not active', () => {
    const { container } = render(
      <ConfigSection meta={CONFIG_SECTIONS[1]} mobile={false} active={false}>
        <p>pipeline body</p>
      </ConfigSection>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('desktop: renders the body when active', () => {
    render(
      <ConfigSection meta={CONFIG_SECTIONS[1]} mobile={false} active>
        <p>pipeline body</p>
      </ConfigSection>,
    );
    expect(screen.getByText('pipeline body')).toBeInTheDocument();
    // Desktop subtitle paragraph renders directly under the heading.
    expect(screen.getByText(CONFIG_SECTIONS[1].subtitle)).toBeInTheDocument();
  });

  it('mobile: renders the accordion regardless of `active`', () => {
    render(
      <ConfigSection meta={CONFIG_SECTIONS[0]} mobile active={false}>
        <p>run body</p>
      </ConfigSection>,
    );
    // Run & Infra defaults to open on mobile.
    expect(screen.getByText('run body')).toBeInTheDocument();
  });

  it('mobile: AI Pipeline section defaults to closed on first visit', () => {
    render(
      <ConfigSection meta={CONFIG_SECTIONS[1]} mobile active={false}>
        <p>pipeline body</p>
      </ConfigSection>,
    );
    expect(screen.queryByText('pipeline body')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /AI Pipeline/i }));
    expect(screen.getByText('pipeline body')).toBeInTheDocument();
  });

  it('mobile: persists open/closed state to localStorage', () => {
    const { unmount } = render(
      <ConfigSection meta={CONFIG_SECTIONS[2]} mobile active={false}>
        <p>search body</p>
      </ConfigSection>,
    );
    // Search Shape defaults closed.
    expect(screen.queryByText('search body')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Search Shape/i }));
    expect(window.localStorage.getItem(sectionAccordionLsKey('search')))
      .toBe('true');
    unmount();
    // Remount — should pick up the persisted "open" state.
    render(
      <ConfigSection meta={CONFIG_SECTIONS[2]} mobile active={false}>
        <p>search body</p>
      </ConfigSection>,
    );
    expect(screen.getByText('search body')).toBeInTheDocument();
  });
});
