# Web Architecture

This document describes the browser application and its WebAssembly calculation
engine. It is intended for maintainers and AI coding assistants that need to
modify the site without crossing architectural boundaries or duplicating
calculation logic.

## 1. System purpose

The web application is a static, client-side loan calculator. It provides:

1. A new-loan EMI calculation.
2. A rate-revision comparison for an existing loan.
3. One or more planned-prepayment comparisons.
4. Result presentation, input validation, consistency warnings, and
   accessibility-oriented live result regions.

The browser does not persist user input or call a backend loan API. The
calculation is performed locally in a browser-compatible C++ library compiled
with Emscripten.

## 2. Deployment topology

```text
GitHub Pages
  build-wasm/web/
    index.html
    styles.css
    app.js
    scenario_planner.js
    scenario_view.js
    loan_calculator.js
    loan_calculator.wasm
```

`index.html` loads `loan_calculator.js` before the ES modules. The loader
creates the C++ module through the global `createLoanCalculator` function.
`app.js` initializes the calculator and passes it to the scenario planner.

The generated files `loan_calculator.js` and `loan_calculator.wasm` are build
artifacts. Source changes belong in `src/`, `include/`, or `web/`, not in
generated files. A normal WebAssembly build creates these artifacts in
`build-wasm/web/`; the repository's Windows pre-push script copies them into
`web/` for local Live Server use.

## 3. Source map

| Path | Responsibility |
|---|---|
| [`web/index.html`](../web/index.html) | Static page structure, form IDs, labels, scenario sections, live regions, and disclaimer. |
| [`web/app.js`](../web/app.js) | Loads the browser Wasm module, validates new-loan inputs, invokes the engine, and renders new-loan totals. |
| [`web/scenario_planner.js`](../web/scenario_planner.js) | Reads existing-loan snapshots and prepayment events, validates scenarios, invokes C++ projections, and coordinates result re-rendering. |
| [`web/scenario_view.js`](../web/scenario_view.js) | Formats INR values and signed differences; creates projection cards and status/warning text. |
| [`web/styles.css`](../web/styles.css) | Layout, responsive behavior, form, results, scenario cards, warning/error, and accessible visual styling. |
| [`src/wasm/loan_wasm.cpp`](../src/wasm/loan_wasm.cpp) | Embind bridge from JavaScript to C++ for the browser module. |
| [`src/loan/loan_calculator.cpp`](../src/loan/loan_calculator.cpp) | Reducing-balance EMI and new-loan totals. |
| [`src/loan/amortization_simulator.cpp`](../src/loan/amortization_simulator.cpp) | Existing-loan projections, rate revisions, prepayments, and status calculation. |
| [`include/dfi/loan/*.hpp`](../include/dfi/loan) | C++ public data structures and class interfaces. |
| [`tests/browser/loan-calculator.browser.test.cjs`](../tests/browser/loan-calculator.browser.test.cjs) | End-to-end browser behavior using Playwright and the built website. |

## 4. Browser startup and module lifecycle

Startup proceeds in this order:

```text
index.html
  -> loan_calculator.js
  -> app.js ES module
  -> app.js initializeCalculator()
  -> global createLoanCalculator()
  -> await createLoanCalculator()
  -> enableScenarioPlanner(calculator)
  -> enable calculate and scenario buttons
```

While Wasm initialization is incomplete, the new-loan submit button is
disabled. Submitting the form before initialization is also guarded in
`app.js`. Scenario buttons are disabled until `initializeScenarioPlanner`
receives the initialized calculator.

If the loader is unavailable or module initialization fails:

- initialization logs the original error;
- `#error-message` receives a refresh instruction;
- the calculate button remains disabled;
- scenario buttons remain disabled.

There is intentionally no JavaScript fallback EMI implementation. C++ and
Wasm are the source of truth for all calculations.

## 5. New-loan flow

The new-loan form reads:

- `principal`: loan amount in rupees.
- `interest-rate`: annual rate in percent.
- `tenure`: tenure in whole years.

Browser-side validation requires:

- principal finite, positive, and at most 1,000,000,000;
- annual rate finite and in `[0, 100]`;
- tenure a whole number in `[1, 50]` years.

The tenure is converted from years to months before crossing the Wasm bridge.
The browser calls:

```javascript
loanCalculator.calculateLoan(principal, annualRate, tenureMonths)
```

The Embind result contains:

- `monthlyEmi`;
- `totalInterest`;
- `totalRepayment`.

The UI renders these values using Indian currency formatting and reveals the
result region. The page does not round the C++ result to paise before
displaying it; `Intl.NumberFormat` controls presentation.

## 6. Existing-loan snapshot

Rate-revision and prepayment scenarios both use a loan snapshot:

```text
outstandingBalance
annualInterestRate
currentEmi
remainingTenureMonths
```

The snapshot means the balance and terms at the start of the simulation, not
the original disbursed principal or an unknown historical schedule.

Browser validation requires:

- outstanding balance finite, positive, and at most 1,000,000,000;
- annual rate finite and in `[0, 100]`;
- current EMI finite and positive;
- remaining tenure a whole number in `[1, 600]`.

No historical interest, historical rate, fees, lender-specific roundings, or
payment timing are assumed by the model. The fixed assumptions should remain
visible in the UI and documentation.

## 7. Rate-revision flow

The rate form uses the existing-loan snapshot plus a revised annual rate.
After the revised rate is validated, the browser calls:

```javascript
loanCalculator.simulateRateRevision(
    outstandingBalance,
    annualInterestRate,
    currentEmi,
    remainingTenureMonths,
    revisedRate
)
```

The engine returns three projections:

1. **Baseline**: continue the current EMI at the current rate.
2. **Keep EMI**: use the revised rate but keep the current EMI.
3. **Keep tenure**: use the revised rate and recalculate EMI to target the
   original remaining tenure.

The baseline and scenario cards expose:

- status;
- projected installments, when the loan is paid off;
- starting and latest EMI;
- projected future interest;
- projected future repayment;
- any balance remaining if the projection does not complete;
- optional signed tenure or EMI and interest differences.

After a first successful comparison, input events automatically rerun the
comparison. This behavior is guarded by `rateComparisonRequested`, so typing
does not show stale or partially invalid scenario output before a user has
requested a comparison.

The baseline consistency warning is shown if the baseline calculated payoff
tenure differs from the stated remaining tenure by more than one month.

## 8. Prepayment flow

Prepayments are represented in the DOM as repeated `.prepayment-event` rows.
Each row contains:

- an installment number;
- an extra payment amount.

The UI maintains at least one row and disables removal of the final row.
When adding a row, the installer:

- suggests an installment 12 months after the last row;
- caps the suggestion by the remaining tenure;
- defaults the amount to INR 100,000.

Prepayment validation requires:

- at least one row;
- each installment is an integer within the remaining tenure;
- each amount is finite and positive.

The browser passes the event array to:

```javascript
loanCalculator.simulatePrepayments(
    outstandingBalance,
    annualInterestRate,
    currentEmi,
    remainingTenureMonths,
    events
)
```

The engine returns:

- baseline projection;
- reduce-tenure strategy;
- reduce-EMI strategy;
- optional installment and interest savings.

Events at the same installment are combined in C++, and the applied amount is
capped at the remaining balance. A prepayment is applied after the regular EMI
for that installment.

## 9. C++ engine boundaries

The shared C++ library is not browser-specific. Its public calculation types
live under `include/dfi/loan/`.

### New loans

`LoanCalculator::calculate` performs:

- input validation;
- monthly rate calculation;
- EMI calculation;
- total interest and repayment calculation.

The browser Embind bridge converts C++ values to JS objects.

### Existing loans

`LoanAmortizationSimulator::simulateRateRevision` and
`simulatePrepayments` produce projections. Each projection contains:

- status;
- number of installments;
- initial and latest EMI;
- ending balance;
- total interest;
- regular payments;
- requested/applied prepayments;
- per-month schedule.

Projection statuses are:

| Status | Meaning |
|---|---|
| `completed` | Balance is fully paid off. |
| `non_amortizing` | EMI does not reduce the balance. |
| `term_exhausted` | The stated term ends before payoff. |
| `maximum_tenure_exceeded` | 600-installment safety limit reached. |

The C++ boundary must remain authoritative. Do not duplicate amortization
formulas in JavaScript or only in the Instagram worker.

## 10. Browser Wasm bridge

The browser bridge is [`src/wasm/loan_wasm.cpp`](../src/wasm/loan_wasm.cpp),
built with Embind.

It validates tenure with a shared 600-month upper limit and converts C++:

- `LoanResult` into a JS object;
- `LoanProjection` into a JS object;
- projection schedule entries into JS objects;
- optional integers and numeric differences into `null` or values.

Projection objects include the complete monthly schedule, although the current
browser presentation summarizes them with aggregate metrics and status cards.
Keep the schedule available for future detailed views or audits.

JS exception behavior differs from the standalone Worker Wasm bridge:

- browser Embind allows C++ `std::invalid_argument` exceptions to reach JS;
- browser UI code catches the error and calls scenario/new-loan error handlers;
- numeric and status limitations are represented in the returned object.

## 11. Standalone Wasm Worker bridge

The browser and Cloudflare outputs use independent entry modules around the
same C++ engine:

| Artifact | Entry |
|---|---|
| Browser module | `src/wasm/loan_wasm.cpp` |
| Cloudflare module | `src/wasm/loan_worker.cpp` |

The browser module uses Embind and JavaScript objects. The Worker module is a
standalone Wasm binary with exported C functions and numeric result buffers.

Do not assume that adding an export to the browser module automatically adds
it to the Worker module. CMake configures and exports both surfaces separately.

## 12. Rendering and formatting

`scenario_view.js` owns:

- INR formatting using `en-IN`;
- signed currency formatting;
- signed month formatting;
- projection card DOM construction;
- projection status text;
- live scenario warning/error text.

The create-projection-card function should remain data-oriented:

- pass projection data and optional metrics;
- let C++/Wasm define statuses and values;
- let JS only format and present values.

The UI should not infer financial correctness from formatting. Formatting
must not alter underlying values.

## 13. Validation policy

Validation is split into three intentional layers:

1. **HTML constraints**: required fields, min/max/step attributes.
2. **JavaScript UI validation**: immediate readable errors and scenario guards.
3. **C++ engine validation**: final authoritative bounds and numeric checks.

Both browser and C++ limits must remain consistent:

- maximum principal: 1,000,000,000 rupees;
- maximum annual rate: 100%;
- maximum remaining/projection tenure: 600 months;
- at most 600 prepayment events.

If a limit changes, update:

- C++ constants;
- browser validation;
- HTML max attributes;
- Embind validation;
- Worker parser boundaries;
- tests and user-facing text.

## 14. Build and test flow

WebAssembly is configured from the repository root:

```powershell
emcmake cmake -S . -B build-wasm -G Ninja `
  -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF
cmake --build build-wasm
```

CMake builds:

- `dfi_loan_wasm` for `web/loan_calculator.js` and `.wasm`;
- `dfi_loan_worker_wasm` for `cloudflare/worker/loan_worker.wasm`;
- the shared C++ `dfi_loan_engine` library.

Tests:

- C++ loan and amortization tests validate the native engine.
- Wasm worker tests validate numeric exported-worker behavior.
- browser tests use Playwright Chromium against the assembled static site.
- the browser test suite covers basic EMI, rate revision, prepayments,
  dynamic prepayment rows, scenario validation, and live UI behavior.

Run the complete Windows pre-push suite with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\prepush-windows.ps1
```

## 15. Deployment

GitHub Pages deployment happens only on pushes to `main`. The workflow:

1. checks out the repository;
2. initializes Emscripten;
3. builds all WebAssembly targets;
4. copies `web/` plus generated artifacts to `build-wasm/web/`;
5. runs Wasm, parser, Worker, and browser tests;
6. uploads the Pages artifact;
7. publishes it with the GitHub Pages action.

Pull requests and pushes to other branches run the build/test suite but do not
publish production.

## 16. Extension guidance

When adding a web feature:

1. Decide whether it belongs in browser-only presentation or C++ engine logic.
2. Add pure C++ logic or data types to `src/loan/` and `include/dfi/loan/`.
3. Add native C++ tests before relying on a browser result.
4. Expose it through the browser Embind bridge.
5. Expose it through the standalone Worker bridge only if Instagram needs it.
6. Add browser JS validation and DOM event wiring.
7. Render only engine-produced values or clearly derived UI labels.
8. Add Playwright and native/Wasm tests.
9. Update this document and the README.

Avoid adding loan formulas in:

- `app.js`;
- `scenario_planner.js`;
- `scenario_view.js`;
- `conversation.mjs`;
- standalone formatting functions.
