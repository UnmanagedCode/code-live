# code-live

A **voice console for code-conductor**. You talk to Gemini Live in the browser, and Gemini drives your code-conductor **conductor** sessions through function-calling tools. When a conductor it is working with finishes a turn, the reply is pushed into the Gemini session and Gemini speaks it unprompted.

It is a code-conductor plugin: the host starts its backend and shows its page under **Code Live** in the nav.

## What it does

- **Talk to Gemini Live** with one of the pinned models (below), with a live transcript of what you said, what Gemini said, and every tool call and result.
- **Drive several conductors by voice.** Gemini lists, creates, prompts and reads conductor sessions, naming the conductor in every action. Worker sessions are never listed, read or prompted.
- **Hear replies as they finish.** When a conductor code-live has acted on ends a turn, its last text reply is announced with the conductor's title and session id: shown in the transcript and, while connected, spoken by Gemini (long or code-heavy replies are summarized).
- **Answer and approve by voice.** When the conductor stops on a question or a plan, Gemini reads the questions with their numbered options, or the plan, and you answer, approve or reject by speaking. Approval needs a spoken yes.
- **Keep talking while you look elsewhere in code-conductor.** The call keeps running when you leave the Code Live view, and returning shows the same page.

Details: [docs/features.md](docs/features.md).

## Install and enable

code-live must be a registered code-conductor project, so the host's plugin discovery finds it. No Library install is needed. The runtime has no dependencies (`npm install` is only for tests). With `$CC` as the code-conductor URL:

```sh
curl -X POST $CC/api/plugins/rescan
curl -X POST $CC/api/plugins/code-live/enable
# only if cc picked a worktree version instead of the main checkout:
curl -X POST $CC/api/plugins/code-live/version -H 'content-type: application/json' -d '{"type":"main"}'
```

The UI equivalent is **Settings → Plugins → Rescan / Enable**. Then open **Code Live** in cc's nav.

## Configure the Gemini key

Open **Settings** at the bottom of the Code Live page, paste a Gemini API key, and press **Save**.

- It is stored at `$PROJECTS_ROOT/.code-live/secrets.json` (file mode `0600`, directory `0700`, written atomically).
- The page never receives it back. Only `Key set (••••<last 4>)` is shown.
- The browser gets a single-use **ephemeral token** per connection, minted by the backend. The token locks the model, tools and system prompt, so the page cannot change them.

## Pinned models

| id | label | setup requirements |
|---|---|---|
| `gemini-3.8-live` | Gemini 3.8 Live | none |
| `gemini-3.8-live-extended-thinking` | Gemini 3.8 Live Extended Thinking | `thinkingConfig.thinkingLevel: "low"`; every function `behavior: "NON_BLOCKING"`. Tool calls usually fail (see known limitations) |
| `gemini-3.1-flash-live-preview` | Gemini 3.1 Flash Live Preview | none |

The catalog, per-model settings and the picker hints (the `hint` field) live in `src/models.js`. Every setup sets `responseModalities: ["AUDIO"]` explicitly.

## The tools

| tool | args | does |
|---|---|---|
| `list_conductor_sessions` | none | lists live conductor sessions (`GET /api/instances`, `project === ".conduct"`), with each one's run state (`on a worker` while it waits on a worker; [mapping](docs/protocol.md#tool-results)) |
| `create_conductor_session` | none | ensures `.conduct` and spawns a conductor, then announces its replies |
| `send_to_conductor` | `session` (id or exact title), `text` | prompts that conductor over the host `/ws` and announces its replies |
| `read_conductor_messages` | `session`, optional `count` (1–10) | the latest assistant message with the plan or questions its turn ended on (`hasPlan`, `planPath`, `questionCount`); an explicit `count` returns exactly that many messages instead. Never starts announcing it |
| `answer_conductor_question` | `session`, `answers` (one `{choices?, text?, note?}` per question, in order) | answers the named conductor's pending question; choices are option numbers or words, mapped to the exact option labels |
| `approve_conductor_plan` | `session`, `confirmed` (must be `true`), optional `feedback` | approves the named conductor's pending plan, which switches it to `bypassPermissions` |
| `reject_conductor_plan` | `session`, optional `feedback` | rejects the named conductor's pending plan; the conductor stays in plan mode and revises it |

Shapes and error codes: [docs/protocol.md](docs/protocol.md).

## How auto-announce works

1. The backend keeps a WebSocket to the host's `/ws` and listens for `turn_notification` and `instances` frames.
2. For each announced conductor (one code-live has created, sent to, answered, approved or rejected), it reads the session's events over REST and takes the newest `turn_end` it hasn't handled. It reads the turn's text from the host's `get_recent_messages` (the last assistant text from the events if that fails, logged) and publishes it as an SSE `announce`. A turn that ended on a question or plan carries it in the text plus `ask`; a question or plan still pending behind later turns is announced once, on its own.
3. The page adds it to the transcript and, while live, injects it as `realtimeInput.text` starting `CONDUCTOR UPDATE from "<title>" (session <id>):`. An update that ends on a question or plan has a final `AWAITING ANSWER` or `AWAITING PLAN APPROVAL` line that the system prompt keys on. Gemini speaks it without interrupting.

The same reconcile runs when the host link reconnects and when the backend starts, so a missed turn is announced once. An `instances` frame also triggers it when an announced conductor shows an unanswered question or plan, because the host sends no `turn_notification` for a conductor waiting on a worker. Internals: [docs/architecture.md](docs/architecture.md).

## Run and test

```sh
npm start        # node server.js (normally the host starts it)
npm install      # dev dependencies for tests only (happy-dom, ws)
npm test         # full suite; the real-Gemini and real-host smoke tests are skipped
node tests/run.mjs tests/tools.test.mjs            # one file
RUN_REAL_GEMINI=1 GEMINI_API_KEY=… node tests/run.mjs tests/real-gemini.test.mjs
```

The real smoke test reads the key only from `GEMINI_API_KEY`. Pass it inline and never write it to a file.

`RUN_REAL_HOST=1 CONDUCTOR_URL=… REAL_HOST_SESSION=<a live session's public id> node tests/run.mjs tests/real-host.test.mjs` checks the host's `/mcp` envelope with read-only calls.

## Environment

| var | default | meaning |
|---|---|---|
| `PORT` | `7300` | backend port (the host allocates one) |
| `HOST` | `127.0.0.1` | bind address |
| `PROJECTS_ROOT` | **required** | data lives in `$PROJECTS_ROOT/.code-live/` |
| `CONDUCTOR_URL` | **required** | host API base, e.g. `http://127.0.0.1:<port>` |
| `CODE_LIVE_GEMINI_BASE` | `https://generativelanguage.googleapis.com` | Gemini API base; tests point it at a fake |

The backend exits with an error if `PROJECTS_ROOT` or `CONDUCTOR_URL` is missing.

## Known limitations

- The microphone needs a secure context: `http://localhost`, `http://127.0.0.1` or `https`.
- **code-live calls the host's bare `POST /mcp`** for announcement text, `read_conductor_messages`, and answering or deciding plans. That is not part of the plugin API, so a host change can break it without any manifest-level signal. Announcements and reads then fall back to the events text (logged, as they also do when a later turn has already spoken); answering and deciding fail with `HOST_*` codes. All of it is in `src/hostMcp.js`, so moving to a sanctioned host-tool path touches that module and the manifest only.
- Plan approval requires `confirmed: true`, which the system prompt allows only after the user's spoken yes. That guards against a misheard utterance; it is not a security boundary. Conductor-written text reaches Gemini's conversation and could itself prompt an approval, but that grants nothing a conductor cannot already do through the open host API.
- The host API has no auth, and the same-origin plugin iframe could drive all of code-conductor. The mitigations are DOM-text-only rendering of model output and a strict CSP.
- Every open Code Live tab injects each announcement into its own Gemini session, so two live tabs speak it twice.
- Only **live** conductor sessions (those in `GET /api/instances`) are listed or addressable.
- **A conductor is announced only after code-live acts on it, and stops only when it ends.** Listing or reading never starts announcing it, and there is no tool to stop announcing a live one. After an upgrade from a single-target `state.json`, nothing is announced until a conductor is acted on again.
- A reconcile after downtime can announce a turn the host would have suppressed: a conductor pausing while it waits on a worker.
- Gemini connections recycle about every 10 minutes. The client resumes with the latest handle (valid for 2 hours after a disconnect).
- Ephemeral tokens are a `v1beta` preview feature of the Gemini API.
- **`gemini-3.8-live-extended-thinking` tool calls usually fail, upstream.** The server usually never sends the `toolCall`: after the spoken filler (a `turnComplete` with `interactionStatus: IN_PROGRESS`) the model says a system error occurred or goes silent. The setup meets every tool rule on the [model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live-extended-thinking): every function is `NON_BLOCKING`, no `scheduling` is sent, and `thinkingLevel` is `low`.
  - **Reproduce:** one `realtimeInput.text` asking for `list_conductor_sessions`, sent over the `buildSetup` setup on a v1beta ephemeral token (`BidiGenerateContentConstrained`). In 10 sequential runs this model got a `toolCall` 0 times; `gemini-3.8-live` got one 10 times and `gemini-3.1-flash-live-preview` completed the round-trip 10 times.
  - **Settings that don't change the result:**
    - the `v1alpha` `BidiGenerateContent` endpoint with the API key
    - `thinkingLevel` `LOW`, `medium` or `high`
    - `includeThoughts`
    - no `behavior`
    - a single tool, or the model page's own `searchFlights` example
    - no system prompt
    - no compression, resumption or transcription
    - `clientContent` instead of `realtimeInput.text`
  - The picker labels the model with its `hint` from `MODELS`, and its real smoke test checks only connection and spoken replies.
- **The microphone can stay open with no Code Live UI on screen.** The page is kept alive when you leave its view, so Gemini keeps listening and can act on what it hears (approval still needs a spoken yes). The cues are `Code Live (running)` in code-conductor's switcher and the browser's recording indicator. Use **Pause mic** or **Disconnect** before leaving. Stop/Disable, or a Restart/Update from Settings → Plugins, ends the page and the call.
- Use headphones: speaker audio can echo back into the microphone.
- The key's last 4 characters are shown in Settings.

## Docs

- [docs/features.md](docs/features.md): UI and user-visible behavior
- [docs/protocol.md](docs/protocol.md): routes, SSE events, tool shapes, host and Gemini calls
- [docs/architecture.md](docs/architecture.md): modules, state, reconnect/announce design, tests
