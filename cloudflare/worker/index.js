import loanWasmModule from "./loan_worker.wasm";

const loanWasmInstance =
    await WebAssembly.instantiate(loanWasmModule, {});

const loanEngine = loanWasmInstance.exports;

function calculateLoan(principal, rate, months) {
    const status = loanEngine.dfi_calculate_loan(
        principal,
        rate,
        months
    );

    if (status !== 0) {
        throw new Error(`Loan calculation failed: ${status}`);
    }

    const pointer = loanEngine.dfi_get_result_ptr();

    const [monthlyEmi, totalInterest, totalRepayment] =
        new Float64Array(loanEngine.memory.buffer, pointer, 3);

    return { monthlyEmi, totalInterest, totalRepayment };
}
