// Pins the status badges: the state badge shows the session state, the Mic
// paused badge is hidden unless the mic is paused, and the host badge says
// whether code-conductor's link is up.
import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { StatusBar } from './StatusBar';
import { fakeController } from '@/test/fakeController';

describe('StatusBar', () => {
  it('follows the state, the pause and the host link', () => {
    const { store, controller } = fakeController();
    const { container } = render(<StatusBar controller={controller} />);
    const badge = (id: string) => container.querySelector<HTMLElement>(`#${id}`)!;
    expect(screen.getByRole('heading', { name: 'Code Live' })).toBeTruthy();
    expect([badge('state').textContent, badge('mic').hidden, badge('host').textContent]).toEqual(['idle', true, 'Host disconnected']);
    for (const state of ['connecting', 'live', 'reconnecting', 'error']) {
      act(() => store.set({ state }));
      expect(badge('state').textContent).toBe(state);
    }
    act(() => store.set({ micPaused: true, hostConnected: true }));
    expect([badge('mic').hidden, badge('mic').textContent, badge('host').textContent]).toEqual([false, 'Mic paused', 'Host connected']);
  });
});
