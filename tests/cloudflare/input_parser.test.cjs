const assert = require("node:assert/strict");

async function main() {
    const {
        parsePrincipal,
        parseRate,
        parseTenure
    } = await import("../../cloudflare/worker/input_parser.mjs");

    // Principal tests
    const principalTests = [
        ["5", 5],
        ["500000", 500000],
        ["50000", 50000],
        ["5 lakh", 500000],
        ["5L", 500000],
        ["5 lac", 500000],
        ["5 lakhs", 500000],
        ["5k", 5000],
        ["50 thousand", 50000],
        ["1.5 crore", 15000000],
        ["5 cr", 50000000],
        ["₹500000", 500000]
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
        "0",
        "-500",
        "5 lakh extra",
        "1000 crore"
    ];

    for (const input of invalidPrincipalTests) {
        assert.equal(
            parsePrincipal(input),
            null,
            `Expected invalid principal: ${input}`
        );
    }

    // Interest-rate tests
    assert.equal(parseRate("9.5"), 9.5);
    assert.equal(parseRate("9.5%"), 9.5);
    assert.equal(parseRate("0"), 0);
    assert.equal(parseRate("100"), 100);

    for (const input of ["-1", "101", "abc", "", "9.5abc"]) {
        assert.equal(parseRate(input), null);
    }

    // Tenure tests
    assert.equal(parseTenure("5 years"), 60);
    assert.equal(parseTenure("5 yrs"), 60);
    assert.equal(parseTenure("60 months"), 60);
    assert.equal(parseTenure("5"), 5);
    assert.equal(parseTenure("12 mos"), 12);
    assert.equal(parseTenure("50 years"), 600);

    for (const input of ["0", "601", "51 years", "abc", "-5"]) {
        assert.equal(parseTenure(input), null);
    }

    console.log("All Cloudflare input parser tests passed.");
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
