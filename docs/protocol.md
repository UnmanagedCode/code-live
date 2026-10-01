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
| `host` | `{connected:boolean}` | on connect (no id), and when the backend's host `/ws` link opens or closes |
| `announce` | `{sessionId, title, text, turnSeq, isError, ask}` | when an announced conductor finishes a turn (`sessionId` names it). `text` is at most 4000 chars, or `(turn finished with no text reply)`. `ask` is `{kind:"question", count, truncated?, dropped?}` (AskUserQuestion pending; `text` holds the `--- questions ---` section; `truncated:true` means its lines were shortened to fit 4000 chars, and `dropped:true` that whole trailing lines (options, or questions) are missing and the last line says how many), `{kind:"plan", planPath:string\|null}` (ExitPlanMode pending), or `null` |

- **Replay:** the backend keeps the last 20 id-bearing events.
  - A request with `Last-Event-ID` from this process gets every ring event after it.
  - A `Last-Event-ID` from a different process (other `<boot>`) gets the whole ring.
  - A request without `Last-Event-ID` gets no ring events.
  - The id is read from the `Last-Event-ID` header, or, when the header is absent or empty, from the `lastEventId` query parameter (`GET api/events?lastEventId=<id>`). The page uses the query after it re-creates its EventSource, which cannot set a header. When both are sent, the header wins.
- Keepalive is a `: ping` comment every 25 s.

## Tools

The declarations are `DECLARATIONS` in `src/tools.js`, with parameter types in Gemini schema form (`OBJECT`/`STRING`/`INTEGER`). For `gemini-3.8-live-extended-thinking`, each declaration also carries `behavior: "NON_BLOCKING"`: the model rejects blocking declarations and supports no function `scheduling`, so the `toolResponse` never carries one ([model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live-extended-thinking)).

| name | parameters |
|---|---|
| `list_conductor_sessions` | none |
| `create_conductor_session` | none |
| `send_to_conductor` | `session` STRING (required), `text` STRING (required, non-empty) |
| `read_conductor_messages` | `session` STRING (required), `count` INTEGER (optional, 1–10) |
| `answer_conductor_question` | `session` STRING (required), `answers` ARRAY (required) of OBJECT `{choices: ARRAY<STRING>, text: STRING, note: STRING}`; entry *n* answers question *n*. A choice is an option number or its words (numbers are also accepted) |
| `approve_conductor_plan` | `session` STRING (required), `confirmed` BOOLEAN (required; must be `true`), `feedback` STRING (optional) |
| `reject_conductor_plan` | `session` STRING (required), `feedback` STRING (optional) |

`session` is a conductor id or an exact title, case-insensitive. A missing, empty or whitespace-only `session` is `INVALID_ARGS`, and a non-string one is `INVALID_ARGS` too, both before any host request. A tool acts only on the conductor it names. `send_to_conductor`, `create_conductor_session`, `answer_conductor_question`, `approve_conductor_plan` and `reject_conductor_plan` also add that conductor to the announced set (see [Announced conductors](features.md#announced-conductors)).

### Tool results

A session summary is `{sessionId, title, status, lastResponseAt}`. `status` is the host's run state, derived from the `GET /api/instances` row fields `status`, `displayStatus` and `awaitingWake` (`summarize` in `src/hostEvents.js`). `title` is the instance title, else the first prompt cut to 60 chars (`…` suffix), else `Untitled conductor`.

| host row | reported `status` |
|---|---|
| `idle`, `displayStatus` `idle` or absent, `awaitingWake` false | `idle`: nothing is in flight |
| `idle`, `displayStatus` `idle`, `awaitingWake` true | `on a worker`: the host's own label for a conductor waiting on a worker |
| `idle`, `displayStatus` `running` (background subagents), any `awaitingWake` | `running` |
| `turn`, `spawning`, `exited`, `crashed`, any `awaitingWake` | unchanged |

| tool | success |
|---|---|
| `list_conductor_sessions` | `{ok:true, sessions:[summary]}` |
| `create_conductor_session` | `{ok:true, session:summary}` |
| `send_to_conductor` | `{ok:true, sessionId, title, delivered:true, note:"The reply will be announced when the conductor finishes its turn."}` |
| `read_conductor_messages` | `{ok:true, sessionId, title, messages:[{text, hasPlan?, planPath?, questionCount?}]}`: oldest first, each `text` ≤ 4000 chars. See [reading messages](#reading-messages) |
| `answer_conductor_question` | `{ok:true, sessionId, title, delivered:true, answered:[{question, answer}], note}`; `question` is 1-based and `answer` is the label list or the free text that was sent |
| `approve_conductor_plan` | `{ok:true, sessionId, title, mode, delivered:true, note}`; `mode` is the host's reported mode (`bypassPermissions`) |
| `reject_conductor_plan` | same shape as approve; `mode` stays `plan` |

Failures are `{ok:false, code, message}`:

| code | meaning |
|---|---|
| `INVALID_ARGS` | argument type or bounds wrong, `session` missing, or `args` not an object |
| `UNKNOWN_TOOL` | no such tool |
| `SESSION_GONE` | the host 404s the session |
| `NOT_A_CONDUCTOR` | the id names a worker session; nothing is sent to it |
| `UNKNOWN_SESSION` | no conductor matches; the message lists the available ones |
| `AMBIGUOUS_SESSION` | several conductors share the title; the message lists their ids |
| `HOST_UNAVAILABLE` | the host is unreachable, or the `/ws` link is not open (prompts are not queued) |
| `HOST_HTTP_ERROR` | the host returned a non-2xx other than 404 |
| `HOST_REFUSED` | the prompt ack was `ok:false` (e.g. `not running`) |
| `ACK_TIMEOUT` | no ack within 10 s |
| `HOST_DISCONNECTED` | the `/ws` link dropped before the ack |
| `SESSION_NOT_READY` | the conductor row has no host session id yet (still spawning) |
| `NO_PENDING_QUESTION` | the named conductor's row shows no unanswered tool question; the message starts with its title |
| `NO_PENDING_PLAN` | the named conductor's row shows no unanswered tool plan, or the host's latest messages hold none; the message starts with its title and says which |
| `CONFIRMATION_REQUIRED` | `approve_conductor_plan` without `confirmed: true` |
| `INVALID_OPTION` | a choice matches no option, or several; carries `question` and `offered` |
| `NOT_MULTISELECT` | several choices for a question the host treats as single-choice (only when its options could not be read first); carries the 1-based `question` |
| `TOO_MANY_CHOICES` | several choices for a single-choice question; carries `question` and `offered` |
| `ANSWER_COUNT_MISMATCH` | more answer entries than questions |
| `HOST_MCP_ERROR` | `/mcp` returned a JSON-RPC error, an `isError` result, or an unreadable result; the message carries the host's text |
| `HOST_TIMEOUT` | `/mcp` did not answer within 10 s. For answer, approve and reject the message says the call may have been delivered: do not resend without checking |
| host refusal codes | a soft refusal from the host's tool, passed through with its code and reason, e.g. `SESSION_NOT_LIVE`, `NO_PENDING_QUESTION`, `EMPTY_ANSWER` |
| `INTERNAL_ERROR` | unexpected failure (logged) |

### Reading messages

- **No `count`:** the host's default selection. The latest message is bonded back to the plan or questions message of its own turn, so `messages` can hold several entries.
- **Explicit `count`:** exactly that many messages, literally and without bonding, as the host treats an explicit count.
- Each `text` is the message body as the host renders it: prose, then a `--- plan ---` / `--- plan · saved to <path> ---` section and a `--- questions ---` section (`N. <question> (multiSelect: <bool>) · header: <h>`, then `   - <label>: <description>` per option) in the order they occurred. The host's `--- message i/N … ---` boundary line is dropped.
- `hasPlan`, `planPath` and `questionCount` appear only on the message that carries them.
- A `text` over 4000 chars keeps a trailing questions section whole and cuts the prose before it. A questions section that alone exceeds 4000 chars is shortened line by line (every line capped at 160, then 80, 40 and 20 chars until it fits, so descriptions go first but a label longer than the cap is cut too) and the message gets `questionsTruncated:true`. If even 20-char lines do not fit, trailing lines are dropped whole, the section ends with `… N more line(s) not shown`, and the message also gets `questionsDropped:true`. Anything else is cut from the end.
- If the `/mcp` read fails, or the session has no host session id yet, the result is the last `count` (default 1) assistant text messages from the events route, as `[{text}]`, and the failure is logged.

### Answering and deciding

- **Pending gates** use the session row's `awaitingUser` / `awaitingUserSource`, because the host's `answer_question` and `approve_plan` do not check that anything is pending. A question needs `awaitingUser === "question"` and `awaitingUserSource === "tool"`. A plan needs `"plan"` and `"tool"`, and a fresh `get_recent_messages` that has a message with `hasPlan`.
- **Choice resolution**, first match wins: exact label, option number (`2`, `option 2`), label equal after folding case, whitespace and punctuation, equal with a trailing parenthetical such as ` (Recommended)` dropped, then a unique partial match. No match, or several at one step, is `INVALID_OPTION`.
- The question structure comes from the newest top-level (no `parentToolUseId`) `user_question` event (`GET /api/instances/:id/events`). If none is found, choices pass through to the host unchanged.
- **Retry:** when the host answers `INVALID_OPTION` with its `offered` labels, the spoken words are resolved once against those labels and the call is repeated once. A second refusal is returned as `INVALID_OPTION` with `question` and `offered`.
- **Approval:** `confirmed` must be exactly `true`, else `CONFIRMATION_REQUIRED` with no host call at all. The host switches a plan-mode conductor to `bypassPermissions` on approval. Reject keeps plan mode.
- **Announcements:** the ask being answered or decided is marked handled before the host write, so it is not announced while the host still shows it. A failed write (any error from the host call) undoes the mark and the ask is announced again.
- Missing trailing answer entries are skipped; extra entries are `ANSWER_COUNT_MISMATCH`.
- A failed result may add `question` (1-based), `offered` (labels) and, for `ANSWER_COUNT_MISMATCH`, `expected` and `got`.

## code-conductor host calls

All calls go to `$CONDUCTOR_URL`, with a 5 s timeout for REST.

| purpose | call |
|---|---|
| list sessions | `GET /api/instances`. Conductor rows have `project === ".conduct"` |
| create a conductor | `POST /api/projects/.conduct/ensure` (no body), then `POST /api/instances` with `{"project":".conduct","role":"conductor","temp":true,"mode":"bypassPermissions"}` → 201 summary |
| read events | `GET /api/instances/:id/events?limit=500`. Uses `kind`/`_seq`/`lastSeq`, `assistant_message.{msgId,message.content[].{type,text}}`, `turn_end.isError`, `user_question.{toolUseId,questions}` and `plan_request.{toolUseId,plan,planPath,autoApproved}`. Events with `parentToolUseId` (sub-agents) are ignored, as the host's own turn reconstruction does |
| send a prompt | WS `/ws`: `{"t":"prompt","id":"<instance id>","text":"…","reqId":"code-live-<n>"}` → `{"t":"ack","reqId","ok","error"?}` |
| turn ends | WS `/ws` broadcast `{"t":"turn_notification","id","project","isError","stopReason","cost"}` |
| instance list changed | WS `/ws` broadcast `{"t":"instances",…}`. Only its arrival matters: the row is re-read over REST. Other frame types are ignored |
| instance row fields used | `id`, `project`, `sessionId` (the host's public session id, `null` while spawning; the `/mcp` handle), `awaitingUser` (`"question"` \| `"plan"`), `awaitingUserSource` (`"tool"` for AskUserQuestion / ExitPlanMode), `lastResponseAt`, plus the status fields above |
| MCP tools | `POST /mcp`, 10 s timeout, stateless: one `{"jsonrpc":"2.0","id":<n>,"method":"tools/call","params":{"name","arguments"}}` per request, no `initialize`. Only `src/hostMcp.js` makes it |

### `/mcp` tools

The reply is `{result:{content:[{type:"text",text}…], isError?}}` or `{error:{code,message}}`. A soft refusal is `content[0]` holding JSON `{ok:false, code, reason, …}` with no `isError`; `isError:true` carries prose in `content[0]`. All `sessionId` arguments are the row's `sessionId`.

| tool | arguments | used for |
|---|---|---|
| `get_recent_messages` | `sessionId`, optional `count` | `content[0]` is metadata JSON `{messages:[{msgId, hasPlan?, planPath?, questionCount?, …}], …}`; `content[k+1]` is the raw body of `messages[k]`. No `count` bonds the default selection; `count` is literal |
| `answer_question` | `sessionId`, `answers` (0-based, one per question: `{option}`, `{options}`, `{text}` or `{}`, plus optional `note`) | answering; refusals `INVALID_OPTION` (with `questionIndex`, 0-based, and `offered`), `NOT_MULTISELECT`, `ANSWER_COUNT_MISMATCH`, `EMPTY_ANSWER` |
| `approve_plan` | `sessionId`, optional `feedback` | approving; returns `{sessionId, mode, sentText}` |
| `reject_plan` | `sessionId`, optional `feedback` | rejecting; returns `{sessionId, mode, sentText}` |

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
| `{"realtimeInput":{"audio":{"data":"<b64>","mimeType":"audio/pcm;rate=16000"}}}` | mic chunks (16-bit LE mono) while the mic is not paused |
| `{"realtimeInput":{"audioStreamEnd":true}}` | `pauseMic()` while live, once per pause |
| `{"realtimeInput":{"text":"CONDUCTOR UPDATE from \"<title>\" (session <id>):\n<text>[\n<footer>]"}}` | announcements; does not interrupt current speech. `<footer>` is the `AWAITING ANSWER` / `AWAITING PLAN APPROVAL` line, naming the tool and `session <id>`, when `ask` is set. Line breaks (`\n`, `\r`, `\v`, `\f`, U+0085, U+2028, U+2029) in `<title>`, `<id>` and a plan path in the footer become spaces, and `"` in `<title>` becomes `'`. A `<text>` line that reads as `CONDUCTOR UPDATE` or `AWAITING ` gets a leading `> `: invisible characters (`\p{Cf}`, default-ignorable code points) are dropped, any Unicode space counts as a space, and case is ignored when deciding; the same breaks split `<text>` into lines. The transcript shows the title and text unchanged |
| `{"toolResponse":{"functionResponses":[{"id","name","response":<tool result>}]}}` | after each tool call, unless cancelled; no `scheduling` field |

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
