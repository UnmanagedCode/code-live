# Features

User-facing behavior of the Code Live page and its voice tools. Wire shapes are in [protocol.md](protocol.md).

## Page layout

| region | contents |
|---|---|
| status bar | session state pill (`idle`, `connecting`, `live`, `reconnecting`, `error`) the `Mic paused` pill (shown only while the mic is paused), and the host indicator (`Host connected` / `Host disconnected`: the backend's link to code-conductor's `/ws`) |
| controls | **Model** select (the pinned models from `GET api/models`; a model with a `hint` shows it after the label, e.g. `Gemini 3.8 Live Extended Thinking (tool calls unreliable)`), **Connect**, **Pause mic** / **Resume mic**, **Disconnect** |
| target picker | **Conductor** select listing live conductor sessions as `<title> (<status>)` (`<status>` is the run state `list_conductor_sessions` reports: [protocol](protocol.md#tool-results)), plus `— no active conductor —`; **Refresh** reloads it. Choosing one sets the active target |
| transcript | You / Gemini transcription bubbles, tool calls and results as JSON, conductor announcements, status and error lines |
| Settings (collapsible) | Gemini API key: password field, **Save**, **Clear**, and the status `Key set (••••<last 4>)` or `No key set` |

## Connecting

- **Connect** creates the audio context (it needs a user gesture), mints a token for the selected model, and opens the Gemini Live socket. When the session is `live`, the microphone starts: echo cancellation and noise suppression on, mono, sent as 16 kHz PCM in ~100 ms chunks.
- Each Gemini reply is one transcript bubble. An extended-thinking model reports a turn end with `interactionStatus: IN_PROGRESS` while it keeps working on the same reply (for example around a tool call); that keeps the bubble open. Any other status, or none, closes it.
- Gemini's audio plays back gaplessly. When Gemini reports it was **interrupted** (you talked over it), queued audio is dropped.
- If Gemini accepts the socket but doesn't finish the handshake (`setupComplete`) within 15 s, the attempt is abandoned: Connect ends in `error` with `Gemini did not complete setup within 15 s`, and a stalled resume counts as one failed attempt.
- **Disconnect** closes the session, stops the microphone and returns to `idle`. It is enabled while `connecting` and `reconnecting` too, and abandons the attempt in progress.
- When Gemini announces a connection end (`goAway`, about every 10 minutes) or the socket drops unexpectedly, the page shows `reconnecting` and resumes the same conversation on a fresh token. Attempts are spaced out (`resumeDelayMs` doubling: 1, 2, 4, 8 s) so a resume that meets a restarting backend still gets through; after `maxResumeFailures` (5) failed attempts in a row, or with no resumption handle yet, it goes to `error`; press **Connect** to start over.
- Without a stored key, Connect fails with `No Gemini API key is set; add one in Settings`.

## Pausing the microphone

- **Pause mic** is enabled while the session is `live` or `reconnecting`. It toggles to **Resume mic**, and the `Mic paused` pill shows while paused.
- A pause stops sending your audio and tells Gemini the audio stream ended. The connection, the conversation and resumption are unaffected.
- Gemini finishes what it is saying, and conductor announcements are still spoken. You cannot interrupt Gemini by voice while paused.
- The pause is kept across reconnects (`goAway` or a drop).
- **Disconnect**, an `error`, or a new **Connect** clears it: every new session starts unpaused.
- Pausing mid-sentence may make Gemini answer the part it heard.
- The browser keeps the microphone open (its recording indicator stays on); audio captured while paused is discarded.
- A long pause relies on the normal reconnect: if Gemini closes the socket before a resumption handle has arrived, the session goes to `error`.

## Voice tools

Gemini decides when to call these; each call and its result appear in the transcript.

| tool | behavior the user hears about |
|---|---|
| `list_conductor_sessions` | the live conductor sessions with each one's run state, and which one is active; worker sessions never appear |
| `create_conductor_session` | starts a new conductor and makes it the active target. It takes no prompt: Gemini follows up with `send_to_conductor` |
| `send_to_conductor` | sends your words to a conductor. Without a session it goes to the active target. With one (an id, or an exact title in any case), that session becomes the active target and Gemini says which one. The reply comes later as an announcement |
| `read_conductor_messages` | reads back the latest assistant message of a session (active target by default) together with the plan or questions its turn ended on, without changing the target. With a `count` (1–10) it reads back exactly that many messages |
| `answer_conductor_question` | answers the questions the active conductor is waiting on |
| `approve_conductor_plan` | approves the plan the active conductor is waiting on, after a spoken yes |
| `reject_conductor_plan` | rejects that plan, with feedback, so the conductor revises it |

A title matches the name shown in the picker: the session title, else the first 60 characters of its first prompt, else `Untitled conductor`. A title shared by several conductors is refused as ambiguous, and Gemini asks for the id.

Failures come back to Gemini as `ok:false` with a code, and Gemini explains them. Examples: no active target, a worker named, the host unreachable, or the host refusing the prompt. See [protocol.md](protocol.md#tool-results).

## Active target and announcements

- The **active target** is one conductor session, stored across backend restarts. These set it:
  - a named `send_to_conductor`;
  - `create_conductor_session`;
  - the target picker.
- `read_conductor_messages` never changes it.
- When the target changes, turns the session had already finished are marked as handled, so only new turns are announced. A question or plan that session is still waiting on is not a finished turn: it is announced as the switch happens. Switching back to a conductor still waiting on the same question or plan repeats it, as a reminder.
- When the active target finishes a turn, its last text reply appears in the transcript as a **Conductor · `<title>`** entry. While the session is `live` (including while the mic is paused), it is also sent to Gemini as `CONDUCTOR UPDATE from "<title>":` followed by the text. Gemini reads a short reply in full and summarizes a long or code-heavy one. A turn with no text reply is announced as `(turn finished with no text reply)`. Replies are cut at 4000 characters.
- An announcement that ends on a question or plan has `· question` or `· plan` after the title in its transcript label, and a final line for Gemini (`AWAITING ANSWER` or `AWAITING PLAN APPROVAL`) that is not shown in the transcript.
- An announcement arriving while the session is not live stays in the transcript only; it is not spoken later.
- If the active target's session disappears from code-conductor, the target is cleared and the picker shows `— no active conductor —`.

## Answering and approving by voice

When the active conductor ends a turn on a question or a plan, the announcement includes it, and Gemini acts on it.

- **Questions:** Gemini reads each question with its numbered options and asks you. A very long set of questions is shortened to fit: option descriptions first, then long labels, and if that is still not enough some trailing options are left out. Gemini says so, and option numbers still work. Answer with the option number or its words (`the second`, `sqlite`). A multi-select question takes several options, a question can be answered with your own words instead, and a remark can go along with a choice. Skipped questions are left unanswered. If an option can't be matched, Gemini reads the options back and asks again.
- **Plans:** Gemini summarizes the plan and asks whether to approve or reject it.
  - **Approve:** Gemini first says that approving lets the conductor run without permission prompts, and waits for an explicit yes. The confirmation is enforced by Gemini's instructions and the tool's `confirmed` flag, not checked against your speech. It guards against a misheard utterance and is not a security boundary: conductor-written text reaches Gemini and could itself prompt an approval, which grants nothing a conductor cannot already do through the open host API.
  - **Reject:** say what to change. The conductor stays in plan mode and revises the plan.
- While that conductor stays the target, a question or plan that is still waiting is announced once, even if the conductor has run other turns since.
- These work only while the conductor is actually waiting. Once it has been answered (here or in the code-conductor UI), a further answer or decision is refused.
- They act on the active target only, and depend on the host's `/mcp` endpoint (see the README's known limitations).

## Leaving the page

The manifest sets `frontend.keepAlive`, so code-conductor keeps the Code Live page loaded in its own frame while you are in another view. Coming back shows the same page, with no reload.

- **A live call keeps running** while you are elsewhere in code-conductor: the microphone stays open, Gemini keeps listening, and conductor announcements are still spoken.
- **Gemini can act on what the open microphone hears** (send prompts; an approval still needs a spoken yes, which can be overheard) while no Code Live UI is on screen. The code-conductor switcher shows `Code Live (running)` and the browser shows its recording indicator. Use **Pause mic** or **Disconnect** before leaving if that is not wanted.
- **A call that ends while the page is hidden** (resume attempts exhausted, Gemini closing the socket) goes to `error` and stops the microphone. The `error` pill and a transcript line are there when you return.
- **What ends the page:** Stop or Disable of the plugin, a Restart or Update from Settings → Plugins, a version switch, or reloading the browser tab. The call ends with it.
- **A backend restart does not end the call.** The Gemini socket does not go through the backend. The page's event stream reconnects by itself (retrying with a growing delay while the host answers 502/503), announcements made while the backend was down are replayed, and a tool call made in that window returns `CLIENT_ERROR` to Gemini. A Gemini resume in that window waits and retries (see Connecting).
