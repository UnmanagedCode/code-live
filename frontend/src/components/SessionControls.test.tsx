// Pins the session controls: the one Connect button's label, disabled,
// aria-busy and data-state for every session state, the Pause button's
// enablement, label and aria-pressed, that clicks reach the controller, and the
// model select: each model with its hint, disabled with a loading hint (and no
// placeholder option) until the models arrive.
import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionControls } from './SessionControls';
import { fakeController } from '@/test/fakeController';
import { MODELS } from '@/test/fakeEnv';

describe('SessionControls', () => {
  it('the Connect button follows the session state', () => {
    const { store, controller } = fakeController();
    render(<SessionControls controller={controller} />);
    const button = () => document.getElementById('connect') as HTMLButtonElement;
    for (const [state, name, busy] of [['idle', 'Connect', false], ['connecting', 'Connecting...', true], ['live', 'Disconnect', false], ['reconnecting', 'Disconnect', false], ['error', 'Connect', false]] as const) {
      act(() => store.set({ state }));
      expect(button().textContent, state).toBe(name);
      expect(screen.getByRole('button', { name }), state).toBe(button());
      expect(button().disabled, state).toBe(busy);
      expect(button().getAttribute('aria-busy'), state).toBe(String(busy));
      expect(button().dataset.state, state).toBe(state);
    }
    expect(screen.getAllByRole('button').filter((b) => /connect/i.test(b.textContent ?? ''))).toHaveLength(1);
  });

  it('the Pause button is enabled while live or reconnecting, and shows the pause', () => {
    const { store, controller } = fakeController();
    render(<SessionControls controller={controller} />);
    const pause = () => document.getElementById('pause') as HTMLButtonElement;
    for (const [state, enabled] of [['idle', false], ['connecting', false], ['live', true], ['reconnecting', true], ['error', false]] as const) {
      act(() => store.set({ state }));
      expect(pause().disabled, state).toBe(!enabled);
    }
    act(() => store.set({ state: 'live' }));
    expect([pause().textContent, pause().getAttribute('aria-pressed')]).toEqual(['Pause mic', 'false']);
    act(() => store.set({ micPaused: true }));
    expect([pause().textContent, pause().getAttribute('aria-pressed')]).toEqual(['Resume mic', 'true']);
    expect(screen.getByRole('button', { name: 'Resume mic', pressed: true })).toBe(pause());
  });

  it('clicks reach the controller', async () => {
    const user = userEvent.setup();
    const { store, calls, controller } = fakeController({ state: 'live' });
    render(<SessionControls controller={controller} />);
    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    await user.click(screen.getByRole('button', { name: 'Pause mic' }));
    act(() => store.set({ state: 'connecting' }));
    await user.click(screen.getByRole('button', { name: 'Connecting...' }));
    expect(calls).toEqual(['toggleConnect', 'toggleMic']);
  });

  it('the model select lists each model with its hint, and a change selects it', async () => {
    const user = userEvent.setup();
    const { calls, controller } = fakeController();
    render(<SessionControls controller={controller} />);
    const select = screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement;
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([[MODELS[0].id, 'Gemini 3.8 Live'], ['slow', 'Slow (tool calls usually fail)']]);
    expect(select.value).toBe(MODELS[0].id);
    await user.selectOptions(select, 'slow');
    expect(calls).toEqual(['setModel:slow']);
    expect(select.value).toBe('slow');
  });

  it('while the models load, the select is disabled with a loading hint and holds no option', () => {
    const { store, controller } = fakeController({ models: [], modelId: '' });
    render(<SessionControls controller={controller} />);
    const select = screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.options).toHaveLength(0);
    expect(screen.getByText('Loading models…')).toBeTruthy();
    act(() => store.set({ models: MODELS, modelId: MODELS[0].id }));
    expect(select.disabled).toBe(false);
    expect(screen.queryByText('Loading models…')).toBeNull();
  });
});
