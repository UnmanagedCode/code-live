# Protocol

Interface contracts of the code-live backend, and the code-conductor and Gemini APIs it uses. The host's plugin proxy maps `/plugins/code-live/<x>` to the backend's `/<x>`. The page uses only relative URLs, so the paths below are what the backend sees.

## Common rules

- **Headers on every response**, including static files, 404s and SSE:
  - `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' <Gemini Live origin>; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`. The Gemini Live origin is `wss://generativelanguage.googleapis.com` in production, derived from `CODE_LIVE_GEMINI_BASE`.
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: no-referrer`
  - `Cache-Control: no-store`
- **Request bodies** (routes that take one):
  - must be `content-type: application/json`, else `415 UNSUPPORTED_MEDIA_TYPE`;
  - at most 64 KB, else `413 BODY_TOO_LARGE`;
  - a JSON object, else `400 INVALID_JSON`.
- **Errors** are `{"error": "<message>", "code": "<CODE>"}`. Codes map to HTTP status as `STATUS_BY_CODE` in `server.js` defines. An unexpected error is `500 {"error":"internal error","code":"INTERNAL_ERROR"}`, logged server-side.
- **Malformed request target:** a request target that does not parse as a path (e.g. `//`, which the host's proxy forwards for `/plugins/code-live//`) gets `400 {"error":"malformed request target","code":"BAD_REQUEST"}`, with the headers above.
- **Static files:** every file in `public/` with a known extension is served at `/<name>`, and `/` serves `index.html`. Anything else is `404 {"error":"not found","code":"NOT_FOUND"}`.
- The API key is never returned by any route.

## Routes

The route table is `ROUTES` in `src/routes.js`.

| method | path | request | response |
|---|---|---|---|
| GET | `/api/health` | none | `{ok:true}`; the host's readiness probe |
| GET | `/api/settings` | none | `{apiKey:{set:boolean, tail:string\|null}}` (tail = last 4 chars) |
| PUT | `/api/settings/api-key` | `{apiKey:string}` | `{apiKey:{set,tail}}`. `400 INVALID_KEY` unless it is 20–512 printable non-space ASCII characters after trimming (the message never echoes the value) |
| DELETE | `/api/settings/api-key` | none | `{apiKey:{set:false, tail:null}}` |
| GET | `/api/models` | none | `{models:[{id, label, hint?}]}`; `hint` is present only for models that have one in `MODELS` |
| POST | `/api/token` | `{model:string, resumeHandle?:string}` | `{token, wsUrl, model, expireTime}`; see [Token minting](#token-minting) |
| POST | `/api/tools/call` | `{name:string, args?:object}` | always `200` with the [tool result](#tool-results); `400 INVALID_ARGS` only when `name` is not a string |
| GET | `/api/conductors` | none | same as the `list_conductor_sessions` result |
| PUT | `/api/target` | `{sessionId:string\|null}` | `{activeTarget:{sessionId,title}\|null}`. `null` clears. A string resolves like a tool's `session` arg (errors: `NOT_A_CONDUCTOR` 400, `UNKNOWN_SESSION` 404, `AMBIGUOUS_SESSION` 409) |
| GET | `/api/events` | none | SSE stream; see below |

### `POST /api/token` errors

| status | code | when |
|---|---|---|
| 400 | `UNKNOWN_MODEL` | `model` is not a pinned model id |
| 400 | `INVALID_ARGS` | `resumeHandle` fails `/^[A-Za-z0-9_-]{1,256}$/` |
| 409 | `NO_API_KEY` | no key stored |
| 502 | `GEMINI_ERROR` | the mint failed; the message is `Gemini token mint failed (<status>): <upstream error.message>`. Any run of 8+ characters copied from the key is replaced with `[redacted]`. Upstream headers and body are never forwarded |
| 500 | `STORE_CORRUPT` | `secrets.json` is unreadable JSON or lacks `geminiApiKey` |

## SSE: `GET /api/events`

Each frame is `id: <boot>-<n>` / `event: <name>` / `data: <json>`. `<boot>` is random per backend process.

| event | data | sent |
|---|---|---|
| `target` | `{sessionId, title}` or `null` | on connect (**no id**; the current target, or `null` unless it is a live conductor row the host confirms), and on every target change |
| `host` | `{connected:boolean}` | on connect (no id), and when the backend's host `/ws` link opens or closes |
| `announce` | `{sessionId, title, text, turnSeq, isError}` | when the active target finishes a turn. `text` is at most 4000 chars, or `(turn finished with no text reply)` |

- **Replay:** the backend keeps the last 20 id-bearing events.
  - A request with `Last-Event-ID` from this process gets every ring event after it.
  - A `Last-Event-ID` from a different process (other `<boot>`) gets the whole ring.
  - A request without `Last-Event-ID` gets no ring events.
- Keepalive is a `: ping` comment every 25 s.

## Tools

The declarations are `DECLARATIONS` in `src/tools.js`, with parameter types in Gemini schema form (`OBJECT`/`STRING`/`INTEGER`). For `gemini-3.8-live-extended-thinking`, each declaration also carries `behavior: "NON_BLOCKING"`.

| name | parameters |
|---|---|
| `list_conductor_sessions` | none |
| `create_conductor_session` | none |
| `send_to_conductor` | `text` STRING (required, non-empty), `session` STRING (optional: conductor id or exact title, case-insensitive) |
| `read_conductor_messages` | `session` STRING (optional), `count` INTEGER (optional, 1–10, default 1) |

An omitted `session` (or one that is empty or whitespace) means the active target.

### Tool results

A session summary is `{sessionId, title, status, lastResponseAt}`. `status` is the host's run state, derived from the `GET /api/instances` row fields `status`, `displayStatus` and `awaitingWake` (`summarize` in `src/hostEvents.js`); the target picker shows the same value. `title` is the instance title, else the first prompt cut to 60 chars (`…` suffix), else `Untitled conductor`.

| host row | reported `status` |
|---|---|
| `idle`, `displayStatus` `idle` or absent, `awaitingWake` false | `idle`: nothing is in flight |
| `idle`, `displayStatus` `idle`, `awaitingWake` true | `on a worker`: the host's own label for a conductor waiting on a worker |
| `idle`, `displayStatus` `running` (background subagents), any `awaitingWake` | `running` |
| `turn`, `spawning`, `exited`, `crashed`, any `awaitingWake` | unchanged |

| tool | success |
|---|---|
| `list_conductor_sessions` | `{ok:true, sessions:[summary + active:boolean], activeTarget:{sessionId,title}\|null}` |
| `create_conductor_session` | `{ok:true, session:summary, activeTargetChanged:true, activeTarget:{sessionId,title}}` |
| `send_to_conductor` | `{ok:true, sessionId, title, delivered:true, note:"The reply will be announced when the conductor finishes its turn."}`, plus `activeTargetChanged:true, activeTarget` when the target switched |
| `read_conductor_messages` | `{ok:true, sessionId, title, messages:[{text}]}`: oldest first, each ≤ 4000 chars. Only assistant messages with non-empty text blocks count |

Failures are `{ok:false, code, message}`:

| code | meaning |
|---|---|
| `INVALID_ARGS` | argument type or bounds wrong, or `args` not an object |
| `UNKNOWN_TOOL` | no such tool |
| `NO_ACTIVE_TARGET` | `session` omitted and no target set |
| `SESSION_GONE` | the active target is no longer live (the target is cleared), or the host 404s the session |
| `NOT_A_CONDUCTOR` | the id names a worker session; nothing is sent to it |
| `UNKNOWN_SESSION` | no conductor matches; the message lists the available ones |
| `AMBIGUOUS_SESSION` | several conductors share the title; the message lists their ids |
| `HOST_UNAVAILABLE` | the host is unreachable, or the `/ws` link is not open (prompts are not queued) |
| `HOST_HTTP_ERROR` | the host returned a non-2xx other than 404 |
| `HOST_REFUSED` | the prompt ack was `ok:false` (e.g. `not running`) |
| `ACK_TIMEOUT` | no ack within 10 s |
| `HOST_DISCONNECTED` | the `/ws` link dropped before the ack |
| `INTERNAL_ERROR` | unexpected failure (logged) |

If a send switched the target and then failed, its message ends with `("<title>" is now the active target.)`.

## code-conductor host calls

All calls go to `$CONDUCTOR_URL`, with a 5 s timeout for REST.

| purpose | call |
|---|---|
| list sessions | `GET /api/instances`. Conductor rows have `project === ".conduct"` |
| create a conductor | `POST /api/projects/.conduct/ensure` (no body), then `POST /api/instances` with `{"project":".conduct","role":"conductor","temp":true,"mode":"bypassPermissions"}` → 201 summary |
| read events | `GET /api/instances/:id/events?limit=500`. Uses `kind`/`_seq`, `assistant_message.message.content[].{type,text}` and `turn_end.isError` |
| send a prompt | WS `/ws`: `{"t":"prompt","id":"<instance id>","text":"…","reqId":"code-live-<n>"}` → `{"t":"ack","reqId","ok","error"?}` |
| turn ends | WS `/ws` broadcast `{"t":"turn_notification","id","project","isError","stopReason","cost"}`. Other frame types are ignored |

## Gemini

### Token minting

`POST <base>/v1beta/auth_tokens`, headers `x-goog-api-key: <key>` and `content-type: application/json`:

```json
{"uses":1,
 "expireTime":"<now+30 min, YYYY-MM-DDTHH:MM:SSZ>",
 "newSessionExpireTime":"<now+60 s>",
 "bidiGenerateContentSetup":{
   "model":"models/<id>",
   "generationConfig":{"responseModalities":["AUDIO"], "thinkingConfig":{"thinkingLevel":"low"}},
   "systemInstruction":{"parts":[{"text":"<SYSTEM_PROMPT>"}]},
   "tools":[{"functionDeclarations":[…DECLARATIONS…]}],
   "inputAudioTranscription":{}, "outputAudioTranscription":{},
   "sessionResumption":{} ,
   "contextWindowCompression":{"slidingWindow":{}}}}
```

- `thinkingConfig` is present only for models with a `thinkingLevel` in `src/models.js`.
- `sessionResumption` is `{"handle":"<h>"}` when resuming.
- `SYSTEM_PROMPT` is in `src/liveSetup.js`.
- The response is `{"name":"auth_tokens/…"}`, and `name` is the token.
- The token's setup is authoritative: the client's own setup is ignored.

### Live socket

The page connects to `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=<urlencoded token>`, sends `{"setup":{}}`, and is live on `{"setupComplete":{}}`. Without `setupComplete` within 15 s (`setupTimeoutMs`), the client closes the socket and treats the attempt as failed. Server frames may be text or binary JSON, and empty `{}` frames are ignored.

**Client → Gemini:**

| message | when |
|---|---|
| `{"realtimeInput":{"audio":{"data":"<b64>","mimeType":"audio/pcm;rate=16000"}}}` | mic chunks (16-bit LE mono) |
| `{"realtimeInput":{"audioStreamEnd":true}}` | `endAudio()` |
| `{"realtimeInput":{"text":"CONDUCTOR UPDATE from \"<title>\":\n<text>"}}` | announcements; does not interrupt current speech |
| `{"toolResponse":{"functionResponses":[{"id","name","response":<tool result>}]}}` | after each tool call, unless cancelled |

**Gemini → client:**

| message | handling |
|---|---|
| `serverContent.modelTurn.parts[].inlineData` (`audio/pcm;rate=24000`) | played |
| `serverContent.inputTranscription.text` / `outputTranscription.text` | merged into You / Gemini bubbles |
| `serverContent.interrupted` | playback flushed |
| `serverContent.turnComplete` (+ `interactionStatus`) | transcript bubble closed, unless `interactionStatus` is `IN_PROGRESS` |
| `toolCall.functionCalls[{id,name,args}]` | `POST api/tools/call`, then `toolResponse` |
| `toolCallCancellation.ids` | responses for those ids are dropped |
| `sessionResumptionUpdate{newHandle,resumable}` | handle kept when `resumable` and non-empty |
| `goAway` | resume: new token with the handle, new socket (old one closed with 1000) |
