// What the session controls show for a session state. The session stays the
// source of truth; these only map its state to a view.

/** @param {string} state */
export const isConnected = (state) => state === 'live' || state === 'reconnecting';

// Voice and instructions are composed into every token minted for a running
// session (the first one and each resume), so they are locked from connecting on.
/** @param {string} state */
export const settingsLocked = (state) => state === 'connecting' || isConnected(state);

/** @param {string} state */
export function connectButtonView(state) {
  const connecting = state === 'connecting';
  return {
    label: isConnected(state) ? 'Disconnect' : connecting ? 'Connecting...' : 'Connect',
    // A connect attempt ends by itself (the token request and the Gemini setup are each
    // time-bounded, see TOKEN_TIMEOUT_MS in api.js), so it is not cancellable.
    disabled: connecting,
    busy: connecting,
    variant: /** @type {'default' | 'destructive'} */ (isConnected(state) ? 'destructive' : 'default'),
  };
}

/** @param {string} state @param {boolean} paused */
export function micButtonView(state, paused) {
  return { label: paused ? 'Resume mic' : 'Pause mic', disabled: !isConnected(state), pressed: paused };
}
