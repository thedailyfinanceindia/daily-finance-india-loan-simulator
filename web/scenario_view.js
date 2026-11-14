const projectionStatusText = {
    completed: "Paid off",
    non_amortizing: "This EMI does not reduce the balance",
    term_exhausted: "Balance remains at the end of the stated term",
    maximum_tenure_exceeded: "Not paid off within 600 installments"
};

export function formatINR(value) {
    return new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(value);
}

function addMetric(card, labelText, valueText) {
    const row = document.createElement("div");
    row.className = "scenario-metric";

    const label = document.createElement("span");
    label.textContent = labelText;
    const value = document.createElement("strong");
    value.textContent = valueText;

    row.append(label, value);
    card.append(row);
}

export function formatSignedCurrency(value) {
    const sign = value > 0 ? "+" : value < 0 ? "-" : "";
    return sign + formatINR(Math.abs(value));
}

export function formatSignedMonths(value, suffix) {
    const sign = value > 0 ? "+" : value < 0 ? "-" : "";
    return `${sign}${Math.abs(value)} ${suffix}`;
}

export function createProjectionCard(title, projection, additionalMetrics = []) {
    const card = document.createElement("article");
    card.className = "scenario-card";

    const heading = document.createElement("h4");
    heading.textContent = title;
    card.append(heading);

    const status = document.createElement("p");
    status.className = "scenario-status";
    status.textContent =
        projectionStatusText[projection.status] || "Simulation unavailable";
    card.append(status);

    if (projection.installments > 0) {
        addMetric(card, "Installments", String(projection.installments));
    }
    addMetric(card, "Starting EMI", formatINR(projection.initialEmi));
    if (Math.abs(projection.lastEmi - projection.initialEmi) >= 0.005) {
        addMetric(card, "EMI after latest change", formatINR(projection.lastEmi));
    }
    addMetric(card, "Total interest", formatINR(projection.totalInterest));
    addMetric(card, "Total repayment", formatINR(projection.totalRepayment));

    if (projection.totalPrepaymentsRequested > 0) {
        addMetric(
            card,
            "Prepayments requested",
            formatINR(projection.totalPrepaymentsRequested)
        );
        addMetric(
            card,
            "Prepayments applied",
            formatINR(projection.totalPrepaymentsApplied)
        );
    }
    if (projection.status !== "completed") {
        addMetric(card, "Balance remaining", formatINR(projection.endingBalance));
    }

    for (const [label, value] of additionalMetrics) {
        addMetric(card, label, value);
    }

    return card;
}

export function showScenarioError(error) {
    document.getElementById("simulation-error").textContent =
        error.message || "Unable to run the selected loan scenario.";
}
