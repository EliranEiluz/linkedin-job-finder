// @vitest-environment jsdom
//
// Tests for <LLMProviderCard /> — the wrapper that lives in the Crawler
// Config tab between SchedulerCard and RemoteAccessCard. Covers:
//   1. surfaces the active provider name in the header chip
//   2. forwards the active name to the inner selector as
//      initialProviderName (asserted via aria-pressed)
//   3. bubbles a tested-green selection up via onChange, preserving the
//      model field when the user picks the same provider they already
//      had (so #114 has room to attach a model dropdown later)

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './__tests__/msw';
import { LLMProviderCard } from './LLMProviderCard';
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
      name: 'gemini',
      label: 'Google Gemini',
      needs_key: true,
      free_tier: true,
      env_var: 'GEMINI_API_KEY',
      help_url: 'https://aistudio.google.com/apikey',
      blurb: 'Google Gemini, free tier.',
    },
  ],
};

const listHandler = http.get('/api/llm/list', () => HttpResponse.json(listFixture));

describe('LLMProviderCard', () => {
  it('shows the active provider in the header chip', () => {
    server.use(listHandler);
    render(
      <LLMProviderCard
        current={{ name: 'gemini' }}
        onChange={() => undefined}
      />,
    );
    expect(screen.getByTestId('llm-provider-current')).toHaveTextContent(
      'Active: Google Gemini',
    );
  });

  it('falls back to "Auto-detect" when no provider is set', () => {
    server.use(listHandler);
    render(<LLMProviderCard current={undefined} onChange={() => undefined} />);
    expect(screen.getByTestId('llm-provider-current')).toHaveTextContent(
      'Active: Auto-detect',
    );
  });

  it('passes the current name through to the selector as the highlighted tile', async () => {
    server.use(listHandler);
    render(
      <LLMProviderCard
        current={{ name: 'gemini' }}
        onChange={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Select Google Gemini' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
  });

  it('bubbles a tested-green selection up via onChange', async () => {
    server.use(
      listHandler,
      http.post('/api/llm/test', () =>
        HttpResponse.json({ ok: true, message: 'claude ready' }),
      ),
    );
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <LLMProviderCard
        current={{ name: 'gemini' }}
        onChange={onChange}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('Claude Code (CLI)')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Select Claude Code (CLI)' }));
    await user.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ name: 'claude_cli' });
    });
  });

  it('preserves the model field when the user re-tests the same provider', async () => {
    // Same provider name + model already set → onChange should keep the
    // model so a future model-picker (task #114) can read it. Different
    // provider name → model drops to undefined (provider default).
    server.use(
      listHandler,
      http.post('/api/llm/test', () => HttpResponse.json({ ok: true })),
    );
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <LLMProviderCard
        current={{ name: 'claude_cli', model: 'claude-sonnet-4-5' }}
        onChange={onChange}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('Claude Code (CLI)')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Select Claude Code (CLI)' }));
    await user.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({
        name: 'claude_cli',
        model: 'claude-sonnet-4-5',
      });
    });
  });
});
