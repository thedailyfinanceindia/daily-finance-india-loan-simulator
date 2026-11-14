# Daily Finance India Loan Simulator

A C++17 loan-calculation engine compiled to WebAssembly, with a browser
calculator and an Instagram messaging Worker for guided EMI calculations.

## Components

- `src/` and `include/`: C++ loan calculation, comparison, and amortization.
- `web/`: browser-based loan calculator.
- `cloudflare/worker/`: Instagram webhook Worker, input parsing, and the
  WebAssembly loan engine.
- `cloudflare/migrations/`: D1 database migrations.
- `tests/`: C++, browser, WebAssembly, parser, and Worker simulation tests.

The Worker entry point in `cloudflare/worker/index.js` handles webhook and
scheduled requests. Conversation rules, D1 persistence, queued message
processing, Instagram delivery, and webhook parsing live in separate modules
beside it. The browser entry point in `web/app.js` handles the basic EMI form;
`web/scenario_planner.js` coordinates what-if inputs and simulations, while
`web/scenario_view.js` renders projection results.

## Existing-loan scenarios

The browser calculator can project one rate revision or a schedule of planned
prepayments for an existing loan. Enter the outstanding balance, current annual
rate, current EMI, and remaining term:

- A rate revision compares keeping the current EMI (which can change the payoff
  term) with recalculating the EMI to keep the stated remaining term.
- Prepayment scenarios compare keeping the current EMI to reduce the payoff
  term with recalculating the EMI after each prepayment to keep the stated
  remaining term.
- A prepayment is applied after that installment's regular EMI. Multiple
  prepayments in one installment are combined, and the amount applied is capped
  at the remaining balance.

The projections use monthly interest at the annual rate divided by 12, do not
round values to paise during calculations, and support at most 600 installments.
The fixed-EMI projections may run longer than the entered remaining term, up to
that 600-installment limit; EMI-recalculation projections target the entered
remaining term. These estimates do not account for lender-specific rounding,
fees, rate-change timing, or other loan terms. Confirm any decision with your
lender.

The Cloudflare Worker keeps each Instagram sender's conversation in D1. The
sender ID is the conversation key; the Worker also checks the configured
sender allow-list before processing a message. Verified webhook messages are
first persisted to a D1 inbox with a unique message ID. Conversation state
changes and their intended replies are committed together with an outbound
record. A per-sender lease serializes processing, and a one-minute Cron Trigger
retries pending replies and recovers queued work after a Worker interruption.
Every state transition and outbound status update is fenced by the sender's
lock token and an unexpired lease checked by D1. The Worker renews the lease
before sending; a process that loses ownership cannot commit its stale result.

Outbound delivery is at-least-once. If Instagram accepts a reply but the
Worker fails before it can record that success in D1, a later retry can send
the reply again; the API does not provide a reliable idempotency guarantee for
this operation. Transient network errors, HTTP 408/425/429 and 5xx responses
are retried with exponential backoff, up to eight send attempts. A Meta error
marked `is_transient` is also retried. Other 4xx responses are treated as
permanent. Permanent errors and exhausted retries are marked `failed`, logged
with their error, and retained for seven days; they no longer block later
messages from that sender. A sender cannot be notified through the same Send
API when Meta rejects delivery. The older `processed_messages` table is
retained for compatibility and periodic cleanup.

## Cloudflare configuration

The staging Worker and D1 binding are declared in
[`cloudflare/wrangler.toml`](cloudflare/wrangler.toml). The current Worker is
named `dfi-instagram-webhook-dev`.

Configure these values in the Cloudflare Worker settings; do not commit their
values to the repository:

| Name | Type | Purpose |
| --- | --- | --- |
| `ALLOWED_INSTAGRAM_SENDER_IDS` | Variable | Comma-separated Instagram sender IDs allowed to use the bot. |
| `BOT_ACCESS_MODE` | Variable | Use `TESTERS` for the sender allow-list. The Worker defaults to `TESTERS`. |
| `META_ACCESS_TOKEN` | Secret | Authorizes replies through the Instagram API. |
| `META_APP_SECRET` | Secret | Verifies webhook request signatures. |
| `META_VERIFY_TOKEN` | Secret | Verifies the webhook subscription with Meta. |

`keep_vars = true` in the Wrangler configuration preserves dashboard-managed
variables during Wrangler deploys. Workers Logs are enabled through the
`[observability]` configuration. After changing Worker settings, check the
Worker's **Observability** page to confirm logs are arriving.

The GitHub Actions credentials are separate from the Worker runtime settings.
The deployment workflow reads the repository Actions secrets
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The token needs access to
the account that owns the D1 database, including **D1: Edit** for migrations
and **Workers Scripts: Edit** for deployment. Do not put these credentials in
the Worker runtime variables or in source control.

## Tests

The GitHub Actions build validates D1 migrations locally, then runs the
WebAssembly, parser, Worker simulation, C++ amortization, and browser tests.
The browser tests cover rate-revision projections, both prepayment strategies,
dynamic prepayment rows, and scenario validation. The Worker
simulation uses an in-memory D1 substitute and intercepts outgoing `fetch`
calls; it does not contact Cloudflare or Instagram. A successful pull request
build targeting `develop` deploys the Instagram Worker to staging when the PR
comes from this repository. A push to `develop` also deploys staging. Pull
requests from forks run validation only because Cloudflare credentials are not
available to them. PR deployments use the existing shared staging Worker and
D1 database, so each deployment replaces the code currently being tested there;
coordinate staging tests if multiple PRs are open. Production website
deployment remains limited to pushes to `main`.

### Run the pre-push tests on Windows

From the repository root, run one command in PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\prepush-windows.ps1
```

[scripts/prepush-windows.ps1](scripts/prepush-windows.ps1) checks for existing
tools and packages before installing anything. It installs missing
prerequisites with `winget`, installs and activates the official Emscripten
SDK, loads its environment into the script process, builds the WebAssembly
artifacts, copies the browser module into `web/` for VS Code Live Server, then
runs the Worker, parser, concurrency, and browser tests. It does not close or
restart your PowerShell window.

The copied browser loader and WebAssembly binary are generated, ignored
artifacts; CI assembles them in `build-wasm/web/`.

The script requires `winget` and an internet connection. First-time package
installs may require approval or elevation; Wrangler and the Emscripten SDK
are downloads. If a tool is registered as installed but is still unavailable on
`PATH`, the script stops with an error instead of repeating Winget's
"no available upgrade" result. Fix the installation and rerun the same
command. The Worker test bundle targets Node 20 to avoid depending on newer
`Uint8Array.fromBase64` support.

The script runs tests only; it does not deploy to Cloudflare or contact
Instagram. CI also builds the artifacts and runs the test suite automatically.

The simulation sends concurrent, signed webhook requests for 16 synthetic
sender IDs and checks that:

- Each sender gets a separate conversation and reply.
- Duplicate webhook deliveries produce a single state transition and reply.
- Different messages for one sender are processed by provider timestamp;
  late older events are rejected without overwriting newer state.
- Concurrent `RESET` messages for one sender leave a fresh conversation.
- A failed database enqueue returns a retryable HTTP error.
- A failed Instagram send leaves its reply pending and the scheduled retry
  sends it without applying the conversation transition again.
- A paused Worker that loses its sender lease cannot overwrite a takeover's
  conversation state or send a stale reply.
- Permanent Send API errors and exhausted transient retries become terminal,
  while later messages for that sender continue to process.
- A sender outside the allow-list does not receive a reply or get a
  conversation stored.

### What the simulation does not test

The simulation exercises the Worker's request and conversation logic, but its
D1 implementation is an in-memory test double. Migrations are separately
applied by Wrangler to a fresh local D1 database. Migration `0003` creates the
conversation table if it is absent, while leaving a previously created table
untouched. These checks do not measure Cloudflare D1 latency, Worker isolate
scaling, account quotas, real network behavior, or Meta API rate limits. The
Worker orders messages already in its queue by provider timestamp and rejects
older events that arrive after a newer event was processed. No webhook can
guarantee ordering if an older event arrives after a newer event has already
been processed, and equal timestamps cannot disambiguate provider order.

## Controlled staging concurrency check

Use this procedure only with the staging Worker, an isolated staging D1
database, and Instagram test accounts. The Worker sends real replies to
recipients, so do not use customer accounts or production credentials.

1. Confirm the staging Worker is deployed, its D1 migrations have succeeded,
   and Workers Logs are enabled.
2. Set `BOT_ACCESS_MODE` to `TESTERS` and configure
   `ALLOWED_INSTAGRAM_SENDER_IDS` with only the test accounts. Never switch to
   `PUBLIC` for a load test.
3. Start with one test account. Send `HI`, then complete the amount, rate, and
   tenure steps. Confirm the reply and resulting conversation behavior before
   adding more testers.
4. Have a small group of test accounts send `HI` within the same short
   interval. Begin with only a few accounts; inspect the results before
   increasing the group. Repeat the normal conversation steps on separate
   accounts to check that state and replies remain isolated.
5. After each wave, review the Worker **Observability** logs and D1 metrics.
   Record request duration, invocation errors, D1 errors, and Instagram Send
   API errors. Stop the test if errors appear, latency rises sharply, or an
   account limit is approached.
6. Confirm an older event arriving after a newer one gets a resend prompt,
   rather than advancing or overwriting the conversation. Do not use rapid,
   out-of-order steps as a load test; ordinary users should follow each reply.

Keep each test short and low-volume, and stay within the limits of the
Cloudflare and Meta accounts. This manual check is a cautious staging exercise,
not a sustained-throughput benchmark. Use a separately reviewed, explicitly
rate-limited test plan before attempting a larger load test.
