// The single Connect / Disconnect button. Rendered only from session.state, so
// the session stays the source of truth; `connect` is the page's start action
// (it must run from the click, for the AudioContext's user gesture).
export function installConnectControl({ button, session, connect }) {
  const connected = () => session.state === 'live' || session.state === 'reconnecting';
  function render() {
    const connecting = session.state === 'connecting';
    button.textContent = connected() ? 'Disconnect' : connecting ? 'Connecting...' : 'Connect';
    button.dataset.state = session.state;
    // A connect attempt is bounded (token mint and setup time out), so it is not cancellable.
    button.disabled = connecting;
    button.setAttribute('aria-busy', String(connecting));
  }
  button.addEventListener('click', () => {
    if (connected()) session.disconnect();
    else if (session.state === 'idle' || session.state === 'error') connect();
  });
  render();
  return { render };
}
