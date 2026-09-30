// Settings pane: store or clear the Gemini API key. The key is sent once and
// never read back; only its last four characters are ever shown.
import { el } from './dom.js';

export function installSettings(root, api) {
  const input = el('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'Gemini API key', 'aria-label': 'Gemini API key' });
  const status = el('div', { class: 'settings-status' });
  const save = el('button', { type: 'button' }, 'Save');
  const clear = el('button', { type: 'button', class: 'secondary' }, 'Clear');

  function show(apiKey) {
    status.classList.remove('error');
    status.textContent = apiKey?.set ? `Key set (••••${apiKey.tail})` : 'No key set';
  }
  function showError(e) {
    status.classList.add('error');
    status.textContent = String(e?.message ?? e);
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

  root.append(
    el('p', { class: 'hint' }, 'The key is stored on the code-conductor machine and is never sent back to this page.'),
    el('div', { class: 'row' }, [input, save, clear]),
    status,
  );

  const ready = api.getSettings().then((s) => show(s.apiKey), showError);
  return { ready };
}
