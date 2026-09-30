# Architecture

## Overview

```
browser (Code Live page)                       code-live backend (node:http)            code-conductor host
┌──────────────────────────┐   api/…, SSE     ┌──────────────────────────────┐  REST    ┌──────────────┐
│ app.js wiring            │ ───────────────▶ │ routes → service / gemini    │ ───────▶ │ /api/…       │
│ liveSession.js ──────────┼──┐              │ announcer ◀── ccLink (/ws) ◀─┼───────── │ /ws          │
└──────────────────────────┘  │ wss (token)   └──────────────┬───────────────┘          └──────────────┘
                              ▼                              │ auth_tokens (x-goog-api-key)
                        Gemini Live  ◀───────────────────────┘
```

- **Audio goes straight from the browser to Gemini** over the Live WebSocket, authorized by a single-use ephemeral token that the backend mints. Every pinned model supports ephemeral tokens, so no backend relay is needed.
- **The token carries the whole setup:** model, tools, system prompt and resumption handle. With `bidiGenerateContentSetup` set and no `fieldMask`, Gemini ignores the client's setup, so the page cannot change the tools or prompt.
- **Tool calls arrive in the browser**, which forwards them to `POST api/tools/call`. The backend runs them against the host and the page sends the result back as `toolResponse`.
- **Zero runtime dependencies:** raw `node:http` plus Node ≥ 22's global `fetch` and `WebSocket`. The frontend is vanilla ES modules with no build step.

## Modules

| file | responsibility |
|---|---|
| `server.js` | entry: `buildDeps(config, opts)` builds the collaborators; `createServer(deps)` does routing (a request target that fails to parse is `400 BAD_REQUEST`), the JSON body gate, static files and error mapping (`STATUS_BY_CODE`); `start()` listens (retrying on `EADDRINUSE`), starts the host link, runs the startup reconcile and handles SIGTERM. It auto-starts only when run directly |
| `src/config.js` | `loadConfig(env)`: env → config; throws on a missing `PROJECTS_ROOT` / `CONDUCTOR_URL`; derives `dataDir`, `geminiWsUrl` and `hostWsUrl` |
| `src/atomicFile.js` | `writeFileAtomic` (0600 temp file + rename + chmod, directory 0700) and `readJson` (`null` if absent, `STORE_CORRUPT` if unparseable) |
| `src/keyStore.js` | `secrets.json`: `get` (the only key accessor, used only by `gemini.js`), `status`, `set` (validation), `clear` |
| `src/stateStore.js` | `state.json`: `{activeTargetId, lastHandledTurnSeq}`; writes are serialized, so the file ends at the last `update` |
| `src/models.js` | `MODELS`, the pinned catalog with per-model `thinkingLevel` / `toolBehavior` and the optional picker `hint`; `getModel` |
| `src/tools.js` | `DECLARATIONS` (the single source for the Gemini setup and the dispatcher), `toolDeclarations(model)`, and `callTool` (validation + dispatch; never throws) |
| `src/liveSetup.js` | `SYSTEM_PROMPT`, `buildSetup(modelId, resumeHandle)` |
| `src/gemini.js` | `mintToken`: the auth_tokens call, expiry timestamps, and error scrubbing (any 8+ character run copied from the key) |
| `src/ccApi.js` | host REST client; 404 → `SESSION_GONE`, other non-2xx → `HOST_HTTP_ERROR`, network/timeout → `HOST_UNAVAILABLE` |
| `src/ccLink.js` | host `/ws` client: reconnect/backoff, reqId→ack pairing, and `turn_notification` / `open` / `close` events |
| `src/hostEvents.js` | helpers shared by the service and announcer: `isConductor`, `summarize`, `assistantText`, `truncate`, `MAX_TEXT` |
| `src/conductor.js` | the conductor service behind both the tools and the UI routes: `list`, `create`, `send`, `read`, `resolve`, `setTarget`, `clearTarget`, `getTarget` |
| `src/announcer.js` | turn-end reconciliation → SSE `announce`; target baselines |
| `src/sse.js` | SSE hub: boot-scoped ids, a 20-event replay ring, keepalive |
| `src/http.js` | security headers, JSON body reading, the static allowlist |
| `src/routes.js` | `ROUTES`, the HTTP API table |

| frontend file | responsibility |
|---|---|
| `public/app.js` | wiring only: builds the modules, connects the buttons, reflects session state, runs the mic (AudioWorklet → 100 ms chunks → 16 kHz PCM16 base64) and playback |
| `public/liveSession.js` | DOM-free Gemini Live client: states, message → event mapping, tool round-trip, cancellation, resume, the bounded `setupComplete` wait (`setupTimeoutMs`, injectable `timers`), and `disconnect()` from any state |
| `public/sessionView.js` | session events → transcript and speaker; `isReplyEnd` (a `turnComplete` with `interactionStatus: IN_PROGRESS` doesn't end the bubble) |
| `public/api.js` | backend client (relative URLs, `cache:'no-store'`) |
| `public/transcript.js` | transcript rendering, merging streamed transcription chunks |
| `public/settings.js`, `public/targetPicker.js` | the Settings pane and the target picker |
| `public/announcements.js` | SSE → transcript and `sendText`; `ANNOUNCE_PREFIX` |
| `public/audio.js`, `public/player.js`, `public/mic-worklet.js` | PCM conversion, gapless 24 kHz playback, the `pcm-capture` worklet |
| `public/dom.js` | the `el(tag, props, children)` builder; non-node children become text nodes |

## On-disk state

Everything lives under `$PROJECTS_ROOT/.code-live/` (directory mode 0700). The path comes from the host-provided env; no other location is written.

| file | contents | mode |
|---|---|---|
| `secrets.json` | `{"geminiApiKey":"…"}` | 0600 |
| `state.json` | `{"activeTargetId":string\|null, "lastHandledTurnSeq":number}` | 0600 |

- Both files are written atomically: a temp file `.<name>.<pid>.<n>.tmp`, then a rename.
- A malformed file throws `STORE_CORRUPT`; it is never treated as empty.
- The backend fails to start if `state.json` is corrupt.

## Host link (`ccLink`)

- **Backoff:** one WebSocket to `$CONDUCTOR_URL/ws`. On close or error it reconnects after `min(baseDelayMs·2^attempt, maxDelayMs)` (defaults 500 ms / 10 s), and `attempt` resets on a successful open.
- **`open`** carries `{reconnect:boolean}`. `close` fires only for a socket that had opened.
- **Prompt/ack pairing:**
  - A prompt gets `reqId = code-live-<n>`, and a pending entry resolves on `ack.ok` or rejects `HOST_REFUSED`. Acks may arrive in any order, and unknown reqIds are ignored.
  - Each prompt has a 10 s timeout (`ACK_TIMEOUT`).
  - When the socket drops, every pending prompt rejects `HOST_DISCONNECTED`.
  - A prompt while the socket is down rejects `HOST_UNAVAILABLE` at once; nothing is queued, and Gemini tells the user.
- **No replay:** the host's `/ws` has none, so missed turn notifications are recovered by the announcer over REST.

## Announcer

`reconcile()` is the only path that announces, and it is idempotent by `_seq`:

1. It confirms the persisted target is a live conductor row in `GET /api/instances`. A missing row or a non-`.conduct` row clears the target (SSE `target: null`), so a worker is never announced. If the host is unreachable, it logs and stops.
2. It reads the target's trailing 500 events.
3. It takes the newest `turn_end` with `_seq > lastHandledTurnSeq`; with none, it stops.
4. It persists that seq.
5. It publishes the last non-empty assistant text with a lower `_seq`.

A 404 clears the target (SSE `target: null`); other errors are logged.

**Triggers:**
- a `turn_notification` whose `id` is the active target;
- every host-link `open`;
- backend startup.

Duplicate triggers therefore never double-announce, and a turn missed during a disconnect or a restart is announced once.

**Serialization:**
- Reconciles, `baseline(id, seq?)` (a target switch) and `clear()` share one promise chain, so a reconcile for the old target cannot overwrite a new baseline.
- `baseline` marks every turn the session has already finished as handled (`-1` for a freshly created conductor), so switching targets never announces old turns.
- `send` awaits the switch (baseline included) **before** it sends the prompt. Otherwise a fast turn could end before the baseline and be marked handled unannounced. The test `a turn that ends right after a switching send is still announced` pins this ordering.

**Restart replay:**
- SSE ids are `<boot>-<n>`.
- An EventSource reconnecting after a backend restart presents the old process's id, and the new process replays its whole ring. That ring includes announcements made by the startup reconcile before the page reconnected.

## Security

- **The key is exposed only in the `x-goog-api-key` header to Gemini.** `GET /api/settings` shows the last 4 characters. Validation errors don't echo input. Upstream error messages are scrubbed.
- **The page renders model output only as DOM text.** Transcripts, conductor text, titles, tool args/results and errors are set via `textContent` or text nodes. `public/` contains no `innerHTML` / `outerHTML` / `insertAdjacentHTML` / `document.write` / `srcdoc` / `eval` / `new Function`.
- **CSP:**
  - Only same-origin scripts and styles may run. AudioWorklet modules count as scripts.
  - `connect-src` allows only same-origin and the Gemini Live origin.
  - It forbids framing by anything but the host.
- **Why DOM text and CSP matter:** the plugin iframe is same-origin with code-conductor, whose API has no auth. They keep injected model output from acting on the host.
- **The worker guard is in `resolve`.** A tool or target request that names a worker id is refused `NOT_A_CONDUCTOR` before any prompt or event read, and title matching considers only conductor rows.

## Tests

Run with `npm test`, which is `node tests/run.mjs`: the `node:test` runner driven through its API, one file at a time.

- **Fakes:**
  - `tests/fakes/fakeGemini.mjs` fakes the auth_tokens mint (with an injectable failure) and the Live socket. It checks single-use tokens, sends binary frames, and records client messages. `session(i)` / `next(pred)` / `closed` let tests await specific traffic, and `setConnectMode('reject')` makes resume attempts fail.
  - `tests/fakes/fakeHost.mjs` fakes the instance, ensure and events routes, plus `/ws` prompt/ack. Ack modes are `ok` / `refuse` / `silent`. It also has `broadcast`, `dropConnections`, `onPrompt` hooks and `finishTurn(id, text)`.
- **Harness:** `tests/helpers.mjs`' `startApp()` builds a real server through `buildDeps` with a fresh temp `PROJECTS_ROOT` and short link timings. It also provides an SSE client and `SENTINEL_KEY`; tests use only that sentinel key.
- **Frontend:** `tests/dom.mjs` installs happy-dom globals and imports the real `public/` modules.
- **Waits:** tests wait on observable outcomes (an SSE event, a received frame, a published marker), never on fixed sleeps.
- **Coverage guard:** `tests/nondisclosure.test.mjs` compares its probe list against `ROUTES`, so a new route fails until it is checked for key leaks.
- **Real smoke test:** `tests/real-gemini.test.mjs` is skipped unless `RUN_REAL_GEMINI=1`, and reads the key from `GEMINI_API_KEY`. Models in its `CONNECT_ONLY` set skip the tool-call step (see the README's known limitations).
