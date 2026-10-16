// Settings state and actions: the Gemini API key, the Gemini voice and the
// custom instructions. The key is sent once and never read back; only its
// last four characters are ever shown. Voice and instructions apply from the
// next Connect, so the page locks them while a session runs.
import { createStore } from './store.js';

const NEXT_CONNECT = 'Applies on the next Connect.';

/** @typedef {{ text: string, error: boolean }} Status */

const NONE = { text: '', error: false };
/** @param {{ set: boolean, tail: string | null } | null | undefined} apiKey @returns {Status} */
const keyText = (apiKey) => ({ text: apiKey?.set ? `Key set (••••${apiKey.tail})` : 'No key set', error: false });
/** @param {any} e @returns {Status} */
const errorText = (e) => ({ text: String(e?.message ?? e), error: true });

/** @param {ReturnType<typeof import('./api.js').createApi>} api */
export function createSettings(api) {
  const store = createStore({
    settled: false, // load() finished, either way
    loadError: /** @type {string | null} */ (null),
    apiKey: /** @type {{ set: boolean, tail: string | null } | null} */ (null),
    voices: /** @type {{ name: string, style: string }[]} */ ([]),
    voice: '', // '' is the model's default voice
    customPrompt: '',
    promptRev: 0, // bumped when customPrompt is (re)loaded from the backend, so the textarea takes it
    customPromptMax: /** @type {number | null} */ (null),
    keyStatus: /** @type {Status} */ (NONE),
    voiceStatus: /** @type {Status} */ (NONE),
    promptStatus: /** @type {Status} */ (NONE),
  });
  let savedVoice = '';
  const showPrompt = (customPrompt) => ({ customPrompt, promptRev: store.get().promptRev + 1 });

  return {
    store,

    load() {
      return Promise.all([api.getSettings(), api.getVoices()]).then(([s, { voices }]) => {
        savedVoice = s.voice ?? '';
        store.set({ settled: true, apiKey: s.apiKey, keyStatus: keyText(s.apiKey), voices, voice: savedVoice, customPromptMax: s.customPromptMax, ...showPrompt(s.customPrompt) });
      }, (e) => {
        store.set({ settled: true, loadError: errorText(e).text, keyStatus: errorText(e) });
      });
    },

    /** @param {string} value */
    async saveKey(value) {
      try {
        const { apiKey } = await api.setApiKey(value);
        store.set({ apiKey, keyStatus: keyText(apiKey) });
      } catch (e) { store.set({ keyStatus: errorText(e) }); }
    },

    async clearKey() {
      try {
        const { apiKey } = await api.clearApiKey();
        store.set({ apiKey, keyStatus: keyText(apiKey) });
      } catch (e) { store.set({ keyStatus: errorText(e) }); }
    },

    // Saves at once; a failure puts the previous choice back.
    /** @param {string} voice */
    async setVoice(voice) {
      store.set({ voice });
      try {
        const saved = await api.setVoice(voice || null);
        savedVoice = saved.voice ?? '';
        store.set({ voice: savedVoice, voiceStatus: { text: `Saved: ${saved.voice ?? 'default voice'}. ${NEXT_CONNECT}`, error: false } });
      } catch (e) {
        store.set({ voice: savedVoice, voiceStatus: errorText(e) });
      }
    },

    // Shows the backend's normalized text; a failure keeps the draft as typed.
    /** @param {string} text */
    async savePrompt(text) {
      try {
        const saved = await api.setCustomPrompt(text);
        store.set({ ...showPrompt(saved.customPrompt), promptStatus: { text: `${saved.customPrompt === '' ? 'Cleared' : 'Saved'}. ${NEXT_CONNECT}`, error: false } });
      } catch (e) { store.set({ promptStatus: errorText(e) }); }
    },
  };
}
