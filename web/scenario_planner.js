import {
    createProjectionCard,
    formatINR,
    formatSignedCurrency,
    formatSignedMonths,
    showScenarioError
} from "./scenario_view.js";

const MAX_TENURE_MONTHS = 600;

function readSnapshot() {
    const outstandingBalance = Number(
        document.getElementById("outstanding-balance").value
    );
    const annualInterestRateInput =
        document.getElementById("current-interest-rate").value.trim();
    const annualInterestRate = annualInterestRateInput === ""
        ? Number.NaN
        : Number(annualInterestRateInput);
    const currentEmi = Number(
        document.getElementById("current-emi").value
    );
    const remainingTenureMonths = Number(
        document.getElementById("remaining-tenure").value
    );

    if (
        !Number.isFinite(outstandingBalance) ||
        outstandingBalance <= 0 ||
        outstandingBalance > 1_000_000_000
    ) {
        throw new Error("Enter a valid outstanding balance.");
    }

    if (
        !Number.isFinite(annualInterestRate) ||
        annualInterestRate < 0 ||
        annualInterestRate > 100
    ) {
        throw new Error("Enter a current rate between 0 and 100%.");
    }

    if (!Number.isFinite(currentEmi) || currentEmi <= 0) {
        throw new Error("Enter a valid current EMI.");
    }

    if (
        !Number.isInteger(remainingTenureMonths) ||
        remainingTenureMonths < 1 ||
        remainingTenureMonths > MAX_TENURE_MONTHS
    ) {
        throw new Error("Remaining tenure must be 1 to 600 whole months.");
    }

    return {
        outstandingBalance,
        annualInterestRate,
        currentEmi,
        remainingTenureMonths
    };
}

function readPrepaymentSnapshot() {
    const outstandingBalance = Number(
        document.getElementById("prepayment-outstanding-balance").value
    );
    const annualInterestRateInput =
        document.getElementById("prepayment-interest-rate").value.trim();
    const annualInterestRate = annualInterestRateInput === ""
        ? Number.NaN
        : Number(annualInterestRateInput);
    const currentEmi = Number(
        document.getElementById("prepayment-emi").value
    );
    const remainingTenureMonths = Number(
        document.getElementById("prepayment-tenure").value
    );

    if (
        !Number.isFinite(outstandingBalance) ||
        outstandingBalance <= 0 ||
        outstandingBalance > 1_000_000_000
    ) {
        throw new Error("Enter a valid prepayment outstanding balance.");
    }
    if (
        !Number.isFinite(annualInterestRate) ||
        annualInterestRate < 0 ||
        annualInterestRate > 100
    ) {
        throw new Error("Enter a prepayment rate between 0 and 100%.");
    }
    if (!Number.isFinite(currentEmi) || currentEmi <= 0) {
        throw new Error("Enter a valid prepayment monthly EMI.");
    }
    if (
        !Number.isInteger(remainingTenureMonths) ||
        remainingTenureMonths < 1 ||
        remainingTenureMonths > MAX_TENURE_MONTHS
    ) {
        throw new Error("Prepayment remaining tenure must be 1 to 600 whole months.");
    }

    return {
        outstandingBalance,
        annualInterestRate,
        currentEmi,
        remainingTenureMonths
    };
}

function updatePrepaymentInputs(prepaymentEvents) {
    const remaining = Number(
        document.getElementById("prepayment-tenure").value
    );

    for (const input of prepaymentEvents.querySelectorAll(
        ".prepayment-installment"
    )) {
        input.max = Number.isInteger(remaining) && remaining > 0
            ? String(Math.min(MAX_TENURE_MONTHS, remaining))
            : String(MAX_TENURE_MONTHS);
    }

    const removeButtons = prepaymentEvents.querySelectorAll(
        ".remove-prepayment-button"
    );
    for (const button of removeButtons) {
        button.disabled = removeButtons.length === 1;
    }
}

function createPrepaymentEvent(prepaymentEvents, installmentNumber, amount) {
    const row = document.createElement("div");
    row.className = "prepayment-event";

    const installmentField = document.createElement("div");
    installmentField.className = "field";
    const installmentLabel = document.createElement("label");
    installmentLabel.textContent = "Installment number";
    const installmentInput = document.createElement("input");
    installmentInput.className = "prepayment-installment";
    installmentInput.type = "number";
    installmentInput.min = "1";
    installmentInput.max = String(MAX_TENURE_MONTHS);
    installmentInput.step = "1";
    installmentInput.value = String(installmentNumber);
    installmentInput.required = true;
    installmentLabel.append(installmentInput);
    installmentField.append(installmentLabel);

    const amountField = document.createElement("div");
    amountField.className = "field";
    const amountLabel = document.createElement("label");
    amountLabel.textContent = "Extra payment (₹)";
    const amountInput = document.createElement("input");
    amountInput.className = "prepayment-amount";
    amountInput.type = "number";
    amountInput.min = "0.01";
    amountInput.step = "0.01";
    amountInput.value = String(amount);
    amountInput.required = true;
    amountLabel.append(amountInput);
    amountField.append(amountLabel);

    const removeButton = document.createElement("button");
    removeButton.className = "remove-prepayment-button secondary-button";
    removeButton.type = "button";
    removeButton.textContent = "Remove";
    removeButton.setAttribute("aria-label", "Remove prepayment");

    row.append(installmentField, amountField, removeButton);
    prepaymentEvents.append(row);
    updatePrepaymentInputs(prepaymentEvents);
}

function readPrepaymentEvents(prepaymentEvents, remainingTenureMonths) {
    const rows = Array.from(
        prepaymentEvents.querySelectorAll(".prepayment-event")
    );
    if (rows.length === 0) {
        throw new Error("Add at least one prepayment to compare scenarios.");
    }

    return rows.map(row => {
        const installmentNumber = Number(
            row.querySelector(".prepayment-installment").value
        );
        const amount = Number(row.querySelector(".prepayment-amount").value);

        if (
            !Number.isInteger(installmentNumber) ||
            installmentNumber < 1 ||
            installmentNumber > remainingTenureMonths
        ) {
            throw new Error(
                "Each prepayment must target an installment within the remaining term."
            );
        }
        if (!Number.isFinite(amount) || amount <= 0) {
            throw new Error("Each prepayment amount must be positive.");
        }

        return { installmentNumber, amount };
    });
}

function optionalMetric(label, value, formatter) {
    return [label, value === null ? "Unavailable" : formatter(value)];
}

function renderRateRevision(loanCalculator, rateResults) {
    const simulationError = document.getElementById("simulation-error");
    simulationError.textContent = "";
    rateResults.replaceChildren();
    rateResults.hidden = true;

    try {
        const snapshot = readSnapshot();
        const revisedRateInput =
            document.getElementById("revised-interest-rate").value.trim();
        const revisedRate = revisedRateInput === ""
            ? Number.NaN
            : Number(revisedRateInput);
        if (
            !Number.isFinite(revisedRate) ||
            revisedRate < 0 ||
            revisedRate > 100
        ) {
            throw new Error("Enter a revised rate between 0 and 100%.");
        }

        const simulation = loanCalculator.simulateRateRevision(
            snapshot.outstandingBalance,
            snapshot.annualInterestRate,
            snapshot.currentEmi,
            snapshot.remainingTenureMonths,
            revisedRate
        );
        const baselineAdditionalMetrics = [
            [
                "Contractual remaining tenure",
                `${snapshot.remainingTenureMonths} months`
            ],
            [
                "Outstanding principal",
                formatINR(snapshot.outstandingBalance)
            ],
            [
                "Current annual interest rate",
                `${snapshot.annualInterestRate}%`
            ]
        ];
        const hasConsistencyWarning =
            simulation.baseline.status === "completed" &&
            Math.abs(
                simulation.baseline.installments -
                snapshot.remainingTenureMonths
            ) > 1;
        rateResults.append(
            createProjectionCard(
                "Current loan baseline",
                simulation.baseline,
                baselineAdditionalMetrics,
                {
                    emi: "Monthly EMI",
                    installments: "Projected payoff tenure"
                },
                hasConsistencyWarning
                    ? `Your current EMI is projected to repay the outstanding balance in ${simulation.baseline.installments} months, compared with the stated remaining tenure of ${snapshot.remainingTenureMonths} months.`
                    : ""
            ),
            createProjectionCard(
                "Revised rate, keep EMI",
                simulation.keepEmi,
                [
                    optionalMetric(
                        "Change in tenure vs baseline",
                        simulation.keepEmiTermChangeMonths,
                        value => formatSignedMonths(value, "months")
                    ),
                    optionalMetric(
                        "Change in future interest vs baseline",
                        simulation.keepEmiInterestChange,
                        formatSignedCurrency
                    ),
                    ["Revised annual interest rate", `${revisedRate}%`]
                ],
                {
                    emi: "Monthly EMI",
                    installments: "Projected payoff tenure"
                }
            ),
            createProjectionCard(
                "Revised rate, keep tenure",
                simulation.keepTenure,
                [
                    optionalMetric(
                        "EMI change",
                        simulation.keepTenureEmiChange,
                        formatSignedCurrency
                    ),
                    optionalMetric(
                        "Change in future interest vs baseline",
                        simulation.keepTenureInterestChange,
                        formatSignedCurrency
                    ),
                    ["Revised annual interest rate", `${revisedRate}%`]
                ],
                {
                    emi: "Monthly EMI",
                    installments: "Projected payoff tenure"
                }
            )
        );
        rateResults.hidden = false;
    } catch (error) {
        showScenarioError(error);
    }
}

function renderPrepayments(loanCalculator, prepaymentEvents, results) {
    const prepaymentError = document.getElementById("prepayment-error");
    prepaymentError.textContent = "";
    results.replaceChildren();
    results.hidden = true;

    try {
        const snapshot = readPrepaymentSnapshot();
        const events = readPrepaymentEvents(
            prepaymentEvents,
            snapshot.remainingTenureMonths
        );
        const simulation = loanCalculator.simulatePrepayments(
            snapshot.outstandingBalance,
            snapshot.annualInterestRate,
            snapshot.currentEmi,
            snapshot.remainingTenureMonths,
            events
        );
        results.append(
            createProjectionCard("Current loan baseline", simulation.baseline),
            createProjectionCard(
                "Prepayments, reduce tenure",
                simulation.reduceTenure,
                [
                    optionalMetric(
                        "Installments saved",
                        simulation.reduceTenureInstallmentsSaved,
                        value => formatSignedMonths(value, "months")
                    ),
                    optionalMetric(
                        "Interest saved",
                        simulation.reduceTenureInterestSaved,
                        formatSignedCurrency
                    )
                ]
            ),
            createProjectionCard(
                "Prepayments, reduce EMI",
                simulation.reduceEmi,
                [
                    optionalMetric(
                        "Installments saved",
                        simulation.reduceEmiInstallmentsSaved,
                        value => formatSignedMonths(value, "months")
                    ),
                    optionalMetric(
                        "Interest saved",
                        simulation.reduceEmiInterestSaved,
                        formatSignedCurrency
                    )
                ]
            )
        );
        results.hidden = false;
    } catch (error) {
        prepaymentError.textContent =
            error.message || "Unable to run the prepayment scenario.";
    }
}

export function initializeScenarioPlanner() {
    const prepaymentEvents = document.getElementById("prepayment-events");
    const rateResults = document.getElementById("rate-results");
    const prepaymentResults = document.getElementById("prepayment-results");
    const addPrepaymentButton = document.getElementById(
        "add-prepayment-button"
    );
    const simulateRateButton = document.getElementById(
        "simulate-rate-button"
    );
    const simulatePrepaymentButton = document.getElementById(
        "simulate-prepayment-button"
    );
    let loanCalculator = null;
    let rateComparisonRequested = false;

    document.getElementById("prepayment-tenure").addEventListener(
        "input",
        () => updatePrepaymentInputs(prepaymentEvents)
    );
    addPrepaymentButton.addEventListener("click", () => {
        const lastInstallment = Number(
            prepaymentEvents.querySelector(
                ".prepayment-event:last-child .prepayment-installment"
            )?.value
        ) || 0;
        const remaining = Number(
            document.getElementById("prepayment-tenure").value
        );
        const nextInstallment =
            Number.isInteger(remaining) && remaining > 0
                ? Math.min(remaining, lastInstallment + 12 || 1)
                : 1;
        createPrepaymentEvent(prepaymentEvents, nextInstallment, 100000);
    });
    prepaymentEvents.addEventListener("click", event => {
        if (event.target.matches(".remove-prepayment-button")) {
            event.target.closest(".prepayment-event").remove();
            updatePrepaymentInputs(prepaymentEvents);
        }
    });
    simulateRateButton.addEventListener("click", () => {
        rateComparisonRequested = true;
        renderRateRevision(loanCalculator, rateResults);
    });
    for (const inputId of [
        "outstanding-balance",
        "current-interest-rate",
        "current-emi",
        "remaining-tenure",
        "revised-interest-rate"
    ]) {
        document.getElementById(inputId).addEventListener("input", () => {
            if (rateComparisonRequested) {
                renderRateRevision(loanCalculator, rateResults);
            }
        });
    }
    simulatePrepaymentButton.addEventListener("click", () => {
        renderPrepayments(
            loanCalculator,
            prepaymentEvents,
            prepaymentResults
        );
    });
    updatePrepaymentInputs(prepaymentEvents);

    return calculator => {
        loanCalculator = calculator;
        simulateRateButton.disabled = false;
        simulatePrepaymentButton.disabled = false;
    };
}
