// Settings pane: the Gemini API key, the Gemini voice and the custom
// instructions. The key is sent once and never read back; only its last four
// characters are ever shown. Voice and instructions apply from the next
// Connect, so they are locked while a session runs.
import { el } from './dom.js';

const NEXT_CONNECT = 'Applies on the next Connect.';

export function installSettings(root, api) {
  const input = el('input', { id: 'settings-key', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'Gemini API key', 'aria-label': 'Gemini API key' });
  const status = el('div', { class: 'settings-status' });
  const save = el('button', { type: 'button' }, 'Save');
  const clear = el('button', { type: 'button', class: 'secondary' }, 'Clear');

  const voice = el('select', { id: 'settings-voice', 'aria-label': 'Gemini voice' }, el('option', { value: '' }, "Default (model's choice)"));
  const voiceStatus = el('div', { class: 'settings-status voice-status' });
  const prompt = el('textarea', { id: 'settings-prompt', rows: 4, 'aria-label': 'Custom instructions' });
  const promptSave = el('button', { id: 'settings-prompt-save', type: 'button' }, 'Save');
  const promptStatus = el('div', { class: 'settings-status prompt-status' });
  let savedVoice = '';

  function show(apiKey) {
    status.classList.remove('error');
    status.textContent = apiKey?.set ? `Key set (••••${apiKey.tail})` : 'No key set';
  }
  function showError(e, target = status) {
    target.classList.add('error');
    target.textContent = String(e?.message ?? e);
  }
  function showMessage(target, text) {
    target.classList.remove('error');
    target.textContent = text;
  }

  save.addEventListener('click', async () => {
    const value = input.value;
    input.value = '';
    try { show((await api.setApiKey(value)).apiKey); }
    catch (e) { showError(e); }
  });
  clear.addEventListener('click', async () => {
    try { show((await api.clearApiKey()).apiKey); }
    catch (e) { showError(e); }
  });

  voice.addEventListener('change', async () => {
    try {
      const saved = await api.setVoice(voice.value || null);
      savedVoice = saved.voice ?? '';
      voice.value = savedVoice;
      showMessage(voiceStatus, `Saved: ${saved.voice ?? 'default voice'}. ${NEXT_CONNECT}`);
    } catch (e) {
      voice.value = savedVoice;
      showError(e, voiceStatus);
    }
  });
  promptSave.addEventListener('click', async () => {
    try {
      const saved = await api.setCustomPrompt(prompt.value);
      prompt.value = saved.customPrompt;
      showMessage(promptStatus, `${saved.customPrompt === '' ? 'Cleared' : 'Saved'}. ${NEXT_CONNECT}`);
    } catch (e) { showError(e, promptStatus); }
  });

  root.append(
    el('div', { class: 'settings-group' }, [
      el('label', { class: 'settings-label', for: 'settings-key' }, 'Gemini API key'),
      el('p', { class: 'hint' }, 'The key is stored on the code-conductor machine and is never sent back to this page.'),
      el('div', { class: 'row' }, [input, save, clear]),
      status,
    ]),
    el('div', { class: 'settings-group' }, [
      el('label', { class: 'settings-label', for: 'settings-voice' }, 'Voice'),
      voice,
      voiceStatus,
    ]),
    el('div', { class: 'settings-group' }, [
      el('label', { class: 'settings-label', for: 'settings-prompt' }, 'Custom instructions'),
      el('p', { class: 'hint' }, "Appended to code-live's built-in instructions, which take precedence."),
      prompt,
      el('div', { class: 'row' }, promptSave),
      promptStatus,
    ]),
    el('p', { class: 'hint' }, "Voice and instructions are used from the next Connect, and can't be changed while connected."),
  );

  const ready = Promise.all([api.getSettings(), api.getVoices()]).then(([s, { voices }]) => {
    show(s.apiKey);
    voice.append(...voices.map((v) => el('option', { value: v.name }, `${v.name} (${v.style})`)));
    savedVoice = s.voice ?? '';
    voice.value = savedVoice;
    prompt.value = s.customPrompt;
    prompt.setAttribute('maxlength', s.customPromptMax);
  }, showError);

  function setLocked(locked) {
    for (const control of [voice, prompt, promptSave]) control.disabled = locked;
  }

  return { ready, setLocked };
}
