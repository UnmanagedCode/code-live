# code-live

A **voice console for code-conductor**. You talk to Gemini Live in the browser, and Gemini drives your code-conductor **conductor** sessions through function-calling tools. When the active conductor finishes a turn, the reply is pushed into the Gemini session and Gemini speaks it unprompted.

It is a code-conductor plugin: the host starts its backend and shows its page under **Code Live** in the nav.

## What it does

- **Talk to Gemini Live** with one of the pinned models (below), with a live transcript of what you said, what Gemini said, and every tool call and result.
- **Drive conductors by voice.** Gemini lists, creates, prompts and reads conductor sessions. Worker sessions are never listed, read or prompted.
- **Hear replies as they finish.** When the **active target** conductor ends a turn, its last text reply is announced: shown in the transcript and, while connected, spoken by Gemini (long or code-heavy replies are summarized).
- **Answer and approve by voice.** When the conductor stops on a question or a plan, Gemini reads the questions with their numbered options, or the plan, and you answer, approve or reject by speaking. Approval needs a spoken yes.
- **Pick the target** by voice (naming a session in a send switches to it, and Gemini says so) or with the target picker.

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
| `gemini-3.8-live-extended-thinking` | Gemini 3.8 Live Extended Thinking | `thinkingConfig.thinkingLevel: "low"`; every function `behavior: "NON_BLOCKING"`. Tool calls are unreliable (see known limitations) |
| `gemini-3.1-flash-live-preview` | Gemini 3.1 Flash Live Preview | none |

The catalog, per-model settings and the picker hints (the `hint` field) live in `src/models.js`. Every setup sets `responseModalities: ["AUDIO"]` explicitly.

## The tools

| tool | args | does |
|---|---|---|
| `list_conductor_sessions` | none | lists live conductor sessions (`GET /api/instances`, `project === ".conduct"`), with each one's run state (`on a worker` while it waits on a worker; [mapping](docs/protocol.md#tool-results)) and the active one marked |
| `create_conductor_session` | none | ensures `.conduct` and spawns a conductor, then makes it the active target |
| `send_to_conductor` | `text`, optional `session` (id or exact title) | prompts over the host `/ws`; a named session becomes the active target (`activeTargetChanged`) |
| `read_conductor_messages` | optional `session`, optional `count` (1–10) | the latest assistant message with the plan or questions its turn ended on (`hasPlan`, `planPath`, `questionCount`); an explicit `count` returns exactly that many messages instead. Never changes the target |
| `answer_conductor_question` | `answers` (one `{choices?, text?, note?}` per question, in order) | answers the active target's pending question; choices are option numbers or words, mapped to the exact option labels |
| `approve_conductor_plan` | `confirmed` (must be `true`), optional `feedback` | approves the active target's pending plan, which switches it to `bypassPermissions` |
| `reject_conductor_plan` | optional `feedback` | rejects the pending plan; the conductor stays in plan mode and revises it |

Shapes and error codes: [docs/protocol.md](docs/protocol.md).

## How auto-announce works

1. The backend keeps a WebSocket to the host's `/ws` and listens for `turn_notification` and `instances` frames.
2. For the active target, it reads the session's events over REST and takes the newest `turn_end` it hasn't handled. It reads the turn's text from the host's `get_recent_messages` (the last assistant text from the events if that fails, logged) and publishes it as an SSE `announce`. A turn that ended on a question or plan carries it in the text plus `ask`.
3. The page adds it to the transcript and, while live, injects it as `realtimeInput.text` starting `CONDUCTOR UPDATE from "<title>":`. An update that ends on a question or plan has a final `AWAITING ANSWER` or `AWAITING PLAN APPROVAL` line that the system prompt keys on. Gemini speaks it without interrupting.

The same reconcile runs when the host link reconnects and when the backend starts, so a missed turn is announced once. An `instances` frame also triggers it when the target shows an unanswered question or plan, because the host sends no `turn_notification` for a conductor waiting on a worker. Internals: [docs/architecture.md](docs/architecture.md).

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
- **code-live calls the host's bare `POST /mcp`** for announcement text, `read_conductor_messages`, and answering or deciding plans. That is not part of the plugin API, so a host change can break it without any manifest-level signal. Announcements and reads then fall back to the events text (logged); answering and deciding fail with `HOST_*` codes. All of it is in `src/hostMcp.js`, so moving to a sanctioned host-tool path touches that module and the manifest only.
- Plan approval requires `confirmed: true`, which the system prompt allows only after the user's spoken yes. That is enforced by the prompt, not checked against the user's actual speech.
- The host API has no auth, and the same-origin plugin iframe could drive all of code-conductor. The mitigations are DOM-text-only rendering of model output and a strict CSP.
- Every open Code Live tab injects each announcement into its own Gemini session, so two live tabs speak it twice.
- Only **live** conductor sessions (those in `GET /api/instances`) are listed or targetable.
- A reconcile after downtime can announce a turn the host would have suppressed: a conductor pausing while it waits on a worker.
- Gemini connections recycle about every 10 minutes. The client resumes with the latest handle (valid for 2 hours after a disconnect).
- Ephemeral tokens are a `v1beta` preview feature of the Gemini API.
- **`gemini-3.8-live-extended-thinking` tool calls are unreliable.** On the real API, with `thinkingLevel: "low"` and `NON_BLOCKING` functions, the server often never sends the `toolCall`, and the model then says a system error occurred. In a sample of 9 prompts asking for `list_conductor_sessions`, 2 got through. Other setups failed too: without `behavior`, without empty `parameters`, with a single tool, without the system prompt, and with `thinkingLevel` `medium` or `high` (every run failed). The other two models got the tool call every time. The picker labels this model `(tool calls unreliable)`, and its real smoke test checks only connection and spoken replies.
- Use headphones: speaker audio can echo back into the microphone.
- The key's last 4 characters are shown in Settings.

## Docs

- [docs/features.md](docs/features.md): UI and user-visible behavior
- [docs/protocol.md](docs/protocol.md): routes, SSE events, tool shapes, host and Gemini calls
- [docs/architecture.md](docs/architecture.md): modules, state, reconnect/announce design, tests
