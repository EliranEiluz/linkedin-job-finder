// @vitest-environment jsdom
//
// Unit tests for the shared <LLMModelPicker /> (task #114). Covers:
//   1. fetches /api/llm/models?provider=X on mount once `enabled`
//   2. renders the right secondary control per `reasoning.shape`:
//       levels  -> select w/ off + declared levels
//       budget  -> number input + dynamic checkbox
//       boolean -> checkbox toggle
//       none    -> control hidden
//   3. search input appears only when the catalog has ≥20 entries
//   4. selecting a model fires onChange with the right payload (and
//      drops reasoning_effort so the next render uses the new model's
//      shape with a fresh default)
//   5. selecting an effort fires onChange with the SAME model + the
//      new effort
//   6. error / empty-list / disabled states each render their copy

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './__tests__/msw';
import { LLMModelPicker } from './LLMModelPicker';
import type { LLMModelsResponse, ModelInfo } from './llmApi';

beforeAll(() => { server.listen({ onUnhandledRequest: 'error' }); });
afterEach(() => { server.resetHandlers(); });
afterAll(() => { server.close(); });

// --- fixtures -------------------------------------------------------------

const levelsModel: ModelInfo = {
  id: 'claude-opus-4-7',
  display_name: 'Claude Opus 4.7',
  max_input_tokens: 200_000,
  max_output_tokens: 8192,
  reasoning: {
    supported: true,
    shape: 'levels',
    levels: ['low', 'medium', 'high'],
  },
};

const budgetModel: ModelInfo = {
  id: 'gemini-2.5-flash',
  display_name: 'Gemini 2.5 Flash',
  max_input_tokens: 1_000_000,
  max_output_tokens: 8_192,
  reasoning: {
    supported: true,
    shape: 'budget',
    budget_range: [0, 24_576],
  },
};

const booleanModel: ModelInfo = {
  id: 'qwen3:32b',
  display_name: 'qwen3:32b',
  max_input_tokens: null,
  max_output_tokens: null,
  reasoning: { supported: true, shape: 'boolean' },
};

const noneModel: ModelInfo = {
  id: 'gpt-4o-mini',
  display_name: 'gpt-4o-mini',
  max_input_tokens: null,
  max_output_tokens: null,
  reasoning: { supported: false, shape: 'none' },
};

const fixture = (models: ModelInfo[]): LLMModelsResponse => ({
  ok: true,
  provider: 'fake',
  models,
});

const handler = (models: ModelInfo[]) =>
  http.get('/api/llm/models', () => HttpResponse.json(fixture(models)));

// --- tests ---------------------------------------------------------------

describe('LLMModelPicker — shape-dependent rendering', () => {
  it('renders nothing when provider is undefined', () => {
    const { container } = render(
      <LLMModelPicker
        provider={undefined}
        value={undefined}
        reasoningEffort={undefined}
        onChange={() => undefined}
      />,
    );
    // No fetch fired (msw's onUnhandledRequest='error' would catch it)
    // and the picker rendered no DOM.
    expect(container.firstChild).toBeNull();
  });

  it('shows a disabled banner when `enabled` is false (credential missing)', () => {
    render(
      <LLMModelPicker
        provider="gemini"
        value={undefined}
        reasoningEffort={undefined}
        onChange={() => undefined}
        enabled={false}
      />,
    );
    expect(screen.getByText(/Save a credential first/i)).toBeInTheDocument();
  });

  it('renders the levels-shape control for a levels model', async () => {
    server.use(handler([levelsModel]));
    render(
      <LLMModelPicker
        provider="claude_cli"
        value="claude-opus-4-7"
        reasoningEffort="medium"
        onChange={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('llm-model-picker')).toBeInTheDocument();
    });
    // Secondary control is the levels variant.
    expect(screen.getByTestId('effort-levels')).toBeInTheDocument();
    expect(screen.queryByTestId('effort-budget')).not.toBeInTheDocument();
    expect(screen.queryByTestId('effort-boolean')).not.toBeInTheDocument();
    // It's a select with low/medium/high + the synthetic "off".
    // (tsc -b uses tsconfig.app which sees the HTMLElement signature and
    // needs the cast; eslint here uses the test tsconfig that already
    // resolves the narrower type — hence the inline disable.)
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const sel = screen.getByLabelText('Reasoning effort') as HTMLSelectElement;
    const optionValues = Array.from(sel.options).map((o) => o.value);
    expect(optionValues).toEqual(['off', 'low', 'medium', 'high']);
    // Picker mirrors the prop's "medium".
    expect(sel.value).toBe('medium');
  });

  it('renders the budget-shape control for a budget model', async () => {
    server.use(handler([budgetModel]));
    render(
      <LLMModelPicker
        provider="gemini"
        value="gemini-2.5-flash"
        reasoningEffort={4096}
        onChange={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('effort-budget')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('effort-levels')).not.toBeInTheDocument();
    // Number input has the configured value and respects the range.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const num = screen.getByLabelText('Thinking budget tokens') as HTMLInputElement;
    expect(num.value).toBe('4096');
    expect(num.min).toBe('0');
    expect(num.max).toBe('24576');
    // Dynamic checkbox is off (value is a positive number).
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const dyn = screen.getByLabelText('Use dynamic thinking budget') as HTMLInputElement;
    expect(dyn.checked).toBe(false);
  });

  it('treats reasoningEffort=-1 as dynamic on a budget model', async () => {
    server.use(handler([budgetModel]));
    render(
      <LLMModelPicker
        provider="gemini"
        value="gemini-2.5-flash"
        reasoningEffort={-1}
        onChange={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('effort-budget')).toBeInTheDocument();
    });
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const dyn = screen.getByLabelText('Use dynamic thinking budget') as HTMLInputElement;
    expect(dyn.checked).toBe(true);
    // The numeric input is disabled while dynamic.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const num = screen.getByLabelText('Thinking budget tokens') as HTMLInputElement;
    expect(num.disabled).toBe(true);
  });

  it('renders the boolean-shape control for an ollama thinking model', async () => {
    server.use(handler([booleanModel]));
    render(
      <LLMModelPicker
        provider="ollama"
        value="qwen3:32b"
        reasoningEffort={true}
        onChange={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('effort-boolean')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('effort-levels')).not.toBeInTheDocument();
    expect(screen.queryByTestId('effort-budget')).not.toBeInTheDocument();
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const toggle = screen.getByLabelText('Enable thinking mode') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
  });

  it('hides the secondary control entirely for shape=none models', async () => {
    server.use(handler([noneModel]));
    render(
      <LLMModelPicker
        provider="openai"
        value="gpt-4o-mini"
        reasoningEffort={undefined}
        onChange={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('llm-model-picker')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('effort-levels')).not.toBeInTheDocument();
    expect(screen.queryByTestId('effort-budget')).not.toBeInTheDocument();
    expect(screen.queryByTestId('effort-boolean')).not.toBeInTheDocument();
  });
});

describe('LLMModelPicker — search input gating', () => {
  it('hides the search input below the threshold', async () => {
    server.use(handler([levelsModel]));
    render(
      <LLMModelPicker
        provider="claude_cli"
        value={undefined}
        reasoningEffort={undefined}
        onChange={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Model')).toBeInTheDocument();
    });
    expect(screen.queryByLabelText('Filter models')).not.toBeInTheDocument();
  });

  it('shows the search input when the catalog has 20+ entries', async () => {
    // Build a synthetic 25-model catalog so the picker exceeds the
    // 20-model threshold. All entries use the levels shape; only the
    // raw count matters for this test.
    const many: ModelInfo[] = Array.from({ length: 25 }, (_, i) => ({
      ...levelsModel,
      id: `model-${String(i)}`,
      display_name: `Model ${String(i)}`,
    }));
    server.use(handler(many));
    render(
      <LLMModelPicker
        provider="openrouter"
        value={undefined}
        reasoningEffort={undefined}
        onChange={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Filter models')).toBeInTheDocument();
    });
  });
});

describe('LLMModelPicker — onChange round-trip', () => {
  it('selecting a model fires onChange with the new id and drops effort', async () => {
    server.use(
      handler([
        levelsModel,
        { ...levelsModel, id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
      ]),
    );
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <LLMModelPicker
        provider="claude_cli"
        value="claude-opus-4-7"
        reasoningEffort="medium"
        onChange={onChange}
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Model')).toBeInTheDocument();
    });
    const modelSel = screen.getByLabelText('Model');
    await user.selectOptions(modelSel, 'claude-sonnet-4-6');
    // Model swap: new id + effort dropped to undefined (new model may have
    // a different reasoning shape so the previous value is stale).
    expect(onChange).toHaveBeenLastCalledWith({
      model: 'claude-sonnet-4-6',
      reasoning_effort: undefined,
    });
  });

  it('selecting an effort level fires onChange with the SAME model id', async () => {
    server.use(handler([levelsModel]));
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <LLMModelPicker
        provider="claude_cli"
        value="claude-opus-4-7"
        reasoningEffort={undefined}
        onChange={onChange}
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Reasoning effort')).toBeInTheDocument();
    });
    const sel = screen.getByLabelText('Reasoning effort');
    await user.selectOptions(sel, 'low');
    expect(onChange).toHaveBeenLastCalledWith({
      model: 'claude-opus-4-7',
      reasoning_effort: 'low',
    });
  });

  it('toggling dynamic on a budget model fires onChange with -1', async () => {
    server.use(handler([budgetModel]));
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <LLMModelPicker
        provider="gemini"
        value="gemini-2.5-flash"
        reasoningEffort={4096}
        onChange={onChange}
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Use dynamic thinking budget')).toBeInTheDocument();
    });
    const dyn = screen.getByLabelText('Use dynamic thinking budget');
    await user.click(dyn);
    expect(onChange).toHaveBeenLastCalledWith({
      model: 'gemini-2.5-flash',
      reasoning_effort: -1,
    });
  });

  it('toggling thinking on a boolean model fires onChange with the new bool', async () => {
    server.use(handler([booleanModel]));
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <LLMModelPicker
        provider="ollama"
        value="qwen3:32b"
        reasoningEffort={false}
        onChange={onChange}
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Enable thinking mode')).toBeInTheDocument();
    });
    const toggle = screen.getByLabelText('Enable thinking mode');
    await user.click(toggle);
    expect(onChange).toHaveBeenLastCalledWith({
      model: 'qwen3:32b',
      reasoning_effort: true,
    });
  });
});

describe('LLMModelPicker — load states', () => {
  it('renders an empty-state when the catalog comes back empty', async () => {
    server.use(handler([]));
    render(
      <LLMModelPicker
        provider="ollama"
        value={undefined}
        reasoningEffort={undefined}
        onChange={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/No models surfaced/i)).toBeInTheDocument();
    });
  });

  it('renders the error state when the API returns ok=false', async () => {
    server.use(
      http.get('/api/llm/models', () =>
        HttpResponse.json({ ok: false, error: 'provider unreachable' }),
      ),
    );
    render(
      <LLMModelPicker
        provider="gemini"
        value={undefined}
        reasoningEffort={undefined}
        onChange={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('llm-model-picker-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('llm-model-picker-error')).toHaveTextContent(
      'provider unreachable',
    );
  });
});
