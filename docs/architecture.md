# Architecture

## Overview

```
browser (Code Live page)                       code-live backend (node:http)            code-conductor host
┌──────────────────────────┐   api/…, SSE     ┌──────────────────────────────┐  REST    ┌──────────────┐
│ app.js wiring            │ ───────────────▶ │ routes → service / gemini    │ ───────▶ │ /api/…       │
│ liveSession.js ──────────┼──┐              │ announcer ◀── ccLink (/ws) ◀─┼───────── │ /ws, /mcp    │
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
| `src/stateStore.js` | `state.json`: `{watched:{<instanceId>:{lastHandledTurnSeq, lastHandledMsgId, lastHandledAskId}}}`; writes are serialized, so the file ends at the last `update` |
| `src/models.js` | `MODELS`, the pinned catalog with per-model `thinkingLevel` / `toolBehavior` and the optional picker `hint`; `getModel` |
| `src/tools.js` | `DECLARATIONS` (the single source for the Gemini setup and the dispatcher), `toolDeclarations(model)`, and `callTool` (validation + dispatch; never throws) |
| `src/liveSetup.js` | `SYSTEM_PROMPT`, `buildSetup(modelId, resumeHandle)` |
| `src/gemini.js` | `mintToken`: the auth_tokens call, expiry timestamps, and error scrubbing (any 8+ character run copied from the key) |
| `src/ccApi.js` | host REST client; 404 → `SESSION_GONE`, other non-2xx → `HOST_HTTP_ERROR`, network/timeout → `HOST_UNAVAILABLE` |
| `src/ccLink.js` | host `/ws` client: reconnect/backoff, reqId→ack pairing, and `turn_notification` / `instances` / `open` / `close` events |
| `src/hostMcp.js` | the only module that calls the host's bare `POST /mcp` (unsanctioned, outside the plugin API): `recentMessages`, `answerQuestion`, `approvePlan`, `rejectPlan`, and `pairMessages`. Errors carry `code` and `detail` (see [protocol](protocol.md#mcp-tools)) |
| `src/answerMapping.js` | pure: `resolveAnswers` / `remapQuestion` map spoken choices to the host's exact labels; `describeAnswers` |
| `src/hostEvents.js` | helpers shared by the service and announcer: `isConductor`, `summarize`, `assistantText`, `truncate`, `truncateBody`, `toolAsk`, `newestTurnEnd`, `lastAssistantMsgId`, `latestAskEvent`, `askTurnEnd`, `askId`, `renderQuestions`, `renderPlan`, `MAX_TEXT` |
| `src/conductor.js` | the conductor service behind the tools: `list`, `create`, `send`, `read`, `answer`, `approve`, `reject`, `resolve`. `create`, `send`, `answer`, `approve` and `reject` call `announcer.watch` for the conductor they act on |
| `src/announcer.js` | per-conductor turn-end reconciliation → SSE `announce`; `watch` adds a conductor to the announced set with a baseline. `reconcileLogged()` is the entry for triggers with no caller to reject to (`turn_notification`, `open`, `instances`, startup, `watch`): a failure is logged, never an unhandled rejection |
| `src/sse.js` | SSE hub: boot-scoped ids, a 20-event replay ring, keepalive |
| `src/http.js` | security headers, JSON body reading, the static allowlist |
| `src/routes.js` | `ROUTES`, the HTTP API table |

| frontend file | responsibility |
|---|---|
| `public/app.js` | wiring only: builds the modules, connects the buttons, reflects session state, runs the mic (AudioWorklet → 100 ms chunks → 16 kHz PCM16 base64, frames discarded while the mic is paused) and playback |
| `public/liveSession.js` | DOM-free Gemini Live client: states, message → event mapping, tool round-trip, cancellation, reconnect (`reconnect()`), the mic pause flag (`pauseMic`/`resumeMic`/`micPaused`, kept across `live ⇄ reconnecting`, cleared on any other state), the bounded `setupComplete` wait (`setupTimeoutMs`, injectable `timers`), the spacing of resume attempts (`resumeDelayMs`, doubling, up to `maxResumeFailures`; a Disconnect during the wait ends the loop), and `disconnect()` from any state |
| `public/connectControl.js` | the single Connect / Connecting... / Disconnect button, rendered from `session.state`; disabled while `connecting` |
| `public/micControl.js` | Pause/Resume mic button and `Mic paused` pill, rendered from `session.state` + `session.micPaused` |
| `public/sessionView.js` | session events → transcript and speaker; `isReplyEnd` (a `turnComplete` with `interactionStatus: IN_PROGRESS` doesn't end the bubble); the new-session divider on `connecting → live` (injectable `now`) |
| `public/api.js` | backend client (relative URLs, `cache:'no-store'`) |
| `public/styles.css` | the page's only stylesheet, dark-only. Its `:root` tokens are copied from the `:root` block of code-conductor's shell `public/styles.css`, because the host provides no theme to the plugin iframe |
| `public/transcript.js` | transcript rendering, merging streamed transcription chunks, `divider(text)` |
| `public/settings.js` | the Settings pane |
| `public/events.js` | `createEventStream`: an EventSource wrapper for `api/events` (same `addEventListener` surface). A native source stops for good when a reconnect gets a non-2xx reply, so on an `error` with `readyState` CLOSED it creates a new source after `retryMs` (doubling to `maxRetryMs`, reset on `open`; injectable `timers`), re-attaches every registered listener and passes the last non-empty event id as `?lastEventId=`. An `error` while CONNECTING is left to the native retry |
| `public/announcements.js` | SSE → transcript and `sendText`; `ANNOUNCE_PREFIX`, `ASK_QUESTION_MARK`, `ASK_PLAN_MARK` and the footer line for an `ask`. Conductor-written title, text and plan path are made inert before they enter the injected header, body or footer (see [protocol](protocol.md#live-socket); look-alike letters and markdown-decorated markers are accepted residual risk) |
| `public/audio.js`, `public/player.js`, `public/mic-worklet.js` | PCM conversion, `createChunker` (100 ms chunk buffering), gapless 24 kHz playback, the `pcm-capture` worklet |
| `public/dom.js` | the `el(tag, props, children)` builder; non-node children become text nodes |

## On-disk state

Everything lives under `$PROJECTS_ROOT/.code-live/` (directory mode 0700). The path comes from the host-provided env; no other location is written.

| file | contents | mode |
|---|---|---|
| `secrets.json` | `{"geminiApiKey":"…"}` | 0600 |
| `state.json` | `{"watched":{"<instanceId>":{"lastHandledTurnSeq":number, "lastHandledMsgId":string\|null, "lastHandledAskId":string\|null}}}` | 0600 |

- Both files are written atomically: a temp file `.<name>.<pid>.<n>.tmp`, then a rename.
- An entry without `lastHandledMsgId` or `lastHandledAskId` loads it as `null`. A `watched` that is not an object, an entry that is not an object or lacks a numeric `lastHandledTurnSeq`, and a non-string id are `STORE_CORRUPT`.
- Fields outside `watched` (a single-target `state.json` has `activeTargetId` and flat `lastHandled*` fields) are ignored whatever their type, so such a file loads as `{watched:{}}` and the next write drops them. Lookups use `Object.hasOwn`.
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

Reconciling is the only path that announces, and it runs per announced conductor (`state.watched`, see [Announced conductors](features.md#announced-conductors)). A turn is idempotent by its `_seq` together with the msgId of its last assistant message, and a pending question or plan by its `tool_use` id (`lastHandledAskId`), each kept in that conductor's own cursor. Events with `parentToolUseId` (sub-agents) never count as turns or messages, matching the host:

1. It confirms the conductor is a live conductor row in `GET /api/instances`. A missing row or a non-`.conduct` row prunes it from the announced set, so a worker is never announced. If the host is unreachable, it logs and stops.
2. It reads the conductor's trailing 500 events. A `lastSeq` below `lastHandledTurnSeq` means the host reset the ring (rewind, prune, respawn), so the handled seq counts as `-1` for this pass.
3. It takes the newest `turn_end` with `_seq` above the handled seq; with none, it stops.
4. `msgId` is the last assistant message inside that turn. If it equals `lastHandledMsgId`, the turn is a replay of one already announced: the new seq is persisted and nothing is published. A turn with no `msgId` never matches.
5. The row is the authority on whether an ask is pending (`toolAsk`). If it is, the newest matching `user_question` / `plan_request` event is the ask, and its own turn must have ended (a `turn_end` after it). An ask whose id is not `lastHandledAskId` is unannounced.
   - When the ask's turn is the newest turn, the two are one announcement.
   - When later turns exist (or the newest turn was a silent replay), the ask is announced first on its own, with `turnSeq` of the ask's turn and text from the events, then the later turn follows as usual. An ask-only run announces the ask and leaves the turn cursor alone.
6. It reads the content (below).
7. It persists `{lastHandledTurnSeq, lastHandledMsgId}` (and `lastHandledAskId` for an ask) and publishes `announce`.

A 404 prunes the conductor; other errors are logged.

**Content** comes from `hostMcp.recentMessages(row.sessionId)`:
- `text` is the returned bodies joined with newlines, so a turn's plan or questions are included. `ask` is `{kind:"question", count}` or `{kind:"plan", planPath}` when an unannounced ask ended this turn, else `null`.
- The text is used only if the newest returned message has the turn's `msgId`. Otherwise (a later turn has already spoken, the read failed, or the row has no `sessionId` yet) the turn's last assistant text from the events is used, and the reason is logged.
- Either way, if the ask's section is missing from the text it is rendered from the ask's own event in the host's fence format, so the ask is never dropped. The renderers treat non-string or missing fields of the host payload as empty, so a malformed event cannot throw.
- Over 4000 characters, `truncateBody` keeps a trailing `--- questions ---` section whole and cuts the prose before it. A section that alone exceeds the limit is shortened line by line (lines capped at 160, 80, 40 then 20 chars, so descriptions go first but a long label is cut too) and `ask.truncated` is set. If that is not enough, trailing lines are dropped whole, a `… N more line(s) not shown` line ends the section and `ask.dropped` is set. Anything else is cut from the end. Answering maps choices against the untruncated `user_question` event.

**Triggers:**
- a `turn_notification` whose `id` is an announced conductor (reconciles that conductor only);
- every host-link `open` (one list read, then every announced conductor);
- backend startup;
- an `instances` frame (`reconcileAsk`), for a conductor the host stopped notifying about (it sends no `turn_notification` for a conductor that holds an armed wake on a worker). It also prunes an announced conductor whose row is gone or no longer a conductor.

`reconcileAsk` is coalesced to one queued run and reads the instance list once per run. For each announced conductor it does nothing unless the row shows an unanswered tool ask whose `awaitingUser:lastResponseAt` differs from the ask state that conductor's last completed reconcile settled. A reconcile settles the state unless the ask's own turn is still running, so an unchanged ask costs one events read (and one MCP read when it announces); each further `instances` frame costs only the instance-list read. It announces only a pending ask, so a turn the host deliberately suppressed stays silent.

Duplicate triggers therefore never double-announce, and a turn missed during a disconnect or a restart is announced once.

**Serialization:**
- Every reconcile, `watch(id, {seq?})`, `holdAsk(id, kind)` and prune for every conductor shares one promise chain. A reconcile can therefore never overwrite a fresh baseline, and a turn that finishes on conductor B while A's announcement is being composed is reconciled right after, as its own `announce` with B's id. Nothing is dropped or merged. Parallel sends to two conductors do not race, because no state is shared between them.
- `watch` is a no-op for a conductor that is already announced, so a second action never re-baselines it. For a new one it marks every turn the session has already finished as handled (`-1` for a freshly created conductor, passed as `seq`), then queues an ask-only reconcile, so a question or plan the row still shows as unanswered is announced once.
- `holdAsk(id, kind)` is for `answer`, `approve` and `reject`. It runs on the same chain and marks the conductor's newest ask of that kind handled (`lastHandledAskId`), whether the conductor is new (baselined with the mark) or already announced, so no reconcile announces the question just answered while the row still shows it. The service calls it after every refusal check and before the host write, through `withAskHeld`. It resolves to an `undo`: when the write fails, `undo` restores the previous `lastHandledAskId` (unless a newer value has replaced the mark), clears the conductor's ask latch and queues an ask-only reconcile, so the ask is announced again.
- `send` awaits `watch` (baseline included) **before** it sends the prompt. Otherwise a fast turn could end before the baseline and be marked handled unannounced. The test `a turn that ends right after the first send to a conductor is still announced` pins this ordering.

**Restart replay:**
- SSE ids are `<boot>-<n>`.
- An EventSource reconnecting natively after a backend restart presents the old process's id in `Last-Event-ID`, and the new process replays its whole ring. That ring includes announcements made by the startup reconcile before the page reconnected.
- When the host answers the reconnect with 502/503 (restart backoff, a dead adopted child), the native source is CLOSED for good. `public/events.js` then re-creates it and carries the id in `?lastEventId=`, which `src/sse.js` reads when the header is absent.

**Keep-alive:**
- `frontend.keepAlive` in `conductor.plugin.json` gives the page its own resident frame in code-conductor, so the page can outlive many backend restarts.
- The Gemini Live socket goes browser → Gemini, so a backend restart doesn't touch a running call.
- What does depend on the backend reconnects: the event stream (`public/events.js`), Gemini resumes (`resumeDelayMs` spacing in `public/liveSession.js`), and tool calls (`CLIENT_ERROR` to Gemini while the backend is down). The announced set with its cursors, and the key, are persisted (`state.json`, `secrets.json`).

## Security

- **The key is exposed only in the `x-goog-api-key` header to Gemini.** `GET /api/settings` shows the last 4 characters. Validation errors don't echo input. Upstream error messages are scrubbed.
- **The page renders model output only as DOM text.** Transcripts, conductor text, titles, tool args/results and errors are set via `textContent` or text nodes. `public/` contains no `innerHTML` / `outerHTML` / `insertAdjacentHTML` / `document.write` / `srcdoc` / `eval` / `new Function`.
- **CSP:**
  - Only same-origin scripts and styles may run. AudioWorklet modules count as scripts.
  - `connect-src` allows only same-origin and the Gemini Live origin.
  - It forbids framing by anything but the host.
- **Why DOM text and CSP matter:** the plugin iframe is same-origin with code-conductor, whose API has no auth. They keep injected model output from acting on the host.
- **The worker guard is in `resolve`.** A tool that names a worker id is refused `NOT_A_CONDUCTOR` before any prompt or event read, and title matching considers only conductor rows.

## Tests

Run with `npm test`, which is `node tests/run.mjs`: the `node:test` runner driven through its API, one file at a time.

- **Fakes:**
  - `tests/fakes/fakeGemini.mjs` fakes the auth_tokens mint (with an injectable failure) and the Live socket. It checks single-use tokens, sends binary frames, and records client messages. `session(i)` / `next(pred)` / `closed` let tests await specific traffic, and `setConnectMode('reject')` makes resume attempts fail.
  - `tests/fakes/fakeHost.mjs` fakes the instance, ensure and events routes, plus `/ws` prompt/ack. Ack modes are `ok` / `refuse` / `silent`. It also has `broadcast`, `dropConnections`, `onPrompt` hooks and `finishTurn(id, text)`.
  - Its `POST /mcp` checks the JSON-RPC request shape, records `mcpCalls`, answers `get_recent_messages` from the instance's events (bonding like the host) and takes handlers for the other tools through `setMcp(name, fn)` with the `mcpOk` / `mcpSoft` / `mcpThrown` envelopes. `finishAsk(id, {kind, …})` ends a turn on a question or plan and sets the row's `awaitingUser*` fields (`frames:false` sends no `/ws` frame); its message reconstruction skips `parentToolUseId` events as the host does; `resetRing(id)` renumbers the events as a respawn does; `setRow` patches a row.
- **Harness:** `tests/helpers.mjs`' `startApp()` builds a real server through `buildDeps` with a fresh temp `PROJECTS_ROOT` and short link timings. It also provides an SSE client and `SENTINEL_KEY`; tests use only that sentinel key.
- **Frontend:** `tests/dom.mjs` installs happy-dom globals and imports the real `public/` modules.
- **Waits:** tests wait on observable outcomes (an SSE event, a received frame, a published marker), never on fixed sleeps.
- **Style guard:** `tests/frontend-styles.test.mjs` reads `public/styles.css` as text and checks it has no `prefers-color-scheme` query, declares `color-scheme: dark` and the host's token names on `:root`, and uses no `var(--…)` that `:root` doesn't declare.
- **Coverage guard:** `tests/nondisclosure.test.mjs` compares its probe list against `ROUTES`, so a new route fails until it is checked for key leaks.
- **Real smoke tests:**
  - `tests/real-gemini.test.mjs` is skipped unless `RUN_REAL_GEMINI=1`, and reads the key from `GEMINI_API_KEY`. Models in its `CONNECT_ONLY` set skip the tool-call step (see the README's known limitations).
  - `tests/real-host.test.mjs` is skipped unless `RUN_REAL_HOST=1`. It takes `CONDUCTOR_URL` and `REAL_HOST_SESSION` and makes read-only `/mcp` calls.
