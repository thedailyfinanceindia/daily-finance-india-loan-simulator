# Instagram Instabot Architecture

This document describes the Cloudflare Instagram DM bot end to end. It is for
maintainers and AI coding assistants that need to understand message ingestion,
conversation state, calculation behavior, D1 persistence, delivery retries,
deployment, tests, and safe extension patterns.

## 1. System purpose

The bot is a guided conversation interface for the same C++ loan engine used
by the browser. It supports:

1. New-loan EMI calculations.
2. Existing-loan current-position projections.
3. Existing-loan interest-rate revisions.
4. Existing-loan prepayment planning.

The bot does not retrieve balances or EMI values from a lender. Every
calculation starts from values supplied by the Instagram sender. The C++
engine performs the financial computation; JavaScript owns conversation
navigation, input parsing, formatting, state persistence, queueing, and
Meta API delivery.

## 2. Runtime topology

```text
Meta/Instagram
  POST /webhook
  signed JSON payload
       |
       v
Cloudflare Worker
  index.js
       |
       +-> webhook_protocol.mjs: signature and message extraction
       +-> access control
       +-> d1_store.persistWebhookMessages
       +-> message_processor.drainSenderSafely
                  |
                  +-> per-sender D1 lease
                  +-> getConversation
                  +-> conversation.buildMessageOutcome
                  +-> loan_engine + standalone loan_worker.wasm
                  +-> prepareOutboundReply
                  +-> Instagram Send API
                  +-> mark sent or record retry failure

Cloudflare Cron
  retryPendingMessages
       |
       +-> cleanup
       +-> retryable sender IDs
       +-> same per-sender queue/retry path
```

The runtime entry is `cloudflare/worker/index.js`. The worker's configuration
comes from `cloudflare/wrangler.toml`.

## 3. Source map

| Path | Responsibility |
|---|---|
| [`cloudflare/worker/index.js`](../cloudflare/worker/index.js) | HTTP fetch handler, GET subscription verification, webhook access control, inbox persistence trigger, and Cron dispatch. |
| [`cloudflare/worker/webhook_protocol.mjs`](../cloudflare/worker/webhook_protocol.mjs) | HMAC-SHA256 verification, payload extraction, fallback timestamps, and raw-body hashing. |
| [`cloudflare/worker/message_processor.mjs`](../cloudflare/worker/message_processor.mjs) | Per-sender queue drain, state transitions, stale-event rejection, delivery, lease renewal, and retry scheduling. |
| [`cloudflare/worker/conversation.mjs`](../cloudflare/worker/conversation.mjs) | User-facing state machine, navigation commands, input prompts, validation messages, and result formatting. |
| [`cloudflare/worker/d1_store.mjs`](../cloudflare/worker/d1_store.mjs) | D1 conversation, inbox, outbound, lease, retention, cleanup, and retry queries. |
| [`cloudflare/worker/input_parser.mjs`](../cloudflare/worker/input_parser.mjs) | Principal, annual-rate, tenure, and prepayment input parsing. |
| [`cloudflare/worker/loan_engine.mjs`](../cloudflare/worker/loan_engine.mjs) | Standalone Wasm ABI wrapper. |
| [`cloudflare/worker/loan_worker.wasm`](../cloudflare/worker/loan_worker.wasm) | Generated C++ calculation engine artifact. |
| [`src/wasm/loan_worker.cpp`](../src/wasm/loan_worker.cpp) | C ABI bridge and exported numeric result buffers. |
| [`cloudflare/worker/instagram_client.mjs`](../cloudflare/worker/instagram_client.mjs) | Meta Graph API send request and send-error classification. |
| [`cloudflare/migrations/`](../cloudflare/migrations) | D1 schema evolution. |
| [`cloudflare/wrangler.toml`](../cloudflare/wrangler.toml) | Worker, D1, Cron, and observability configuration. |

## 4. Webhook request lifecycle

### 4.1 Subscription verification

A Meta GET request verifies:

- `hub.mode === "subscribe"`;
- `hub.verify_token` equals `META_VERIFY_TOKEN`;
- `hub.challenge` is present.

Successful verification returns the challenge. Invalid verification returns
HTTP 403.

### 4.2 Signed webhook request

A POST request is handled as follows:

1. Read the raw array buffer.
2. Verify `X-Hub-Signature-256` using HMAC-SHA256 and `META_APP_SECRET`.
3. Require valid Instagram JSON with `payload.object === "instagram"`.
4. Extract text messages from `entry[].messaging[]` and supported
   `entry[].changes[].value` structures.
5. Ignore echoes and messages sent by `INSTAGRAM_ACCOUNT_ID`.
6. Apply sender allow-list rules.
7. Persist accepted messages into D1.
8. Drain the affected sender queues.
9. Return `EVENT_RECEIVED` quickly.

Signature failure returns HTTP 401. Invalid JSON returns HTTP 400. Invalid
payload object or non-text/echo events are ignored with HTTP 200.

The raw body must be used for the signature and retained through inbox
persistence; parsing or re-serializing must not replace the signed bytes.

### 4.3 Sender access control

`BOT_ACCESS_MODE` has two supported values:

- `TESTERS`: sender must be in `ALLOWED_INSTAGRAM_SENDER_IDS`;
- `PUBLIC`: all sender IDs are accepted.

Unknown mode values and empty allow-lists in `TESTERS` mode reject senders.
The allow-list is a comma-separated environment variable.

Access control happens before inbox insertion, so unauthorized senders receive
no state and no outbound reply.

## 5. D1 inbox and deduplication

`persistWebhookMessages` creates one `webhook_inbox` row per accepted message.
For each extracted message:

- `message_id` is the Meta MID when available;
- if a MID is absent, a stable fallback ID is derived from the raw-body hash
  and payload index;
- sender ID, text, event timestamp, received timestamp, and `queued` status
  are stored;
- duplicate insertions are ignored because `message_id` is unique.

The fallback identifier prevents duplicate processing within a retransmitted
payload even though Meta may omit a MID.

A batch insert failure returns a retryable HTTP 503, allowing the webhook
sender to retry the original payload.

## 6. Per-sender ordering and leases

Each Instagram sender is serialized independently using
`sender_processing`.

The queue entry is chosen by:

```text
sender_id
then event_timestamp
then sequence
```

The sequence distinguishes equal provider timestamps.

A sender lease contains:

- `lock_token`;
- `locked_until`;
- `last_event_timestamp`;
- `last_activity_at`.

The worker:

1. generates a random lock token;
2. acquires the sender lock;
3. renews the lease before processing;
4. reads the oldest queued or retryable message;
5. processes or sends it;
6. renews the lease before sending;
7. releases or retires the sender lock in `finally`.

Every conversation and outbound update checks the current lock token and an
unexpired lease in D1. A stale worker cannot commit a state transition or
outbound status after losing its lease.

Webhooks wait 250 ms before some drains to allow concurrent same-sender events
to settle in the inbox. The queue is still authoritative for provider
timestamp and sequence ordering.

## 7. Out-of-order handling

The processor keeps `lastEventTimestamp` from the acquired sender lock.

If an inbox event timestamp is lower than the last processed timestamp, the
worker returns:

```text
I received that message out of order. To avoid mixing your calculation steps,
please send that answer again now.
```

It does not apply the stale message to conversation state.

Equal timestamps are ordered by the inbox sequence and are not considered
provider-disambiguated beyond that record.

## 8. Conversation state model

Conversation state is one row per sender in `conversations`.

Core columns:

| Column | Purpose |
|---|---|
| `sender_id` | Sender and conversation key. |
| `state` | Current finite-state-machine state. |
| `principal` | Legacy/new-loan principal or temporary existing-loan principal. |
| `annual_rate` | New-loan or temporary current/revised-rate field. |
| `tenure_months` | New-loan or temporary tenure field. |
| `state_data` | JSON object holding capability-specific and existing-loan inputs. |
| `updated_at` | Conversation activity timestamp for 30-minute expiry. |

Do not reuse new-loan `principal`, `annual_rate`, or `tenure_months` fields to
hold existing-loan data. Existing-loan calculations use `state_data` keys
for type separation and persistence.

### 8.1 Major states

The state constants in `conversation.mjs` are:

| State | Meaning |
|---|---|
| `WAITING_FOR_MAIN_MENU` | Choose new-loan or existing-loan entry. |
| `WAITING_FOR_PRINCIPAL` | Collect new-loan amount. |
| `WAITING_FOR_RATE` | Collect new-loan annual rate. |
| `WAITING_FOR_TENURE` | Collect new-loan tenure. |
| `WAITING_FOR_NEW_LOAN_RESULT` | Choose next action after a new-loan result. |
| `WAITING_FOR_EXISTING_MENU` | Choose one existing-loan capability. |
| `WAITING_FOR_EXISTING_OUTSTANDING` | Collect outstanding principal. |
| `WAITING_FOR_EXISTING_RATE` | Collect current annual rate. |
| `WAITING_FOR_EXISTING_EMI` | Collect current monthly EMI. |
| `WAITING_FOR_EXISTING_TENURE` | Collect remaining tenure. |
| `WAITING_FOR_EXISTING_REVISED_RATE` | Collect revised rate. |
| `WAITING_FOR_PREPAYMENT_EVENT` | Collect prepayment events or `DONE`. |

A state transition and the reply text are committed together with the outbound
row. A send retry never reapplies the transition.

## 9. Exact entry and navigation behavior

The main-menu commands are normalized to uppercase and trimmed:

- `HI`
- `HELLO`
- `MENU`
- `RESET`

All four set or reset the conversation to `WAITING_FOR_MAIN_MENU` and return
the welcome menu. `HI` must not directly enter a new-loan calculation.

`RESET` is a global reset command. `CANCEL` deletes the conversation.
`HELP` returns instructions without changing state. If a user enters a menu
choice in the wrong state, the state handler prompts for the valid answer.

### 9.1 Main menu

The main menu returns:

```text
Welcome to Daily Finance India!
I can help you understand ...
1. Calculate a New Loan EMI
2. Analyse an Existing Loan
Reply with 1 or 2.
Send HELP for instructions.
```

Choice `1` enters `WAITING_FOR_PRINCIPAL`. Choice `2` enters
`WAITING_FOR_EXISTING_MENU`.

### 9.2 New-loan state machine

```text
MAIN_MENU
  --1--> PRINCIPAL
           --valid amount--> RATE
                              --valid rate--> TENURE
                                             --valid tenure
                                             --> result
                                             --> NEW_LOAN_RESULT

NEW_LOAN_RESULT
  --1--> PRINCIPAL
  --2--> EXISTING_MENU
  --3--> MAIN_MENU
```

Prompts collect:

1. loan amount;
2. annual interest rate;
3. tenure.

Tenure is parsed in months or years. Invalid input reuses the same state and
does not advance.

The final result includes principal, annual rate, tenure, monthly EMI, total
interest, and total repayment. It then offers the three next actions.

New-loan data is kept only in the active conversation. The final result does
not delete the conversation immediately because the bot must support choices
1, 2, and 3 after the result.

## 10. Existing-loan menu

Choice `2` at the main menu enters the existing-loan capability menu:

1. Current Loan Position
2. Interest-Rate Revision
3. Prepayment Planning

Descriptions identify what each capability answers.

All three capabilities share:

1. outstanding balance;
2. current annual rate;
3. monthly EMI;
4. remaining tenure.

## 11. Shared existing-loan input flow

```text
EXISTING_MENU
  --1/2/3--> EXISTING_OUTSTANDING
               --valid balance--> EXISTING_RATE
                                      --valid rate--> EXISTING_EMI
                                                     --valid EMI--> EXISTING_TENURE
                                                                    --valid tenure
                                                                    --> capability-specific continuation
```

The prompts are intentionally explicit:

- outstanding balance: explain that it excludes original amount;
- current annual rate;
- current monthly EMI;
- remaining tenure in months or years.

Recommended `state_data` keys are:

```json
{
  "capability": "position | rate | prepayment",
  "outstanding": 3500000,
  "currentRate": 8.5,
  "emi": 40000,
  "remainingTenure": 140,
  "revisedRate": 7.5,
  "prepayments": []
}
```

These keys are the retained source of truth for existing-loan calculations.
Use separate key names for existing-loan values rather than overwriting
new-loan fields.

If a complete existing-loan snapshot already exists in `stateData`, selecting
the capability menu again does not repeat the four basic questions:

- Position runs immediately.
- Rate revision asks only for the revised rate.
- Prepayment planning asks only for prepayment entries.

## 12. Existing-loan capability 1: Current Position

After the shared inputs, the worker calls:

```javascript
simulatePrepayments(
    outstanding,
    currentRate,
    emi,
    remainingTenure,
    []
)
```

The baseline projection answers:

```text
If I continue paying the same EMI, how long will it take to close the loan,
and how much future interest will I pay?
```

The result distinguishes:

- contractual remaining tenure;
- calculated payoff tenure;
- projected future interest;
- projected future repayment.

If the absolute difference is greater than one month, the bot warns that the
supplied EMI is projected to pay off the loan in a tenure different from the
stated tenure.

The projection uses:

- outstanding principal as opening balance;
- supplied current monthly interest rate;
- current EMI;
- supplied remaining term as engine limit for baseline behavior;
- no historical interest or prior transactions.

## 13. Existing-loan capability 2: Rate Revision

After the shared inputs, the user supplies one revised annual rate.

The worker calls:

```javascript
simulateRateRevision(
    outstanding,
    currentRate,
    emi,
    remainingTenure,
    revisedRate
)
```

The engine compares:

1. keep EMI and allow tenure to change;
2. keep remaining tenure and allow EMI to change.

The formatted response includes revised EMI, tenure or interest differences,
and the calculated future totals. Optional C++ differences are formatted as
`Unavailable` if no completed comparison exists.

## 14. Existing-loan capability 3: Prepayment Planning

Prepayment input is an amount and installment pair:

```text
100000, 12
1 lakh, 12
```

The parser accepts comma, colon, slash, or whitespace/separated formats
supported by `parsePrepayment`.

It validates:

- positive prepayment amount;
- installment from 1 through the remaining tenure;
- each individual amount does not exceed outstanding balance;
- cumulative event amounts do not exceed outstanding balance.

Send `DONE` to finish. At least one event is required.

The worker calls:

```javascript
simulatePrepayments(
    outstanding,
    currentRate,
    emi,
    remainingTenure,
    prepayments
)
```

The response compares:

1. reduce tenure by keeping the EMI;
2. reduce EMI after recalculation.

Prepayments are applied after regular EMI. Multiple events at the same
installment are combined. A prepayment cannot exceed the balance remaining
at that point.

## 15. Input parser

`input_parser.mjs` accepts:

### Principal

- plain rupees;
- `k` or `thousand`;
- `l`, `lac`, `lacs`, `lakh`, `lakhs`;
- `cr`, `crore`, `crores`;
- decimal quantities;
- optional rupee sign.

It rejects:

- commas that are not in a recognized rupee format;
- negatives;
- zero;
- values above INR 1,000,000,000;
- non-finite results.

### Annual rate

- number;
- number followed by optional `%`;
- range `[0, 100]`.

### Tenure

- integer months or month aliases;
- integer years or year aliases;
- default unit months;
- range `[1, 600]` months after conversion.

Fractions are rejected. Commas and unsupported text are rejected.

## 16. Standalone Worker Wasm engine

`loan_engine.mjs` imports `loan_worker.wasm` and:

- instantiates it with no JS imports;
- calls exported C functions;
- reads fixed numeric buffers;
- converts NaN optional values to `null`;
- throws for engine status codes other than success.

Calculation status codes:

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | invalid input |
| 2 | numeric overflow |
| 3 | unexpected calculation error |

The standalone bridge stores a maximum 600 monthly prepayment event entries.
It writes rate and prepayment results to fixed 19-value buffers and a
three-value new-loan result buffer.

The C++ engine source remains the authority. JavaScript must not implement
EMI or amortization formulas.

## 17. D1 state and conversation expiry

A conversation expires after 30 minutes by
`Date.now() - updated_at > SESSION_TIMEOUT_MS`.

Expired conversation behavior:

- a stale in-flight state transition does not apply;
- a normal message is treated as if there is no conversation;
- the state machine usually begins at the main menu or valid entry behavior;
- an existing expired row is deleted if no replacement transition is returned.

The retry/out-of-order path must preserve the lock and timestamp ordering.

## 18. State and reply atomicity

For a normal inbound message:

1. read current conversation;
2. call `buildMessageOutcome`;
3. build D1 state and outbound statements;
4. execute them in a batch with the active sender lock;
5. confirm the reply row and inbox status;
6. send the reply.

The D1 batch is intended to make a state transition and intended outbound
reply commit together.

If a send call reaches Meta but the worker loses the process before recording
the success, the result can be retried at-least-once. Retrying a pending
reply never calls `buildMessageOutcome` again.

## 19. Outbound delivery

`sendInstagramText` sends the text to:

```text
POST https://graph.facebook.com/v27.0/{INSTAGRAM_ACCOUNT_ID}/messages
```

It uses:

- `META_ACCESS_TOKEN` bearer authorization;
- 10-second abort timeout;
- JSON recipient and message fields.

Successful send:

- outbound status becomes `sent`;
- inbox status becomes `completed`;
- sender `last_event_timestamp` advances.

## 20. Delivery retry classification

An outbound attempt is counted once per send call.

Classification:

- HTTP 408, 425, 429, or 5xx: transient;
- Meta `is_transient === true`: transient;
- other 4xx: permanent;
- permanent or attempt 8: terminal.

Terminal statuses are `failed` in both inbox and outbound rows.

Transient status remains `reply_pending` and `pending`, with exponential
backoff up to one hour:

```text
1000 * 2^(attempt - 1)
```

Maximum attempts is 8.

Permanent and exhausted attempts advance the sender timestamp and stop
blocking subsequent queued messages.

## 21. Scheduled recovery

The Cron Trigger runs every minute.

It:

1. cleans expired rows;
2. finds up to 25 sender IDs with queued or due pending replies;
3. drains each sender through the same queue logic.

Cleanup targets:

- completed and failed webhook/outbound data after seven days;
- inactive sender locks after 30 days;
- compatibility `processed_messages` after 24 hours.

The Cron does not create or reapply conversation transitions for a
`reply_pending` row.

## 22. D1 schema

### Conversations

Stores current sender FSM state and existing-loan JSON state.

### webhook_inbox

Stores deduplicated inbound messages and delivery lifecycle:

- `queued`;
- `reply_pending`;
- `completed`;
- `failed`.

### outbound_messages

Stores intended reply text and send lifecycle:

- `pending`;
- `sent`;
- `failed`.

### sender_processing

Stores leases and the last processed provider timestamp.

### processed_messages

Retained by migration `0002` for compatibility and periodic cleanup.

## 23. Migration sequence

Migrations must be applied in numeric order:

1. `0002_processed_messages.sql`
2. `0003_webhook_reliability.sql`
3. `0004_terminal_webhook_failures.sql`
4. `0005_conversation_state_data.sql`

Migration `0003` creates conversation and queue tables. Migration `0004`
rebuilds terminal-failure status tables and adds failed timestamps. Migration
`0005` adds `conversations.state_data` for capability-specific JSON.

Any future conversation schema change must preserve:

- existing sender rows;
- active inbox/outbound records;
- unique message IDs;
- lease fencing;
- migration ordering.

## 24. Security and privacy

The worker requires:

- verified HMAC webhook signatures;
- sender allow-list for `TESTERS` mode;
- server-side `META_APP_SECRET`;
- server-side `META_ACCESS_TOKEN`;
- no secrets committed to source.

Conversation data is retained only to support active/recent conversations and
queue recovery. Do not log:

- raw access tokens;
- complete webhook bodies;
- PII beyond sender identifiers and calculation inputs.

Error logs may include sender ID, message ID, and truncated send error.

## 25. Deployment

The staging worker is deployed from:

- worker name `dfi-instagram-webhook-dev`;
- D1 database `dfi-instagram-conversations-dev`;
- one-minute Cron Trigger;
- `keep_vars = true` to preserve dashboard variables.

GitHub Actions:

1. builds the standalone Worker Wasm;
2. validates D1 migrations locally;
3. bundles the Worker;
4. runs parser and reliability simulation tests;
5. applies remote migrations;
6. deploys staging.

Staging deploys occur:

- on a push to `develop`;
- for same-repository pull requests targeting `develop`.

Fork pull requests validate but do not use Cloudflare credentials or deploy.
The Cloudflare staging worker and D1 database are shared, so concurrent PR
deployments replace the same tested environment.

## 26. Test strategy

### 26.1 Input parser tests

[`tests/cloudflare/input_parser.test.cjs`](../tests/cloudflare/input_parser.test.cjs)
checks principal, rate, tenure, accepted units, and invalid values.

### 26.2 Standalone Wasm tests

[`tests/wasm/loan_worker.test.cjs`](../tests/wasm/loan_worker.test.cjs)
checks C++ result exports and amortization projections.

### 26.3 Worker reliability simulation

[`tests/cloudflare/worker_concurrency.test.cjs`](../tests/cloudflare/worker_concurrency.test.cjs)
bundles the real Worker and uses an in-memory D1 substitute and intercepted
Instagram `fetch`.

It covers:

- independent senders;
- main-menu and `HI` behavior;
- duplicate webhook deliveries;
- same-sender provider ordering;
- stale older events;
- concurrent reset;
- D1 enqueue failure;
- pending-send recovery;
- lease takeover and stale-send fencing;
- permanent send failures;
- transient retry exhaustion;
- later messages after terminal failures;
- sender access control;
- existing-loan flows.

The in-memory D1 is a test double. Real migration behavior is separately
tested with local Wrangler D1. The simulation does not measure Cloudflare
latency or live Meta behavior.

## 27. Adding or changing a conversation state

Use this process:

1. Add the state constant to `conversation.mjs`.
2. Add a handler in the exact FSM order.
3. Use `stateData` for capability-specific data.
4. Keep new-loan fields separate from existing-loan fields.
5. Validate every input before advancing.
6. Return a complete next state and reply through `buildMessageOutcome`.
7. Add D1 in-memory test cases for transition and retry behavior.
8. Test `RESET`, `MENU`, `HELP`, `CANCEL`, stale events, and invalid input.
9. Update this document and the README.

Do not build unbounded state chains with implicit fields. Do not infer a
state transition from conversational text outside the explicit state handlers.

## 28. Adding a financial capability

Before adding a capability:

1. Confirm whether a C++ engine function already exists.
2. Add a native C++ model and tests if calculation logic is new.
3. Add browser Embind support if the web calculator should expose it.
4. Add standalone Worker exports and update CMake if Instagram needs it.
5. Add a thin `loan_engine.mjs` wrapper.
6. Store capability inputs in `stateData`.
7. Keep prompts, state handlers, validation, and result formatting separate.
8. Test both completed and non-completed projection statuses.
9. Use the existing disclaimer and consistency-warning patterns.

Never implement a separate EMI formula in `conversation.mjs` or in
`input_parser.mjs`.

## 29. Reliability invariants

These invariants are more important than a particular UI sentence:

1. Sender state is isolated per sender ID.
2. A webhook MID is processed once.
3. Same-sender inbox is ordered by provider timestamp and sequence.
4. Stale timestamps do not apply state transitions.
5. Conversation state and outbound reply are committed together.
6. Pending replies are retried without reprocessing input.
7. Sender leases fence state and send status updates.
8. The C++ engine is the financial calculation authority.
9. Existing-loan inputs remain separate from new-loan fields.
10. Terminal failures do not block later sender messages.
11. Public mode, allow-list mode, and signature verification remain explicit.
12. The bot is at-least-once, not exactly-once, for outbound delivery.
