import loanWasmModule from "./loan_worker.wasm";

const loanWasmInstance = await WebAssembly.instantiate(loanWasmModule, {});

const loanEngine = loanWasmInstance instanceof WebAssembly.Instance
    ? loanWasmInstance.exports
    : loanWasmInstance.instance.exports;

export function calculateLoan(principal, rate, months) {
    const status = loanEngine.dfi_calculate_loan(principal, rate, months);

    if (status !== 0) {
        throw new Error(`C++ loan calculation failed: ${status}`);
    }

    const pointer = loanEngine.dfi_get_result_ptr();
    const values = new Float64Array(loanEngine.memory.buffer, pointer, 3);
    const [monthlyEmi, totalInterest, totalRepayment] = Array.from(values);

    if (
        !Number.isFinite(monthlyEmi) ||
        !Number.isFinite(totalInterest) ||
        !Number.isFinite(totalRepayment)
    ) {
        throw new Error("C++ engine returned invalid results.");
    }

    return { monthlyEmi, totalInterest, totalRepayment };
}

function readProjection(values, offset) {
    return {
        statusCode: values[offset],
        installments: values[offset + 1],
        emi: values[offset + 2],
        totalInterest: values[offset + 3],
        totalRepayment: values[offset + 4]
    };
}

export function simulateRateRevision(
    outstandingBalance,
    currentRate,
    currentEmi,
    remainingTenureMonths,
    revisedRate
) {
    const status = loanEngine.dfi_simulate_rate_revision(
        outstandingBalance,
        currentRate,
        currentEmi,
        remainingTenureMonths,
        revisedRate
    );
    if (status !== 0) throw new Error(`C++ rate revision failed: ${status}`);

    const pointer = loanEngine.dfi_get_rate_result_ptr();
    const values = Array.from(
        new Float64Array(loanEngine.memory.buffer, pointer, 19)
    );
    const optional = value => Number.isFinite(value) ? value : null;

    return {
        baseline: readProjection(values, 0),
        keepEmi: readProjection(values, 5),
        keepTenure: readProjection(values, 10),
        keepEmiTermChangeMonths: optional(values[15]),
        keepEmiInterestChange: optional(values[16]),
        keepTenureEmiChange: optional(values[17]),
        keepTenureInterestChange: optional(values[18])
    };
}

export function simulatePrepayments(
    outstandingBalance,
    currentRate,
    currentEmi,
    remainingTenureMonths,
    events
) {
    const eventCount = events.length;
    for (let index = 0; index < eventCount; ++index) {
        loanEngine.dfi_set_prepayment_event(
            index,
            events[index].installmentNumber,
            events[index].amount
        );
    }

    const status = loanEngine.dfi_simulate_prepayments(
        outstandingBalance,
        currentRate,
        currentEmi,
        remainingTenureMonths,
        eventCount
    );
    if (status !== 0) {
        throw new Error(`C++ prepayment simulation failed: ${status}`);
    }

    const pointer = loanEngine.dfi_get_prepayment_result_ptr();
    const values = Array.from(
        new Float64Array(loanEngine.memory.buffer, pointer, 19)
    );
    const optional = value => Number.isFinite(value) ? value : null;

    return {
        baseline: readProjection(values, 0),
        reduceTenure: readProjection(values, 5),
        reduceEmi: readProjection(values, 10),
        reduceTenureInstallmentsSaved: optional(values[15]),
        reduceTenureInterestSaved: optional(values[16]),
        reduceEmiInstallmentsSaved: optional(values[17]),
        reduceEmiInterestSaved: optional(values[18])
    };
}
