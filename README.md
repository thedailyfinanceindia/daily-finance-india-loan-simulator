# Daily Finance India Loan Simulator

A C++17 loan-calculation engine compiled to WebAssembly, with a browser
calculator and an Instagram messaging Worker for guided EMI calculations.

## Components

- `src/` and `include/`: C++ loan calculation and comparison code.
- `web/`: browser-based loan calculator.
- `cloudflare/worker/`: Instagram webhook Worker, input parsing, and the
  WebAssembly loan engine.
- `cloudflare/migrations/`: D1 database migrations.
- `tests/`: C++, browser, WebAssembly, parser, and Worker simulation tests.

The Cloudflare Worker keeps each Instagram sender's conversation in D1. The
sender ID is the conversation key; the Worker also checks the configured
sender allow-list before processing a message. The D1 `processed_messages`
table prevents a retried webhook message from being handled twice.

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

The GitHub Actions build runs the WebAssembly, parser, Worker simulation, and
browser tests. The Worker concurrency simulation runs locally against an
in-memory D1 substitute and intercepts outgoing `fetch` calls; it does not
contact Cloudflare or Instagram.

### Run the pre-push tests on Windows

From the repository root, run one command in PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\prepush-windows.ps1
```

[scripts/prepush-windows.ps1](scripts/prepush-windows.ps1) checks for existing
tools and packages before installing anything. It installs missing
prerequisites with `winget`, installs and activates the official Emscripten
SDK, loads its environment into the script process, builds the WebAssembly
artifacts, then runs the Worker, parser, concurrency, and browser tests. It
does not close or restart your PowerShell window.

The script requires `winget` and an internet connection. First-time package
installs may require approval or elevation and the Emscripten SDK is a large
download. If a tool is registered as installed but is still unavailable on
`PATH`, the script stops with an error instead of repeating Winget's
"no available upgrade" result. Fix the installation and rerun the same
command. The Worker test bundle targets Node 20 to avoid depending on newer
`Uint8Array.fromBase64` support.

The script runs tests only; it does not deploy to Cloudflare or contact
Instagram. CI also builds the artifacts and runs the test suite automatically.

The simulation sends concurrent, signed webhook requests for 16 synthetic
sender IDs and checks that:

- Each sender gets a separate conversation and reply.
- A webhook event delivered twice concurrently is processed only once.
- Concurrent `RESET` messages for one sender leave a fresh conversation.
- A sender outside the allow-list does not receive a reply or get a
  conversation stored.

### What the simulation does not test

The simulation exercises the Worker's request and conversation logic, but its
D1 implementation is an in-memory test double. It does not measure Cloudflare
D1 latency, Worker isolate scaling, account quotas, real network behavior, or
Meta API rate limits. The same-sender case covers concurrent resets only; it
does not establish ordering guarantees for different conversation-step
messages arriving at the same time.

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
6. Do not send rapid, out-of-order steps from the same account as a substitute
   for ordinary user behavior. The current simulation does not test ordering
   of concurrent step messages from one sender.

Keep each test short and low-volume, and stay within the limits of the
Cloudflare and Meta accounts. This manual check is a cautious staging exercise,
not a sustained-throughput benchmark. Use a separately reviewed, explicitly
rate-limited test plan before attempting a larger load test.
