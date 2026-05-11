// @vitest-environment jsdom
//
// Unit tests for the shared <LLMProviderSelector />. Covers:
//   1. fetches /api/llm/list on mount and renders a tile per provider
//   2. needs_key=false provider (claude_cli) shows a "Test connection"
//      button, hits /api/llm/test, and fires onTestSuccess with the name
//   3. needs_key=true provider (gemini) shows an API-key input + "Save &
//      test" button, posts to /api/llm/save-credential then /api/llm/test,
//      and fires onTestSuccess
//   4. failed test renders an inline error and does NOT fire onTestSuccess
//   5. the `initialProviderName` prop highlights the matching tile
//
// jsdom (not happy-dom) because the component calls `res.json()` — see
// __tests__/msw.ts for the happy-dom + MSW v2 stream interop bug.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './__tests__/msw';
import { LLMProviderSelector } from './LLMProviderSelector';
import type { LLMListResponse } from './llmApi';

beforeAll(() => { server.listen({ onUnhandledRequest: 'error' }); });
afterEach(() => { server.resetHandlers(); });
afterAll(() => { server.close(); });

const listFixture: LLMListResponse = {
  ok: true,
  providers: [
    {
      name: 'claude_cli',
      label: 'Claude Code (CLI)',
      needs_key: false,
      free_tier: false,
      env_var: null,
      help_url: 'https://docs.claude.com/claude-code',
      blurb: 'Uses the local `claude` CLI.',
    },
    {
      name: 'claude_sdk',
      label: 'Claude API (key)',
      needs_key: true,
      free_tier: false,
      env_var: 'ANTHROPIC_API_KEY',
      help_url: 'https://console.anthropic.com/settings/keys',
      blurb: 'Direct Anthropic API.',
    },
    {
      name: 'gemini',
      label: 'Google Gemini',
      needs_key: true,
      free_tier: true,
      env_var: 'GEMINI_API_KEY',
      help_url: 'https://aistudio.google.com/apikey',
      blurb: 'Google Gemini, free tier available.',
    },
    {
      name: 'ollama',
      label: 'Ollama (local)',
      needs_key: false,
      free_tier: true,
      env_var: null,
      help_url: 'https://ollama.com/download',
      blurb: 'Local model.',
    },
  ],
};

const listHandler = http.get('/api/llm/list', () => HttpResponse.json(listFixture));

describe('LLMProviderSelector', () => {
  it('fetches the provider list on mount and renders a tile per provider', async () => {
    server.use(listHandler);
    render(<LLMProviderSelector onTestSuccess={() => undefined} />);

    // claude_cli must be first-class (user is on a Claude.ai subscription,
    // not an API key). Verify the tile is present alongside the others.
    await waitFor(() => {
      expect(screen.getByText('Claude Code (CLI)')).toBeInTheDocument();
    });
    expect(screen.getByText('Claude API (key)')).toBeInTheDocument();
    expect(screen.getByText('Google Gemini')).toBeInTheDocument();
    expect(screen.getByText('Ollama (local)')).toBeInTheDocument();
  });

  it('renders a "Test connection" button for keyless providers and fires onTestSuccess on green', async () => {
    server.use(
      listHandler,
      http.post('/api/llm/test', async ({ request }) => {
        const body = (await request.json()) as { name?: string };
        expect(body.name).toBe('claude_cli');
        return HttpResponse.json({ ok: true, message: 'claude --version: 1.2.3' });
      }),
    );
    const onTestSuccess = vi.fn();
    const user = userEvent.setup();
    render(<LLMProviderSelector onTestSuccess={onTestSuccess} />);

    await waitFor(() => {
      expect(screen.getByText('Claude Code (CLI)')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Select Claude Code (CLI)' }));
    // Keyless flow: no API-key input renders.
    expect(screen.queryByLabelText(/API key/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => {
      expect(onTestSuccess).toHaveBeenCalledWith('claude_cli');
    });
    expect(screen.getByText(/Connected — claude --version/)).toBeInTheDocument();
  });

  it('renders an API-key input for keyed providers and posts save-credential then test', async () => {
    const saveSpy = vi.fn();
    server.use(
      listHandler,
      http.post('/api/llm/save-credential', async ({ request }) => {
        const body = (await request.json()) as { name?: string; key?: string };
        saveSpy(body);
        return HttpResponse.json({ ok: true, env_var: 'GEMINI_API_KEY' });
      }),
      http.post('/api/llm/test', () =>
        HttpResponse.json({ ok: true, message: 'gemini-1.5-flash ready' }),
      ),
    );
    const onTestSuccess = vi.fn();
    const user = userEvent.setup();
    render(<LLMProviderSelector onTestSuccess={onTestSuccess} />);

    await waitFor(() => {
      expect(screen.getByText('Google Gemini')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Select Google Gemini' }));

    const keyInput = screen.getByLabelText('Google Gemini API key');
    await user.type(keyInput, 'AIzaTESTKEY123');
    await user.click(screen.getByRole('button', { name: 'Save & test' }));

    await waitFor(() => {
      expect(onTestSuccess).toHaveBeenCalledWith('gemini');
    });
    expect(saveSpy).toHaveBeenCalledWith({ name: 'gemini', key: 'AIzaTESTKEY123' });
    // Key input is cleared after a green save.
    expect(screen.getByLabelText('Google Gemini API key')).toHaveValue('');
  });

  it('surfaces an inline error and does not fire onTestSuccess when the test fails', async () => {
    server.use(
      listHandler,
      http.post('/api/llm/test', () =>
        HttpResponse.json({ ok: false, message: 'claude not installed' }),
      ),
    );
    const onTestSuccess = vi.fn();
    const user = userEvent.setup();
    render(<LLMProviderSelector onTestSuccess={onTestSuccess} />);

    await waitFor(() => {
      expect(screen.getByText('Claude Code (CLI)')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Select Claude Code (CLI)' }));
    await user.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('claude not installed');
    });
    expect(onTestSuccess).not.toHaveBeenCalled();
  });

  it('highlights the initialProviderName tile via aria-pressed', async () => {
    server.use(listHandler);
    render(
      <LLMProviderSelector
        initialProviderName="gemini"
        onTestSuccess={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Select Google Gemini' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
    // The other tiles stay unpressed.
    expect(screen.getByRole('button', { name: 'Select Claude Code (CLI)' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('reserves a model-picker slot for task #114', async () => {
    server.use(listHandler);
    const user = userEvent.setup();
    render(<LLMProviderSelector onTestSuccess={() => undefined} />);

    await waitFor(() => {
      expect(screen.getByText('Claude Code (CLI)')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Select Claude Code (CLI)' }));

    // The empty <div data-slot="model-picker" /> placeholder is part of
    // the contract — task #114 will mount a dropdown into it without
    // having to reflow the surrounding layout.
    const slot = document.querySelector('[data-slot="model-picker"]');
    expect(slot).not.toBeNull();
  });
});
