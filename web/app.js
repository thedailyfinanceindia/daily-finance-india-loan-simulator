
const form = document.getElementById("loan-form");
const calculateButton = document.getElementById("calculate-button");
const errorMessage = document.getElementById("error-message");
const results = document.getElementById("results");

const formatINR = (value) =>
    new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 0
    }).format(value);

let loanCalculator = null;

async function initializeCalculator() {
    try {
        if (typeof createLoanCalculator !== "function") {
            throw new Error("WebAssembly loader was not found.");
        }

        loanCalculator = await createLoanCalculator();
        calculateButton.disabled = false;
    } catch (error) {
        console.error("WebAssembly initialization failed:", error);
        errorMessage.textContent =
            "The calculator could not be loaded. Please refresh the page.";
        calculateButton.disabled = true;
    }
}

calculateButton.disabled = true;
initializeCalculator();

form.addEventListener("submit", (event) => {
    event.preventDefault();

    errorMessage.textContent = "";
    results.hidden = true;

    if (!loanCalculator) {
        errorMessage.textContent = "Calculator is still loading. Please wait.";
        return;
    }

    const principal = Number(document.getElementById("principal").value);
    const annualRate = Number(document.getElementById("interest-rate").value);
    const tenureYears = Number(document.getElementById("tenure").value);

    if (!Number.isFinite(principal) || principal <= 0 || principal > 1_000_000_000) {
        errorMessage.textContent = "Enter a valid loan amount.";
        return;
    }

    if (!Number.isFinite(annualRate) || annualRate < 0 || annualRate > 100) {
        errorMessage.textContent = "Enter an interest rate between 0 and 100%.";
        return;
    }

    if (!Number.isInteger(tenureYears) || tenureYears < 1 || tenureYears > 50) {
        errorMessage.textContent = "Enter a whole number of years between 1 and 50.";
        return;
    }

    const tenureMonths = tenureYears * 12;

    try {
        // Financial calculation is performed by the C++ WebAssembly engine.
        const result = loanCalculator.calculateLoan(
            principal,
            annualRate,
            tenureMonths
        );

        document.getElementById("monthly-emi").textContent =
            formatINR(result.monthlyEmi);

        document.getElementById("principal-result").textContent =
            formatINR(principal);

        document.getElementById("interest-result").textContent =
            formatINR(result.totalInterest);

        document.getElementById("repayment-result").textContent =
            formatINR(result.totalRepayment);

        results.hidden = false;
    } catch (error) {
        console.error("Loan calculation failed:", error);
        errorMessage.textContent =
            error.message || "Unable to calculate the loan. Check your inputs.";
    }
});
