
const fs = require("node:fs");
const assert = require("node:assert/strict");

async function main() {
    const wasmPath = "build-wasm/worker/loan_worker.wasm";
    const bytes = fs.readFileSync(wasmPath);

    const module = await WebAssembly.compile(bytes);
    const imports = WebAssembly.Module.imports(module);

    if (imports.length !== 0) {
        throw new Error(
            `Worker Wasm has unexpected imports: ${JSON.stringify(imports)}`
        );
    }

    const instance = await WebAssembly.instantiate(module, {});
    const exports = instance.exports;

    assert.equal(typeof exports.dfi_calculate_loan, "function");
    assert.equal(typeof exports.dfi_get_result_ptr, "function");
    assert.equal(typeof exports.dfi_simulate_rate_revision, "function");
    assert.equal(typeof exports.dfi_get_rate_result_ptr, "function");
    assert.equal(typeof exports.dfi_simulate_prepayments, "function");
    assert.equal(typeof exports.dfi_get_prepayment_result_ptr, "function");
    assert.equal(typeof exports.dfi_set_prepayment_event, "function");
    assert.ok(exports.memory instanceof WebAssembly.Memory);

    function calculate(principal, rate, months) {
        const status = exports.dfi_calculate_loan(
            principal,
            rate,
            months
        );

        assert.equal(status, 0, `Calculation failed with status ${status}`);

        const pointer = exports.dfi_get_result_ptr();

        return Array.from(
            new Float64Array(exports.memory.buffer, pointer, 3)
        );
    }

    // Normal loan: ₹5,00,000, 9.5%, 60 months.
    const normal = calculate(500000, 9.5, 60);

    assert.ok(normal[0] > 0);
    assert.ok(normal[1] > 0);
    assert.ok(normal[2] > 500000);

    // Zero-interest loan: ₹60,000, 0%, 60 months.
    const zeroInterest = calculate(60000, 0, 60);

    assert.equal(zeroInterest[0], 1000);
    assert.equal(zeroInterest[1], 0);
    assert.equal(zeroInterest[2], 60000);

    // Invalid principal.
    assert.equal(
        exports.dfi_calculate_loan(0, 9.5, 60),
        1
    );

    // Invalid tenure.
    assert.equal(
        exports.dfi_calculate_loan(500000, 9.5, 0),
        1
    );

    const rateStatus = exports.dfi_simulate_rate_revision(
        1000000, 10, 21247.044711268275, 60, 12
    );
    assert.equal(rateStatus, 0);
    const rateValues = Array.from(
        new Float64Array(
            exports.memory.buffer,
            exports.dfi_get_rate_result_ptr(),
            19
        )
    );
    assert.equal(rateValues[1], 60);
    assert.equal(rateValues[6], 64);
    assert.equal(rateValues[11], 60);
    assert.equal(rateValues[15], 4);

    exports.dfi_set_prepayment_event(0, 12, 100000);
    exports.dfi_set_prepayment_event(1, 24, 50000);
    const prepaymentStatus = exports.dfi_simulate_prepayments(
        1000000, 10, 21247.044711268275, 60, 2
    );
    assert.equal(prepaymentStatus, 0);
    const prepaymentValues = Array.from(
        new Float64Array(
            exports.memory.buffer,
            exports.dfi_get_prepayment_result_ptr(),
            19
        )
    );
    assert.equal(prepaymentValues[6], 51);
    assert.equal(prepaymentValues[11], 60);

    console.log("Worker Wasm tests passed.");
    console.log("Normal loan:", normal);
    console.log("Zero-interest loan:", zeroInterest);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
