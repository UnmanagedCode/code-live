# Features

User-facing behavior of the Code Live page and its voice tools. Wire shapes are in [protocol.md](protocol.md).

## Page layout

| region | contents |
|---|---|
| status bar | session state pill (`idle`, `connecting`, `live`, `reconnecting`, `error`) and the host indicator (`Host connected` / `Host disconnected`: the backend's link to code-conductor's `/ws`) |
| controls | **Model** select (the pinned models from `GET api/models`), **Connect**, **Disconnect** |
| target picker | **Conductor** select listing live conductor sessions as `<title> (<status>)`, plus `— no active conductor —`; **Refresh** reloads it. Choosing one sets the active target |
| transcript | You / Gemini transcription bubbles, tool calls and results as JSON, conductor announcements, status and error lines |
| Settings (collapsible) | Gemini API key: password field, **Save**, **Clear**, and the status `Key set (••••<last 4>)` or `No key set` |

## Connecting

- **Connect** creates the audio context (it needs a user gesture), mints a token for the selected model, and opens the Gemini Live socket. When the session is `live`, the microphone starts: echo cancellation and noise suppression on, mono, sent as 16 kHz PCM in ~100 ms chunks.
- Gemini's audio plays back gaplessly. When Gemini reports it was **interrupted** (you talked over it), queued audio is dropped.
- **Disconnect** closes the session, stops the microphone and returns to `idle`.
- When Gemini announces a connection end (`goAway`, about every 10 minutes) or the socket drops unexpectedly, the page shows `reconnecting` and resumes the same conversation on a fresh token. After 3 failed attempts in a row, or with no resumption handle yet, it goes to `error`; press **Connect** to start over.
- Without a stored key, Connect fails with `No Gemini API key is set; add one in Settings`.

## Voice tools

Gemini decides when to call these; each call and its result appear in the transcript.

| tool | behavior the user hears about |
|---|---|
| `list_conductor_sessions` | the live conductor sessions and which one is active; worker sessions never appear |
| `create_conductor_session` | starts a new conductor and makes it the active target. It takes no prompt: Gemini follows up with `send_to_conductor` |
| `send_to_conductor` | sends your words to a conductor. Without a session it goes to the active target. With one (an id, or an exact title in any case), that session becomes the active target and Gemini says which one. The reply comes later as an announcement |
| `read_conductor_messages` | reads back the last 1–10 assistant text messages of a session (active target by default) without changing the target |

A title matches the name shown in the picker: the session title, else the first 60 characters of its first prompt, else `Untitled conductor`. A title shared by several conductors is refused as ambiguous, and Gemini asks for the id.

Failures come back to Gemini as `ok:false` with a code, and Gemini explains them. Examples: no active target, a worker named, the host unreachable, or the host refusing the prompt. See [protocol.md](protocol.md#tool-results).

## Active target and announcements

- The **active target** is one conductor session, stored across backend restarts. These set it:
  - a named `send_to_conductor`;
  - `create_conductor_session`;
  - the target picker.
- `read_conductor_messages` never changes it.
- When the target changes, turns the session had already finished are marked as handled, so only new turns are announced.
- When the active target finishes a turn, its last text reply appears in the transcript as a **Conductor · `<title>`** entry. While the session is `live`, it is also sent to Gemini as `CONDUCTOR UPDATE from "<title>":` followed by the text. Gemini reads a short reply in full and summarizes a long or code-heavy one. A turn with no text reply is announced as `(turn finished with no text reply)`. Replies are cut at 4000 characters.
- An announcement arriving while the session is not live stays in the transcript only; it is not spoken later.
- If the active target's session disappears from code-conductor, the target is cleared and the picker shows `— no active conductor —`.
