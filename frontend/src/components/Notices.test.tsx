// Pins the page notices, rendered in the real App over a real controller: no
// key shows an info notice whose button opens Settings and focuses the key
// input, and saving a key removes it; an unreachable backend (models or
// settings) shows the reason; a refused microphone shows how to recover. None
// shows when nothing is wrong.
import { describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/App';
import { createAppController } from '@/lib/controller.js';
import { fakeEnv } from '@/test/fakeEnv';

const NO_KEY = 'No Gemini API key set. Add one in Settings to connect.Open Settings';
const notice = (name: string) => document.querySelector(`[data-notice="${name}"]`);

async function renderApp(env: ReturnType<typeof fakeEnv>) {
  const controller = createAppController(env);
  const view = render(<App controller={controller} />);
  await waitFor(() => expect(controller.settings.store.get().settled).toBe(true));
  await waitFor(() => expect(controller.store.get().models.length > 0 || controller.store.get().modelsError).toBeTruthy());
  return { controller, ...view };
}

describe('Notices', () => {
  it('none shows when the key is set and the backend answers', async () => {
    await renderApp(fakeEnv());
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    expect(document.querySelectorAll('[data-notice]')).toHaveLength(0);
  });

  it('no key: Open Settings opens the pane and focuses the key input; saving a key removes the notice', async () => {
    const user = userEvent.setup();
    await renderApp(fakeEnv({ keySet: false }));
    expect(notice('no-key')!.textContent).toBe(NO_KEY);
    const details = document.querySelector('details')!;
    expect(details.open).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(details.open).toBe(true);
    const input = document.getElementById('settings-key')!;
    expect(document.activeElement).toBe(input);
    await user.type(input, 'a-new-key-0123456789abcdef{Enter}');
    await waitFor(() => expect(notice('no-key')).toBeNull());
  });

  it("an unreachable backend says so, with the reason, for models and for settings", async () => {
    const down = () => ({ status: 503, body: { error: 'plugin backend unavailable' } });
    for (const routes of [{ 'GET api/models': down }, { 'GET api/settings': down }]) {
      const { unmount } = await renderApp(fakeEnv({ routes }));
      const alert = notice('backend')!;
      expect(alert.getAttribute('role')).toBe('alert');
      expect(alert.textContent).toBe("Can't reach the code-live backend: plugin backend unavailable. Reload the page once it is back.");
      expect(notice('no-key')).toBeNull();
      unmount();
    }
  });

  it('a refused microphone shows how to recover, and clears with the state', async () => {
    const { controller } = await renderApp(fakeEnv());
    act(() => controller.store.set({ micBlocked: true }));
    expect(notice('mic-blocked')!.textContent).toBe('Microphone blocked: allow microphone access for this page, then Disconnect and Connect again.');
    expect(notice('mic-blocked')!.getAttribute('role')).toBe('alert');
    act(() => controller.store.set({ micBlocked: false }));
    expect(notice('mic-blocked')).toBeNull();
  });
});
