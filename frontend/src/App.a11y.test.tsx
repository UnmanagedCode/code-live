// Pins keyboard access to the page: Tab walks the controls in reading order
// (Model, Connect, Pause, the transcript, Settings, then the pane's controls),
// skipping only what the session state disables, with the no-key notice's
// button between the session controls and the transcript; and every control
// has an accessible name.
import { describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/App';
import { createAppController } from '@/lib/controller.js';
import { fakeEnv } from '@/test/fakeEnv';

async function renderApp(opts?: Parameters<typeof fakeEnv>[0]) {
  const controller = createAppController(fakeEnv(opts));
  render(<App controller={controller} />);
  await waitFor(() => expect((document.getElementById('model') as HTMLSelectElement).disabled).toBe(false));
  await waitFor(() => expect((document.getElementById('settings-voice') as HTMLSelectElement).disabled).toBe(false));
  return controller;
}

// The accessible name of each element focused by `count` presses of Tab from the top.
async function tabOrder(count: number) {
  const user = userEvent.setup();
  (document.activeElement as HTMLElement | null)?.blur();
  const seen: string[] = [];
  for (let i = 0; i < count; i++) {
    await user.tab();
    const el = document.activeElement as HTMLElement;
    seen.push(`${el.tagName.toLowerCase()}:${el.id || el.textContent}`);
  }
  return seen;
}

const openSettings = () => act(() => { document.querySelector('summary')!.click(); });

describe('keyboard access', () => {
  it('idle: model, connect, transcript, settings, then the key, voice and instructions controls', async () => {
    await renderApp();
    openSettings();
    expect(await tabOrder(10)).toEqual([
      'select:model', 'button:connect', 'main:transcript', 'summary:Settings',
      'input:settings-key', 'button:Save', 'button:Clear', 'select:settings-voice', 'textarea:settings-prompt', 'button:settings-prompt-save',
    ]);
  });

  it('live: Pause joins after Connect, and the locked voice and instructions drop out', async () => {
    const controller = await renderApp();
    act(() => controller.store.set({ state: 'live' }));
    openSettings();
    expect(await tabOrder(8)).toEqual([
      'select:model', 'button:connect', 'button:pause', 'main:transcript', 'summary:Settings',
      'input:settings-key', 'button:Save', 'button:Clear',
    ]);
    await userEvent.setup().tab();
    expect(document.activeElement, 'nothing focusable follows Clear').toBe(document.body);
  });

  it("with no key, the notice's Open Settings button comes between the session controls and the transcript", async () => {
    await renderApp({ keySet: false });
    expect(await tabOrder(4)).toEqual(['select:model', 'button:connect', 'button:Open Settings', 'main:transcript']);
  });

  it('every control has an accessible name', async () => {
    await renderApp();
    openSettings();
    expect(screen.getByRole('combobox', { name: 'Model' }).id).toBe('model');
    expect(screen.getByRole('button', { name: 'Connect' }).id).toBe('connect');
    expect(screen.getByRole('button', { name: 'Pause mic' }).id).toBe('pause');
    expect(screen.getByRole('main', { name: 'Transcript' }).id).toBe('transcript');
    expect(screen.getByLabelText('Gemini API key', { selector: 'input' }).id).toBe('settings-key');
    expect(screen.getByRole('combobox', { name: 'Voice' }).id).toBe('settings-voice');
    expect(screen.getByRole('textbox', { name: 'Custom instructions' }).id).toBe('settings-prompt');
    for (const el of document.querySelectorAll<HTMLElement>('button, select, input, textarea, summary')) {
      const named = el.textContent!.trim() || el.getAttribute('aria-label') || (el.id && document.querySelector(`label[for="${el.id}"]`)?.textContent);
      expect(named, `${el.tagName}#${el.id}`).toBeTruthy();
    }
    for (const svg of document.querySelectorAll('svg')) expect(svg.getAttribute('aria-hidden')).toBe('true');
  });
});
