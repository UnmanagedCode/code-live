// Pause/Resume mic button and the "Mic paused" indicator. Rendered only from
// session.state and session.micPaused, so the session stays the source of truth.
export function installMicControl({ button, indicator, session }) {
  function render() {
    const paused = session.micPaused;
    button.disabled = !(session.state === 'live' || session.state === 'reconnecting');
    button.textContent = paused ? 'Resume mic' : 'Pause mic';
    button.setAttribute('aria-pressed', String(paused));
    indicator.hidden = !paused;
  }
  button.addEventListener('click', () => (session.micPaused ? session.resumeMic() : session.pauseMic()));
  render();
  return { render };
}
