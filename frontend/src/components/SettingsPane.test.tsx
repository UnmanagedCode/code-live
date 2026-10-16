// Pins: the settings pane sends the key once, clears the input, shows only
// the masked tail, and never leaves the key anywhere in the DOM. It also pins
// the voice select and custom-instructions textarea: loaded from the backend,
// saved through the api, stored text rendered only as text, and locked on request.
// The structure behind the spacing rhythm: every control sits in a group, and
// only the closing note sits outside one.
import { describe, expect, it } from 'vitest';
import { createRef } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsPane } from './SettingsPane';
import { createSettings } from '@/lib/settings.js';
import { SENTINEL_KEY } from '../../../tests/helpers.mjs';

const VOICES = [{ name: 'Puck', style: 'Upbeat' }, { name: 'Kore', style: 'Firm' }];

function fakeApi(initial: { set: boolean; tail: string | null } = { set: false, tail: null }, { voice = null as string | null, customPrompt = '', customPromptMax = 4000 } = {}) {
  const calls: unknown[][] = [];
  return {
    calls,
    getSettings: async () => ({ apiKey: initial, voice, customPrompt, customPromptMax }),
    getVoices: async () => ({ voices: VOICES }),
    setVoice: async (v: string | null) => { calls.push(['voice', v]); return { voice: v, customPrompt }; },
    setCustomPrompt: async (text: string) => { calls.push(['prompt', text]); return { voice, customPrompt: text.trim() }; },
    setApiKey: async (k: string) => { calls.push(['set', k]); return { apiKey: { set: true, tail: k.slice(-4) } }; },
    clearApiKey: async () => { calls.push(['clear']); return { apiKey: { set: false, tail: null } }; },
  };
}

function domContains(root: Element, needle: string) {
  if (root.textContent!.includes(needle)) return true;
  return [...root.querySelectorAll('*')].some((n) => ((n as HTMLInputElement).value ?? '').includes(needle) || [...n.attributes].some((a) => a.value.includes(needle)));
}

async function mount(api: ReturnType<typeof fakeApi>, { locked = false, load = true } = {}) {
  const settings = createSettings(api as never);
  if (load) await settings.load();
  const keyInputRef = createRef<HTMLInputElement>();
  const ui = (l: boolean) => <SettingsPane settings={settings} locked={l} open onOpenChange={() => {}} keyInputRef={keyInputRef} />;
  const view = render(ui(locked));
  const root = view.container.querySelector('#settings')!;
  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  return {
    ...view, settings, root, user: userEvent.setup(),
    setLocked: (l: boolean) => view.rerender(ui(l)),
    input: $<HTMLInputElement>('settings-key'), voice: $<HTMLSelectElement>('settings-voice'), prompt: $<HTMLTextAreaElement>('settings-prompt'), save: $<HTMLButtonElement>('settings-prompt-save'),
    keyStatus: $('settings-key-status'), voiceStatus: $('settings-voice-status'), promptStatus: $('settings-prompt-status'),
    keySave: screen.getAllByRole('button', { name: 'Save' })[0] as HTMLButtonElement, keyClear: screen.getByRole('button', { name: 'Clear' }) as HTMLButtonElement,
  };
}

describe('SettingsPane', () => {
  it('save sends the key, clears the input and shows only the tail', async () => {
    const api = fakeApi();
    const { root, input, keySave, keyClear, keyStatus, user } = await mount(api);
    expect(input.type).toBe('password');
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(keyStatus.textContent).toBe('No key set');
    await user.type(input, SENTINEL_KEY);
    await user.click(keySave);
    await waitFor(() => expect(keyStatus.textContent).toBe('Key set (••••cdef)'));
    expect(api.calls).toEqual([['set', SENTINEL_KEY]]);
    expect(input.value).toBe('');
    expect(domContains(root, SENTINEL_KEY.slice(0, 12))).toBe(false);

    await user.click(keyClear);
    await waitFor(() => expect(keyStatus.textContent).toBe('No key set'));
    expect(api.calls.at(-1)).toEqual(['clear']);
  });

  it('Enter in the key input saves the key', async () => {
    const api = fakeApi();
    const { input, keyStatus, user } = await mount(api);
    await user.type(input, `${SENTINEL_KEY}{Enter}`);
    await waitFor(() => expect(keyStatus.textContent).toBe('Key set (••••cdef)'));
    expect(api.calls).toEqual([['set', SENTINEL_KEY]]);
    expect(input.value).toBe('');
  });

  it('errors render as text', async () => {
    const api = { ...fakeApi({ set: true, tail: 'wxyz' }), setApiKey: async () => { throw new Error('<img src=x onerror=alert(1)> bad'); } };
    const { root, input, keySave, keyStatus, user } = await mount(api);
    expect(keyStatus.textContent).toBe('Key set (••••wxyz)');
    await user.type(input, 'whatever-key-value-123');
    await user.click(keySave);
    await waitFor(() => expect(keyStatus.textContent).toBe('<img src=x onerror=alert(1)> bad'));
    expect(keyStatus.getAttribute('role')).toBe('alert');
    expect(root.querySelectorAll('img')).toHaveLength(0);
  });

  it('load: Default then the catalog, with the stored voice, prompt and maxlength', async () => {
    const { voice, prompt } = await mount(fakeApi(undefined, { voice: 'Kore', customPrompt: 'Be brief.', customPromptMax: 123 }));
    expect([...voice.options].map((o) => [o.value, o.textContent])).toEqual([['', "Default (model's choice)"], ['Puck', 'Puck (Upbeat)'], ['Kore', 'Kore (Firm)']]);
    expect(voice.value).toBe('Kore');
    expect(prompt.value).toBe('Be brief.');
    expect(prompt.getAttribute('maxlength')).toBe('123');
  });

  it('load: no stored voice selects Default', async () => {
    const { voice } = await mount(fakeApi());
    expect(voice.value).toBe('');
  });

  it('every control is disabled until the load settles', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((r) => { finish = r; });
    const api = { ...fakeApi(), getSettings: async () => { await gate; return { apiKey: { set: false, tail: null }, voice: null, customPrompt: '', customPromptMax: 4000 }; } };
    const { settings, root } = await mount(api, { load: false });
    const loading = settings.load();
    const controls = () => [...root.querySelectorAll<HTMLInputElement>('input, select, textarea, button')];
    expect(controls().length).toBe(6);
    expect(controls().every((c) => c.disabled)).toBe(true);
    finish();
    await loading;
    await waitFor(() => expect(controls().every((c) => !c.disabled)).toBe(true));
  });

  it('a failed load shows the error in the key status', async () => {
    const api = { ...fakeApi(), getSettings: async () => { throw new Error('HTTP 503'); } };
    const { keyStatus } = await mount(api);
    expect(keyStatus.textContent).toBe('HTTP 503');
    expect(keyStatus.getAttribute('role')).toBe('alert');
  });

  it('changing the voice saves it, and Default saves null', async () => {
    const api = fakeApi();
    const { voice, voiceStatus, user } = await mount(api);
    await user.selectOptions(voice, 'Puck');
    await waitFor(() => expect(voiceStatus.textContent).toBe('Saved: Puck. Applies on the next Connect.'));
    expect(api.calls).toEqual([['voice', 'Puck']]);
    await user.selectOptions(voice, '');
    await waitFor(() => expect(voiceStatus.textContent).toBe('Saved: default voice. Applies on the next Connect.'));
    expect(api.calls.at(-1)).toEqual(['voice', null]);
    expect(voice.value).toBe('');
  });

  it('a failed voice save restores the previous selection and shows the error as text', async () => {
    const api = { ...fakeApi(undefined, { voice: 'Kore' }), setVoice: async () => { throw new Error('<img src=x onerror=alert(1)> nope'); } };
    const { root, voice, voiceStatus, user } = await mount(api);
    await user.selectOptions(voice, 'Puck');
    await waitFor(() => expect(voiceStatus.textContent).toBe('<img src=x onerror=alert(1)> nope'));
    expect(voice.value).toBe('Kore');
    expect(voiceStatus.getAttribute('role')).toBe('alert');
    expect(root.querySelectorAll('img')).toHaveLength(0);
  });

  it('Save sends the textarea value, shows the normalized reply, and says Cleared for empty text', async () => {
    const api = fakeApi();
    const { prompt, save, promptStatus, user } = await mount(api);
    await user.type(prompt, '  Be brief.  ');
    await user.click(save);
    await waitFor(() => expect(promptStatus.textContent).toBe('Saved. Applies on the next Connect.'));
    expect(api.calls).toEqual([['prompt', '  Be brief.  ']]);
    expect(prompt.value).toBe('Be brief.');
    await user.clear(prompt);
    await user.type(prompt, '   ');
    await user.click(save);
    await waitFor(() => expect(promptStatus.textContent).toBe('Cleared. Applies on the next Connect.'));
    expect(prompt.value).toBe('');
    expect(promptStatus.getAttribute('role')).toBe('status');
  });

  it('a failed prompt save keeps the draft and shows the error', async () => {
    const api = { ...fakeApi(), setCustomPrompt: async () => { throw new Error('too long'); } };
    const { prompt, save, promptStatus, user } = await mount(api);
    await user.type(prompt, 'my draft');
    await user.click(save);
    await waitFor(() => expect(promptStatus.textContent).toBe('too long'));
    expect(prompt.value).toBe('my draft');
    expect(promptStatus.getAttribute('role')).toBe('alert');
  });

  it('a stored prompt with markup stays text', async () => {
    const { root, prompt } = await mount(fakeApi(undefined, { customPrompt: '<img src=x onerror=alert(1)>' }));
    expect(prompt.value).toBe('<img src=x onerror=alert(1)>');
    expect(root.querySelectorAll('img')).toHaveLength(0);
  });

  it('locked disables the voice, prompt and its Save, never the key controls', async () => {
    const { input, keySave, keyClear, voice, prompt, save, setLocked } = await mount(fakeApi());
    setLocked(true);
    for (const c of [voice, prompt, save]) expect(c.disabled).toBe(true);
    for (const c of [input, keySave, keyClear]) expect(c.disabled).toBe(false);
    setLocked(false);
    for (const c of [voice, prompt, save]) expect(c.disabled).toBe(false);
  });

  // Invariant: every control, row, label and status is inside a group that is a direct child of the pane body.
  it('every settings control, row and status sits in a settings group', async () => {
    const { root } = await mount(fakeApi());
    const items = [...root.querySelectorAll('input, select, textarea, button, label, [role="status"], [role="alert"]')];
    expect(items.length).toBeGreaterThan(10);
    for (const item of items) {
      const group = item.closest('[role="group"]');
      expect(group, `${item.tagName}#${item.id} is outside a settings group`).toBeTruthy();
      expect(group!.parentElement).toBe(root);
    }
  });

  // Invariant: the one ungrouped child of the body is the closing note, last.
  it('the only element outside a group is the footer note', async () => {
    const { root } = await mount(fakeApi());
    const outside = [...root.children].filter((c) => c.getAttribute('role') !== 'group');
    expect(outside).toHaveLength(1);
    expect(outside[0].tagName).toBe('P');
    expect(outside[0].textContent).toBe("Voice and instructions are used from the next Connect, and can't be changed while connected.");
    expect(root.lastElementChild).toBe(outside[0]);
  });

  // Invariant: every group opens with the label that names it, and the key group's reads "Gemini API key".
  it('every settings group starts with a label heading; the key group is headed "Gemini API key"', async () => {
    const { root, input } = await mount(fakeApi());
    const groups = [...root.querySelectorAll('[role="group"]')];
    expect(groups.map((g) => g.firstElementChild!.textContent)).toEqual(['Gemini API key', 'Voice', 'Custom instructions']);
    for (const group of groups) {
      const first = group.firstElementChild!;
      expect(first.tagName).toBe('LABEL');
      expect(group.getAttribute('aria-labelledby')).toBe(first.id);
    }
    expect(screen.getByRole('group', { name: 'Gemini API key' })).toBe(groups[0]);
    expect(screen.getByLabelText('Gemini API key', { selector: 'input' })).toBe(input);
  });

  // Invariant: the key heading is a label tied to the key input, in the order heading → hint → row → status.
  it('the key heading is tied to the key input, ahead of hint, row and status', async () => {
    const { input, keyStatus } = await mount(fakeApi());
    const group = screen.getByRole('group', { name: 'Gemini API key' });
    const [heading, hint, row, status] = [...group.children];
    expect(heading.getAttribute('for')).toBe(input.id);
    expect(hint.textContent).toBe('The key is stored on the code-conductor machine and is never sent back to this page.');
    expect(row.contains(input)).toBe(true);
    expect(status).toBe(keyStatus);
    expect(group.children).toHaveLength(4);
    for (const [a, b] of [[heading, hint], [hint, row], [row, status]]) expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
