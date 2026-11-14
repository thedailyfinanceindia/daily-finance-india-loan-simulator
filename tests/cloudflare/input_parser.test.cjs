
const assert = require("node:assert/strict");

async function main() {
    const {
        parsePrincipal,
        parseRate,
        parseTenure
    } = await import("../../cloudflare/worker/input_parser.mjs");

    // --------------------------------------------------
    // Principal tests
    // --------------------------------------------------

    const validPrincipalTests = [
        ["5", 5],
        ["500000", 500000],
        ["50000", 50000],
        ["5 lakh", 500000],
        ["5L", 500000],
        ["5 lac", 500000],
        ["5 lacs", 500000],
        ["5 lakhs", 500000],
        ["5k", 5000],
        ["50 thousand", 50000],
        ["1.5 crore", 15000000],
        ["5 cr", 50000000],
        ["₹500000", 500000],
        ["₹ 5 lakh", 500000],
        ["0.5 lakh", 50000],
        ["2 crore", 20000000]
    ];

    for (const [input, expected] of validPrincipalTests) {
        assert.equal(
            parsePrincipal(input),
            expected,
            `Expected principal ${input} to equal ${expected}`
        );
    }

    const invalidPrincipalTests = [
        "",
        "abc",
        "five lakh",
        "5,00,000",
        "5,000",
        "-500000",
        "0",
        "5 million",
        "5 lakhs extra",
        "₹",
        "5%",
        "1.5.5 lakh",
        "1000000001"
    ];

    for (const input of invalidPrincipalTests) {
        assert.equal(
            parsePrincipal(input),
            null,
            `Expected invalid principal: ${input}`
        );
    }

    // --------------------------------------------------
    // Interest rate tests
    // --------------------------------------------------

    const validRateTests = [
        ["9.5", 9.5],
        ["9.5%", 9.5],
        ["9.5 %", 9.5],
        ["8", 8],
        ["0", 0],
        ["0%", 0],
        ["100", 100],
        ["100%", 100],
        ["7.25", 7.25],
        [" 9.5 ", 9.5]
    ];

    for (const [input, expected] of validRateTests) {
        assert.equal(
            parseRate(input),
            expected,
            `Expected rate ${input} to equal ${expected}`
        );
    }

    // Keep only ONE invalidRateTests declaration.
    const invalidRateTests = [
        "",
        "abc",
        "-9.5",
        "-1%",
        "100.1",
        "100.1%",
        "101",
        "9.5%%",
        "%%9.5",
        "9%%",
        "9.5% %",
        "9.5 percent",
        "9..5",
        "1,5",
        "NaN",
        "Infinity"
    ];

    for (const input of invalidRateTests) {
        assert.equal(
            parseRate(input),
            null,
            `Expected invalid rate: ${input}`
        );
    }

    // --------------------------------------------------
    // Tenure tests
    // --------------------------------------------------

    const validTenureTests = [
        ["5", 5],
        ["1", 1],
        ["60", 60],
        ["5 months", 5],
        ["5 month", 5],
        ["60 months", 60],
        ["12 mos", 12],
        ["12 mo", 12],
        ["5 years", 60],
        ["5 year", 60],
        ["5 yrs", 60],
        ["5 yr", 60],
        ["1 year", 12],
        ["10 years", 120],
        ["50 years", 600]
    ];

    for (const [input, expected] of validTenureTests) {
        assert.equal(
            parseTenure(input),
            expected,
            `Expected tenure ${input} to equal ${expected} months`
        );
    }

    const invalidTenureTests = [
        "",
        "abc",
        "0",
        "0 months",
        "-5",
        "-5 years",
        "601",
        "51 years",
        "5.5",
        "5.5 years",
        "5 decades",
        "5 months extra",
        "five years",
        "12.5 months",
        "1,200"
    ];

    for (const input of invalidTenureTests) {
        assert.equal(
            parseTenure(input),
            null,
            `Expected invalid tenure: ${input}`
        );
    }

    console.log("All input parser tests passed.");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
