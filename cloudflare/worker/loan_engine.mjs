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
