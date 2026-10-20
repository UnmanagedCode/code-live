# Architecture

## Overview

```
browser (Code Live page)                       code-live backend (node:http)            code-conductor host
┌──────────────────────────┐   api/…, SSE     ┌──────────────────────────────┐  REST    ┌──────────────┐
│ controller.js + React UI │ ───────────────▶ │ routes → service / gemini    │ ───────▶ │ /api/…       │
│ liveSession.js ──────────┼──┐              │ announcer ◀── ccLink (/ws) ◀─┼───────── │ /ws, /mcp    │
└──────────────────────────┘  │ wss (token)   └──────────────┬───────────────┘          └──────────────┘
                              ▼                              │ auth_tokens (x-goog-api-key)
                        Gemini Live  ◀───────────────────────┘
```

- **Audio goes straight from the browser to Gemini** over the Live WebSocket, authorized by a single-use ephemeral token that the backend mints. Every pinned model supports ephemeral tokens, so no backend relay is needed.
- **The token carries the whole setup:** model, tools, system prompt and resumption handle. With `bidiGenerateContentSetup` set and no `fieldMask`, Gemini ignores the client's setup, so the page cannot change the tools or prompt.
- **Tool calls arrive in the browser**, which forwards them to `POST api/tools/call`. The backend runs them against the host and the page sends the result back as `toolResponse`.
- **Zero runtime dependencies:** the backend is raw `node:http` plus Node's global `fetch` and `WebSocket`. The frontend is React + Vite + Tailwind v4 with copied shadcn/Radix components and lucide icons, following the reference setup in code-conductor's `docs/plugin-ui.md` (Part 3); all of it is devDependencies, bundled into `frontend/dist` at install.
- **Theme:** `frontend/index.html` loads the host's `/pluginBridge.js` (blocking, first), `/pluginTheme.css`, then `theme-init.js`. Embedded, the bridge mirrors code-conductor's `.dark` class and `data-cc-theme` onto the page's `<html>` and keeps them in sync, hidden frames included; the unlayered host sheet supplies the tokens. Standalone, `theme-init.js` follows `prefers-color-scheme` over `src/cc-theme-fallback.css`, a one-time snapshot of the host tokens inside `@layer base` (never synced). Colours come only from the tokens.

## Modules

| file | responsibility |
|---|---|
| `server.js` | entry: `buildDeps(config, opts)` builds the collaborators; `createServer(deps)` does routing (a request target that fails to parse is `400 BAD_REQUEST`), the JSON body gate, static files and error mapping (`STATUS_BY_CODE`); `start()` listens (retrying on `EADDRINUSE`), starts the host link, runs the startup reconcile and handles SIGTERM. It auto-starts only when run directly |
| `src/config.js` | `loadConfig(env)`: env → config; throws on a missing `PROJECTS_ROOT` / `CONDUCTOR_URL`; derives `dataDir`, `geminiWsUrl` and `hostWsUrl` |
| `src/atomicFile.js` | `writeFileAtomic` (0600 temp file + rename + chmod, directory 0700) and `readJson` (`null` if absent, `STORE_CORRUPT` if unparseable) |
| `src/keyStore.js` | `secrets.json`: `get` (the only key accessor, used only by `gemini.js`), `status`, `set` (validation), `clear` |
| `src/voices.js` | `VOICES` (the prebuilt Gemini voices, `{name, style}`) and `isVoice` (exact, case-sensitive); read by `prefsStore.js` and `GET /api/voices` |
| `src/prefsStore.js` | `preferences.json`: `get` (reads the file on every call), `setVoice`, `setCustomPrompt` (validate first, then a serialized read-merge-write, so concurrent saves both land); `CUSTOM_PROMPT_MAX` |
| `src/stateStore.js` | `state.json`: `{watched:{<instanceId>:{lastHandledTurnSeq, lastHandledMsgId, lastHandledAskId}}}`; writes are serialized, so the file ends at the last `update` |
| `src/models.js` | `MODELS`, the pinned catalog with per-model `thinkingLevel` / `toolBehavior` and the optional picker `hint`; `getModel` |
| `src/tools.js` | `DECLARATIONS` (the single source for the Gemini setup and the dispatcher), `toolDeclarations(model)`, and `callTool` (validation + dispatch; never throws) |
| `src/liveSetup.js` | `SYSTEM_PROMPT`, `CUSTOM_PROMPT_HEADER`, `composeSystemPrompt(customPrompt)`, `buildSetup(modelId, resumeHandle, {voice, customPrompt})` |
| `src/gemini.js` | `mintToken`: reads the preferences at every mint (so a resume does too), the auth_tokens call, expiry timestamps, and error scrubbing (any 8+ character run copied from the key) |
| `src/ccApi.js` | host REST client (`getEvents` takes `limit`, `before`, `after`); 404 → `SESSION_GONE`, other non-2xx → `HOST_HTTP_ERROR`, network/timeout → `HOST_UNAVAILABLE` |
| `src/ccLink.js` | host `/ws` client: reconnect/backoff, reqId→ack pairing, and `turn_notification` / `instances` / `open` / `close` events |
| `src/hostMcp.js` | the only module that calls the host's bare `POST /mcp` (unsanctioned, outside the plugin API), for the write tools only: `answerQuestion`, `approvePlan`, `rejectPlan`. Errors carry `code` and `detail` (see [protocol](protocol.md#mcp-tools)) |
| `src/answerMapping.js` | pure: `resolveAnswers` / `remapQuestion` map spoken choices to the host's exact labels; `describeAnswers` |
| `src/hostEvents.js` | helpers shared by the service and announcer: `isConductor`, `summarize`, `assistantText`, `truncate`, `truncateBody`, `toolAsk`, `newestTurnEnd`, `lastAssistantMsgId`, `latestAskEvent`, `askTurnEnd`, `askId`, `renderQuestions`, `renderPlan`, `textParts`, `MAX_TEXT`, `PART_CHARS` |
| `src/eventMessages.js` | pure, linear, no regexes: `assembleMessages` rebuilds the text-bearing messages from events (grouping by `msgId` over events of any kind, plans and questions attached by `toolUseId`), `messageBody`, `wholeMessages` (a window cut at its old end leaves out its oldest message unless the window holds its `message_start`), `bondedSelection` (the host's default selection, within one turn), `parseMessageKey` for `<seq>-<msgId>` keys. The seq in a key is a lookup hint: a respawn renumbers `_seq` and keeps `msgId`, so a lookup checks both |
| `src/eventPages.js` | `readBack` / `readForward`: paged reads of the events route, `EVENTS_PAGE` events per request, bounded by `MAX_EVENT_PAGES` (`MAX_MESSAGE_PAGES` for a read that must reach the whole of one message). `readForward` reports whether it stopped because `done` held, the stream ended, or the bound was hit |
| `src/conductor.js` | the conductor service behind the tools: `list`, `create`, `send`, `read` (listing), `readMessage` (one message, paged), `answer`, `approve`, `reject`, `resolve`. `create`, `send`, `answer`, `approve` and `reject` call `announcer.watch` for the conductor they act on |
| `src/announcer.js` | per-conductor turn-end reconciliation → SSE `announce`; `watch` adds a conductor to the announced set with a baseline. `reconcileLogged()` is the entry for triggers with no caller to reject to (`turn_notification`, `open`, `instances`, startup, `watch`): a failure is logged, never an unhandled rejection |
| `src/sse.js` | SSE hub: boot-scoped ids, a 20-event replay ring, keepalive |
| `src/http.js` | security headers, JSON body reading, the static allowlist |
| `src/routes.js` | `ROUTES`, the HTTP API table |

The frontend is split in two: **plain DOM-free ES modules** in `frontend/src/lib/*.js` (logic, imported unchanged by the `node:test` suites) and **React components** in `frontend/src/components/` that render their state and call their actions. `main.tsx` builds the one controller **before** `createRoot`, so the session, the mic, the AudioContext and the event stream live outside every component: StrictMode's doubled effects open nothing twice, and nothing stops when code-conductor hides the keep-alive page. No code listens for `visibilitychange` or `pagehide`.

| frontend file (`frontend/`) | responsibility |
|---|---|
| `index.html`, `public/theme-init.js` | the host URLs, the standalone OS-theme follower, the module entry |
| `src/main.tsx` | builds `createAppController()` once, then renders `<App>` in StrictMode |
| `src/lib/controller.js` | `createAppController(env)`: the page wiring. Builds the api, transcript store, settings, session view, live session, mic capture, event stream and announcements; its store holds `{state, micPaused, hostConnected, models, modelsError, modelId, micBlocked}`. Actions: `toggleConnect()` (connects from `idle`/`error`, disconnects from `live`/`reconnecting`, nothing while `connecting`; creates and resumes the AudioContext inside the click, for the user-gesture rule), `toggleMic()`, `setModel(id)`. `env` injects `fetchImpl`, `WebSocketImpl`, `EventSourceImpl`, `AudioContextImpl`, `AudioWorkletNodeImpl`, `mediaDevices` and `now`, each defaulting to the browser's |
| `src/lib/store.js`, `src/lib/useStore.ts` | `createStore(initial)` → `{get, set(patch), subscribe}` (each `set` publishes a new snapshot); `useStore(store, selector?)` over `useSyncExternalStore` |
| `src/lib/transcriptStore.js` | the transcript as data, `{id, kind, label, body, mono}` entries plus `{id, kind:'divider', text}`; `add`, `appendStream` (merges consecutive chunks of one speaker), `endTurn`, `divider`. Every event is O(1): entries are appended in place and a chunk replaces only its own entry object (the others keep their identity). Readers: `subscribeIds`/`getIds` (notified, and a new ids array, only when an entry is added), `subscribeEntry(id)`/`getEntry(id)` (that entry only). A chunk's listener that appends again during the notification extends the same bubble |
| `src/lib/settings.js` | `createSettings(api)`: the key, voice and custom-instructions state and actions (`load`, `saveKey`, `clearKey`, `setVoice` restoring the previous choice on failure, `savePrompt` keeping the draft on failure), with each status line's exact text |
| `src/lib/controls.js` | pure views: `connectButtonView(state)`, `micButtonView(state, paused)`, `settingsLocked(state)` (true while `connecting`, `live` or `reconnecting`) |
| `src/lib/micCapture.js` | `createMicCapture(...)`: getUserMedia → the `pcm-capture` worklet (loaded by the relative URL `mic-worklet.js`) → 100 ms chunks → 16 kHz PCM16 base64, frames and the partial chunk discarded while paused. One capture per session through a claim taken before the first await; a stop releases whatever a start has acquired so far, at once; a failure releases the stream |
| `src/lib/liveSession.js` | DOM-free Gemini Live client: states, message → event mapping, tool round-trip, cancellation, reconnect (`reconnect()`), the mic pause flag (`pauseMic`/`resumeMic`/`micPaused`, kept across `live ⇄ reconnecting`, cleared on any other state), the bounded `setupComplete` wait (`setupTimeoutMs`, injectable `timers`), the spacing of resume attempts (`resumeDelayMs`, doubling, up to `maxResumeFailures`; a Disconnect during the wait ends the loop), and `disconnect()` from any state |
| `src/lib/sessionView.js` | session events → transcript and speaker; `isReplyEnd` (a `turnComplete` with `interactionStatus: IN_PROGRESS` doesn't end the bubble); the new-session divider on `connecting → live` (injectable `now`) |
| `src/lib/api.js` | backend client (relative URLs, `cache:'no-store'`); the token request alone carries a timeout (`TOKEN_TIMEOUT_MS`, injectable as `tokenTimeoutMs`), after which it rejects with `No response from the backend within <n> s` |
| `src/lib/events.js` | `createEventStream`: an EventSource wrapper for `api/events` (same `addEventListener` surface). A native source stops for good when a reconnect gets a non-2xx reply, so on an `error` with `readyState` CLOSED it creates a new source after `retryMs` (doubling to `maxRetryMs`, reset on `open`; injectable `timers`), re-attaches every registered listener and passes the last non-empty event id as `?lastEventId=`. An `error` while CONNECTING is left to the native retry |
| `src/lib/announcements.js` | SSE → transcript and `sendText`; `ANNOUNCE_PREFIX`, `ASK_QUESTION_MARK`, `ASK_PLAN_MARK`, the footer line for an `ask`, and the cut line (naming `read_conductor_messages`, the session and each of `messageKeys`) for a `truncated` update. Conductor-written title, text and plan path are made inert before they enter the injected header, body or footer (see [protocol](protocol.md#live-socket); look-alike letters and markdown-decorated markers are accepted residual risk) |
| `src/lib/audio.js`, `src/lib/player.js`, `public/mic-worklet.js` | PCM conversion, `createChunker` (100 ms chunk buffering), gapless 24 kHz playback, the `pcm-capture` worklet (a static file copied verbatim into `dist/`, so it stays a plain AudioWorklet module) |
| `src/App.tsx`, `src/components/*.tsx` | `StatusBar` (badges), `SessionControls` (model select, Connect, Pause), `Notices` (no key, backend down, microphone blocked), `Transcript` (renders entries as text in `memo` bubbles that each subscribe to their own entry, so a chunk re-renders one bubble; scrolls to the end on every change), `SettingsPane` (native `<details>`; the key input is uncontrolled and read once on Save or Enter) |
| `src/components/ui/*.tsx`, `src/lib/utils.ts` | components copied from code-conductor's `web/src/components/ui/` on first use, and its `cn()` |

## Build on install

- `npm install` installs the devDependencies and runs `prepare` (`vite build --config frontend/vite.config.ts`), which writes `frontend/dist`: `index.html`, `theme-init.js`, `mic-worklet.js` and the hashed `assets/index-*.js` / `.css`. No source maps.
- `frontend/dist/` and `package-lock.json` are gitignored, so an installed checkout stays clean and code-conductor's Update (`git pull --ff-only`) is not blocked by a rewritten lockfile.
- The backend reads the dist file list once at startup: a rebuild while it runs needs a restart. Missing `index.html` at startup is logged (`code-live: UI not built: …`) and the page answers 503 ([protocol](protocol.md#common-rules)).

## On-disk state

Everything lives under `$PROJECTS_ROOT/.code-live/` (directory mode 0700). The path comes from the host-provided env; no other location is written.

| file | contents | mode |
|---|---|---|
| `secrets.json` | `{"geminiApiKey":"…"}` | 0600 |
| `preferences.json` | `{"voice":string\|null, "customPrompt":string}` | 0600 |
| `state.json` | `{"watched":{"<instanceId>":{"lastHandledTurnSeq":number, "lastHandledMsgId":string\|null, "lastHandledAskId":string\|null}}}` | 0600 |

- Every file is written atomically: a temp file `.<name>.<pid>.<n>.tmp`, then a rename.
- An entry without `lastHandledMsgId` or `lastHandledAskId` loads it as `null`. A `watched` that is not an object, an entry that is not an object or lacks a numeric `lastHandledTurnSeq`, and a non-string id are `STORE_CORRUPT`.
- Fields outside `watched` (a single-target `state.json` has `activeTargetId` and flat `lastHandled*` fields) are ignored whatever their type, so such a file loads as `{watched:{}}` and the next write drops them. Lookups use `Object.hasOwn`.
- A malformed file throws `STORE_CORRUPT`; it is never treated as empty.
- `preferences.json` is `STORE_CORRUPT` when it is not an object, its `voice` is neither `null` nor a `VOICES` name, or its `customPrompt` is not a string or fails the input validation (length, control characters). A missing field takes its default (`null`, `''`). A token mint then fails with `500 STORE_CORRUPT`; recover by deleting the file.
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

**Content** is assembled from the REST events (`assembleMessages`, `src/eventMessages.js`); the announcer makes no `/mcp` call:
- The window is the turn's own events: after the previous top-level `turn_end`, before this one. When the trailing page does not reach that `turn_end` and the host reports older events, `readBack` reads older pages until one shows. A window that still does not reach the turn's start leaves out the message the seam runs through (`wholeMessages`) and the announcement is published `truncated`, its `messageKeys` naming only messages that began inside the window.
- `text` is the bodies of the turn's default selection (`bondedSelection`) joined with newlines, so a turn's plan or questions are included. `ask` is `{kind:"question", count}` or `{kind:"plan", planPath}` when an unannounced ask ended this turn, else `null`.
- If the ask's section is not in the selected bodies (its message lies beyond the window), it is rendered from the ask's own event in the host's fence format, so the ask is never dropped. The renderers treat non-string or missing fields of the host payload as empty, so a malformed event cannot throw.
- Over `MAX_TEXT` characters, `truncateBody` keeps a trailing `--- questions ---` section whole and cuts the prose before it. A section that alone exceeds the limit is shortened line by line (lines capped at 160, 80, 40 then 20 chars, so descriptions go first but a long label is cut too) and `ask.truncated` is set. If that is not enough, trailing lines are dropped whole, a `… N more line(s) not shown` line ends the section and `ask.dropped` is set. Anything else is cut from the end. Any announcement whose assembled text is over `MAX_TEXT` also gets `truncated` and `messageKeys` (the selected messages' keys), pending ask or not, so `read_conductor_messages` reads it whole. Answering maps choices against the untruncated `user_question` event.

**Triggers:**
- a `turn_notification` whose `id` is an announced conductor (reconciles that conductor only);
- every host-link `open` (one list read, then every announced conductor);
- backend startup;
- an `instances` frame (`reconcileAsk`), for a conductor the host stopped notifying about (it sends no `turn_notification` for a conductor that holds an armed wake on a worker). It also prunes an announced conductor whose row is gone or no longer a conductor.

`reconcileAsk` is coalesced to one queued run and reads the instance list once per run. For each announced conductor it does nothing unless the row shows an unanswered tool ask whose `awaitingUser:lastResponseAt` differs from the ask state that conductor's last completed reconcile settled. A reconcile settles the state unless the ask's own turn is still running, so an unchanged ask costs one events read (plus older pages only when the turn began before the newest page); each further `instances` frame costs only the instance-list read. It announces only a pending ask, so a turn the host deliberately suppressed stays silent.

Duplicate triggers therefore never double-announce, and a turn missed during a disconnect or a restart is announced once.

**Serialization:**
- Every reconcile, `watch(id, {seq?})`, `holdAsk(id, kind)` and prune for every conductor shares one promise chain. A reconcile can therefore never overwrite a fresh baseline, and a turn that finishes on conductor B while A's announcement is being composed is reconciled right after, as its own `announce` with B's id. Nothing is dropped or merged. Parallel sends to two conductors do not race, because no state is shared between them.
- `watch` is a no-op for a conductor that is already announced, so a second action never re-baselines it. For a new one it marks every turn the session has already finished as handled (`-1` for a freshly created conductor, passed as `seq`), then queues an ask-only reconcile, so a question or plan the row still shows as unanswered is announced once.
- `holdAsk(id, kind)` is for `answer`, `approve` and `reject`. It runs on the same chain and marks the conductor's newest ask of that kind handled (`lastHandledAskId`), whether the conductor is new (baselined with the mark) or already announced, so no reconcile announces the question just answered while the row still shows it. The service calls it after every refusal check and before the host write, through `withAskHeld`. It resolves to an `undo`: when the write fails, `undo` restores the previous `lastHandledAskId` (unless a newer value has replaced the mark), clears the conductor's ask latch and queues an ask-only reconcile, so the ask is announced again.
- `send` awaits `watch` (baseline included) **before** it sends the prompt. Otherwise a fast turn could end before the baseline and be marked handled unannounced. The test `a turn that ends right after the first send to a conductor is still announced` pins this ordering.

**Restart replay:**
- SSE ids are `<boot>-<n>`.
- An EventSource reconnecting natively after a backend restart presents the old process's id in `Last-Event-ID`, and the new process replays its whole ring. That ring includes announcements made by the startup reconcile before the page reconnected.
- When the host answers the reconnect with 502/503 (restart backoff, a dead adopted child), the native source is CLOSED for good. `frontend/src/lib/events.js` then re-creates it and carries the id in `?lastEventId=`, which `src/sse.js` reads when the header is absent.

**Keep-alive:**
- `frontend.keepAlive` in `conductor.plugin.json` gives the page its own resident frame in code-conductor, so the page can outlive many backend restarts.
- The Gemini Live socket goes browser → Gemini, so a backend restart doesn't touch a running call.
- What does depend on the backend reconnects: the event stream (`frontend/src/lib/events.js`), Gemini resumes (`resumeDelayMs` spacing in `frontend/src/lib/liveSession.js`), and tool calls (`CLIENT_ERROR` to Gemini while the backend is down). The announced set with its cursors, the key and the preferences are persisted (`state.json`, `secrets.json`, `preferences.json`).

## Security

- **The key is exposed only in the `x-goog-api-key` header to Gemini.** `GET /api/settings` shows the last 4 characters. Validation errors don't echo input. Upstream error messages are scrubbed.
- **The page renders model output only as text.** Transcripts, conductor text, titles, tool args/results, statuses and errors reach the DOM only as React text children (`Transcript.tsx`, `SettingsPane.tsx`), never as markup, an attribute or a link: a URL in content shows as text. `tests/frontend-source.test.mjs` scans `frontend/index.html`, `public/` and `src/` (tests excluded) for `innerHTML` / `outerHTML` / `insertAdjacentHTML` / `document.write` / `srcdoc` / `eval` / `new Function` / `dangerouslySetInnerHTML` / style writes, for `style=` / `href=` / `src=` in the plugin's own code, for root-relative URLs, hash navigation, `window.parent` and `code-conductor:` storage keys.
- **CSP** (full policy and directive table: [protocol](protocol.md#common-rules)):
  - Only same-origin scripts, styles and fonts load. AudioWorklet modules count as scripts. No `'unsafe-inline'`: no component used injects a `<style>`.
  - `connect-src` allows only same-origin and the Gemini Live origin.
  - It forbids framing by anything but the host.
- **Untrusted-input parsers stay linear** (the backend parses on the thread that answers `/api/health`). `tests/parser-timing.test.mjs` times every parser of request bodies, model and conductor output, host bodies and upstream errors, plus the page's announcement and Live message handling, at doubling sizes. Two constraints it pins: `dropParenthetical` (`src/answerMapping.js`) strips a trailing `(…)` group with `trimEnd`/`lastIndexOf`, not a regex with a leading `\s*`, which rescans a whitespace run from every start; `truncateBody` (`src/hostEvents.js`) drops the trailing newlines before the questions section with a loop, not an unanchored `/\n+$/`; `textParts` (`src/hostEvents.js`) scans back for a break no further than the middle of its part's window, so its work is linear in the text, which the test pins at `PART_SIZES` because it is under a millisecond at the default sizes; `assembleMessages` and `parseMessageKey` (`src/eventMessages.js`) are pinned on the shapes that could make them quadratic (one message of many deltas, many messages, many unmatched `plan_request`s).
- **Why text rendering and CSP matter:** the plugin iframe is same-origin with code-conductor, whose API has no auth. They keep injected model output from acting on the host.
- **The worker guard is in `resolve`.** A tool that names a worker id is refused `NOT_A_CONDUCTOR` before any prompt or event read, and title matching considers only conductor rows.

## Tests

`npm test` runs three stages, each failing the run: `node tests/run.mjs` (the `node:test` runner driven through its API, one file at a time: backend, the plain `frontend/src/lib` modules, and the source/theme/dist scans), `tsc -p frontend`, then `vitest run --config frontend/vitest.config.ts` (happy-dom + Testing Library + user-event, `frontend/src/**/*.test.{ts,tsx}`).

- **Dependencies:** a fresh clone gets them, and `frontend/dist`, from `npm install`. A worktree has no `node_modules`: `npm install` there (or symlink a checkout's whose versions match), then `npm run prepare`, because `tests/dist.test.mjs` reads the real build and fails with `run npm run prepare` without it.

- **Fakes:**
  - `tests/fakes/fakeGemini.mjs` fakes the auth_tokens mint (with an injectable failure) and the Live socket. It checks single-use tokens, sends binary frames, and records client messages. `session(i)` / `next(pred)` / `closed` let tests await specific traffic, and `setConnectMode('reject')` makes resume attempts fail.
  - `tests/fakes/fakeHost.mjs` fakes the instance, ensure and events routes, plus `/ws` prompt/ack. Ack modes are `ok` / `refuse` / `silent`. It also has `broadcast`, `dropConnections`, `onPrompt` hooks and `finishTurn(id, text)`.
  - Its events route pages like the host's: a trailing window, `before` and `after` cursors, `hasMore` and `nextBefore`, as exact windows (the host's snap to a clean boundary is not modelled). `finishTurn` and `finishAsk` stream a message as the live host does: `message_start`, a `text_delta`, `text_end` and the `assistant_message` envelope under one `msgId`, then for an ask the `tool_use` (`inputPlan:false` leaves the plan only on the `plan_request`, the file-backed case; `autoApproved` marks it auto-approved) and the `plan_request` / `user_question`, then `turn_end`. `finishAsk` also sets the row's `awaitingUser*` fields (`frames:false` sends no `/ws` frame). `archiveBelow(id, seq)` serves the events below a seq as the host serves them from disk (deltas only, no `assistant_message`, a `history_gap` at the seam); `resetRing(id)` renumbers the events as a respawn does; `setRow` patches a row.
  - Its `POST /mcp` checks the JSON-RPC request shape, records `mcpCalls`, and takes handlers for the write tools through `setMcp(name, fn)` with the `mcpOk` / `mcpSoft` / `mcpThrown` envelopes; with no handler a tool answers unknown.
- **Harness:** `tests/helpers.mjs`' `startApp()` builds a real server through `buildDeps` with a fresh temp `PROJECTS_ROOT` and short link timings; `distDir` serves a fixture build (`fixtureDist()`: Vite's file shapes plus names that must never be served) and `fetchImpl` replaces the backend's outbound fetch. It also provides an SSE client, `nodeFetch` (a `node:http` fetch for page code under a test DOM, whose own fetch enforces CORS) and `SENTINEL_KEY`; tests use only that sentinel key.
- **Frontend:** node tests import the `frontend/src/lib` modules directly and inject fakes (`frontend-controller`, `frontend-micCapture`, `frontend-transcriptStore`, …). Vitest renders the components; `frontend/src/App.integration.test.tsx` drives the real `<App>` over the real controller against the real backend, fake Gemini and fake host, with the network (`nodeFetch`), the `ws` WebSocket and audio/mic stubs injected through the controller's `env`.
- **Build:** `tests/dist.test.mjs` checks the real `frontend/dist`: every file matches the served-name rule, the head order and relative URLs, no inline script or style, no source maps, no `url(` or absolute URL in the CSS, no root-relative `/api/` in the JS, and that the backend serves each referenced file with the CSP.
- **Waits:** tests wait on observable outcomes (an SSE event, a received frame, a published marker), never on fixed sleeps.
- **Theme guard:** `tests/frontend-theme.test.mjs` checks the fallback is one `@layer base` block declaring `:root` and `.dark`, that it declares every token `index.css`'s `@theme inline` maps (colours in both modes), the imports and the class-based dark variant, that the plugin's own code has no literal colour, and that only `public/theme-init.js` touches `.dark` / `data-cc-theme`. It also keeps the Settings spacing rhythm: no margin or `space-*` utility in `SettingsPane.tsx`, every column spaced by its gap, and an empty status line hidden.
- **Coverage guard:** `tests/nondisclosure.test.mjs` compares its probe list against `ROUTES`, so a new route fails until it is checked for key leaks.
- **Real smoke tests:**
  - `tests/real-gemini.test.mjs` is skipped unless `RUN_REAL_GEMINI=1`, and reads the key from `GEMINI_API_KEY`. Models in its `CONNECT_ONLY` set skip the tool-call step (see the README's known limitations). Every model's token carries a non-default voice and custom instructions.
  - `tests/real-host.test.mjs` is skipped unless `RUN_REAL_HOST=1`. It takes `CONDUCTOR_URL` and `REAL_HOST_SESSION`, makes read-only calls, and compares the messages assembled from the events route with the host's own `get_recent_messages` (the test calls `/mcp`; `src/` does not).
