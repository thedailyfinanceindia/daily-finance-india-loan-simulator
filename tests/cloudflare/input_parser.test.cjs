const assert = require("node:assert/strict");

async function main() {
    const {
        parsePrincipal,
        parseRate,
        parseTenure
    } = await import("../../cloudflare/worker/input_parser.mjs");

    // --------------------------------------------
    // Principal tests
    // --------------------------------------------

    const principalTests = [
        ["5", 5],
        ["500000", 500000],
        ["50000", 50000],
        ["5000000", 5000000],

        ["5 lakh", 500000],
        ["5 lakh", 500000],
        ["5L", 500000],
        ["5 lac", 500000],
        ["5 lacs", 500000],
        ["5 lakhs", 500000],

        ["5k", 5000],
        ["5 K", 5000],
        ["50 thousand", 50000],
        ["50thousand", 50000],

        ["1.5 crore", 15000000],
        ["5 cr", 50000000],
        ["5 crore", 50000000],
        ["5 crores", 50000000],

        ["₹500000", 500000],
        ["₹ 5 lakh", 500000],
        ["  5 lakh  ", 500000]
    ];

    for (const [input, expected] of principalTests) {
        assert.equal(
            parsePrincipal(input),
            expected,
            `Principal parser failed for: ${input}`
        );
    }

    const invalidPrincipalTests = [
        "500,000",
        "5,00,000",
        "abc",
        "",
        " ",
        "0",
        "-500",
        "+500",
        "5 lakh extra",
        "1000 crore",
        "1000000001",
        "₹",
        "5. lakh",
        ".5 lakh",
        "5.5.5 lakh",
        "5 rupees",
        "5 lakhs only"
    ];

    for (const input of invalidPrincipalTests) {
        assert.equal(
            parsePrincipal(input),
            null,
            `Expected invalid principal: ${input}`
        );
    }

    assert.equal(parsePrincipal(null), null);
    assert.equal(parsePrincipal(undefined), null);
    assert.equal(parsePrincipal(500000), null);

    // --------------------------------------------
    // Interest-rate tests
    // --------------------------------------------

    const rateTests = [
        ["9.5", 9.5],
        ["9.5%", 9.5],
        ["0", 0],
        ["100", 100],
        [" 8.75 ", 8.75],
        ["10%", 10]
    ];

    for (const [input, expected] of rateTests) {
        assert.equal(
            parseRate(input),
            expected,
            `Rate parser failed for: ${input}`
        );
    }
const validRateTests = [
    ["9.5", 9.5],
    ["9.5%", 9.5],
    ["9.5 %", 9.5],
    ["0", 0],
    ["100%", 100]
];

for (const [input, expected] of validRateTests) {
    assert.equal(parseRate(input), expected);
}

const invalidRateTests = [
    "9.5%%",
    "%%9.5",
    "9%%",
    "9.5% %",
    "abc",
    "-9.5",
    "100.1%"
];

for (const input of invalidRateTests) {
    assert.equal(
        parseRate(input),
        null,
        `Expected invalid rate: ${input}`
    );
}
    const invalidRateTests = [
        "-1",
        "101",
        "abc",
        "",
        " ",
        "9.5abc",
        "9.5%%",
        "1,000",
        "+9.5",
        ".5",
        "9."
    ];

    for (const input of invalidRateTests) {
        assert.equal(
            parseRate(input),
            null,
            `Expected invalid rate: ${input}`
        );
    }

    assert.equal(parseRate(null), null);
    assert.equal(parseRate(undefined), null);
    assert.equal(parseRate(9.5), null);

    // --------------------------------------------
    // Tenure tests
    // --------------------------------------------

    const tenureTests = [
        ["5 years", 60],
        ["5 year", 60],
        ["5 yrs", 60],
        ["5 yr", 60],
        ["60 months", 60],
        ["60 month", 60],
        ["12 mos", 12],
        ["5", 5],
        ["50 years", 600],
        ["  24 months  ", 24]
    ];

    for (const [input, expected] of tenureTests) {
        assert.equal(
            parseTenure(input),
            expected,
            `Tenure parser failed for: ${input}`
        );
    }

    const invalidTenureTests = [
        "0",
        "601",
        "51 years",
        "abc",
        "-5",
        "5.5 years",
        "5 months extra",
        "5 days",
        "10years old"
    ];

    for (const input of invalidTenureTests) {
        assert.equal(
            parseTenure(input),
            null,
            `Expected invalid tenure: ${input}`
        );
    }

    assert.equal(parseTenure(null), null);
    assert.equal(parseTenure(undefined), null);
    assert.equal(parseTenure(5), null);

    console.log("All Cloudflare input parser tests passed.");
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
