const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");

const webRoot = process.env.LOAN_CALCULATOR_WEB_ROOT
    ? path.resolve(process.env.LOAN_CALCULATOR_WEB_ROOT)
    : path.resolve(__dirname, "../../build-wasm/web");

const mimeTypes = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".wasm": "application/wasm"
};

async function main() {
    assert.ok(fs.existsSync(path.join(webRoot, "index.html")));
    assert.ok(fs.existsSync(path.join(webRoot, "loan_calculator.js")));
    assert.ok(fs.existsSync(path.join(webRoot, "loan_calculator.wasm")));

    const server = http.createServer((request, response) => {
        const pathname = decodeURIComponent(
            new URL(request.url, "http://localhost").pathname
        );

        const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
        const filePath = path.resolve(webRoot, relativePath);

        if (!filePath.startsWith(webRoot + path.sep) &&
            filePath !== path.join(webRoot, "index.html")) {
            response.writeHead(400).end();
            return;
        }

        fs.readFile(filePath, (error, data) => {
            if (error) {
                response.writeHead(404).end();
                return;
            }

            response.writeHead(200, {
                "Content-Type": mimeTypes[path.extname(filePath)] ||
                    "application/octet-stream"
            });

            response.end(data);
        });
    });

    await new Promise(resolve => server.listen(4173, "127.0.0.1", resolve));

    let browser;

    try {
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        const errors = [];

        page.on("pageerror", error => errors.push(error.message));

        await page.goto("http://127.0.0.1:4173/");

        const button = page.locator("#calculate-button");

        await page.waitForFunction(() => {
            const button = document.querySelector("#calculate-button");
            const rateButton = document.querySelector("#simulate-rate-button");
            const prepaymentButton = document.querySelector(
                "#simulate-prepayment-button"
            );
            return button && !button.disabled &&
                rateButton && !rateButton.disabled &&
                prepaymentButton && !prepaymentButton.disabled;
        }, null, { timeout: 15000 });

        await page.locator("#outstanding-balance").fill("1000000");
        await page.locator("#current-interest-rate").fill("10");
        await page.locator("#current-emi").fill("21247.044711268275");
        await page.locator("#remaining-tenure").fill("60");
        await page.locator("#revised-interest-rate").fill("12");
        await page.locator("#simulate-rate-button").click();
        await page.locator("#rate-results .scenario-card").first().waitFor({
            state: "visible"
        });
        assert.equal(await page.locator("#rate-results .scenario-card").count(), 3);
        const baselineResults = await page.locator(
            "#rate-results .scenario-card"
        ).first().innerText();
        const keepEmiResults = await page.locator(
            "#rate-results .scenario-card"
        ).nth(1).innerText();
        const keepTenureResults = await page.locator(
            "#rate-results .scenario-card"
        ).nth(2).innerText();
        assert.match(keepEmiResults, /64/);
        assert.match(keepTenureResults, /₹22,244\.45/);
        assert.match(baselineResults, /Outstanding principal\s+₹10,00,000\.00/);
        assert.match(baselineResults, /Current annual interest rate\s+10%/);
        assert.match(baselineResults, /Contractual remaining tenure\s+60 months/);
        assert.match(baselineResults, /Projected Future Interest/);
        assert.match(baselineResults, /Projected Future Repayment/);
        assert.doesNotMatch(
            await page.locator("#rate-results").innerText(),
            /Total interest|Total repayment/
        );
        assert.match(keepEmiResults, /Projected payoff tenure\s+64 months/);
        assert.match(
            keepEmiResults,
            /Change in tenure vs baseline\s+\+4 months/
        );
        assert.match(
            await page.locator("#rate-results").innerText(),
            /Revised rate, keep tenure/
        );

        await page.locator("#revised-interest-rate").fill("11");
        assert.match(
            await page.locator("#rate-results .scenario-card").nth(1).innerText(),
            /Revised annual interest rate\s+11%/
        );
        await page.locator("#outstanding-balance").fill("2000000");
        assert.match(
            await page.locator("#rate-results .scenario-card").first().innerText(),
            /Outstanding principal\s+₹20,00,000\.00/
        );
        await page.locator("#outstanding-balance").fill("1000000");
        await page.locator("#revised-interest-rate").fill("12");

        await page.locator("#outstanding-balance").fill("3500000");
        await page.locator("#current-interest-rate").fill("8.5");
        await page.locator("#current-emi").fill("45000");
        await page.locator("#remaining-tenure").fill("240");
        await page.locator("#revised-interest-rate").fill("8.5");
        await page.locator("#simulate-rate-button").click();
        const screenshotBaseline = await page.locator(
            "#rate-results .scenario-card"
        ).first().innerText();
        assert.match(screenshotBaseline, /Projected payoff tenure\s+114 months/);
        assert.match(screenshotBaseline, /Contractual remaining tenure\s+240 months/);
        assert.match(screenshotBaseline, /Calculated payoff is 114 months/);

        await page.locator("#outstanding-balance").fill("1000000");
        await page.locator("#current-interest-rate").fill("10");
        await page.locator("#current-emi").fill("21247.044711268275");
        await page.locator("#remaining-tenure").fill("60");
        await page.locator("#revised-interest-rate").fill("12");

        await page.locator("#prepayment-outstanding-balance").fill("1000000");
        await page.locator("#prepayment-interest-rate").fill("10");
        await page.locator("#prepayment-emi").fill("21247.044711268275");
        await page.locator("#prepayment-tenure").fill("60");
        await page.locator("#add-prepayment-button").click();
        const prepaymentRows = page.locator(
            "#prepayment-events .prepayment-event"
        );
        assert.equal(await prepaymentRows.count(), 2);
        await prepaymentRows.nth(1).locator(".prepayment-installment").fill("24");
        await prepaymentRows.nth(1).locator(".prepayment-amount").fill("50000");
        await page.locator("#simulate-prepayment-button").click();
        await page.locator("#prepayment-results .scenario-card").first().waitFor({
            state: "visible"
        });
        assert.equal(
            await page.locator("#prepayment-results .scenario-card").count(),
            3
        );
        assert.match(
            await page.locator("#prepayment-results").innerText(),
            /Prepayments applied/
        );
        const reduceTenureResults = await page.locator(
            "#prepayment-results .scenario-card"
        ).nth(1).innerText();
        const reduceEmiResults = await page.locator(
            "#prepayment-results .scenario-card"
        ).nth(2).innerText();
        assert.match(
            reduceTenureResults,
            /Number of installments required\s+51/
        );
        assert.match(reduceTenureResults, /₹2,16,317\.95/);
        assert.match(reduceEmiResults, /₹2,45,001\.35/);
        await prepaymentRows.nth(1).locator(".remove-prepayment-button").click();
        assert.equal(await prepaymentRows.count(), 1);

        await page.locator("#prepayment-tenure").fill("11");
        await page.locator("#simulate-prepayment-button").click();
        assert.match(
            await page.locator("#prepayment-error").innerText(),
            /within the remaining term/
        );
        await page.locator("#prepayment-tenure").fill("240");

        await page.locator("#current-interest-rate").fill("");
        await page.locator("#simulate-rate-button").click();
        assert.match(
            await page.locator("#simulation-error").innerText(),
            /current rate between 0 and 100/
        );
        await page.locator("#current-interest-rate").fill("10");

        await page.locator("#revised-interest-rate").fill("");
        await page.locator("#simulate-rate-button").click();
        assert.match(
            await page.locator("#simulation-error").innerText(),
            /revised rate between 0 and 100/
        );
        await page.locator("#revised-interest-rate").fill("101");
        await page.locator("#simulate-rate-button").click();
        assert.match(
            await page.locator("#simulation-error").innerText(),
            /revised rate between 0 and 100/
        );
        await page.locator("#revised-interest-rate").fill("9.5");

        await button.click();
        await page.locator("#results").waitFor({ state: "visible" });

        const emi = await page.locator("#monthly-emi").innerText();

        assert.match(emi, /43,391/, `Unexpected EMI: ${emi}`);

        await page.locator("#interest-rate").fill("0");
        await button.click();

        const zeroRateEmi = await page.locator("#monthly-emi").innerText();

        assert.match(zeroRateEmi, /20,833/);

        const existingBaselineBeforeNewLoan =
            await page.locator("#rate-results .scenario-card").first().innerText();
        await page.locator("#principal").fill("6000000");
        await button.click();
        const independentEmi = await page.locator("#monthly-emi").innerText();
        assert.notEqual(independentEmi, zeroRateEmi);
        assert.equal(
            await page.locator("#rate-results .scenario-card").first().innerText(),
            existingBaselineBeforeNewLoan
        );

        await page.locator("#interest-rate").fill("101");
        await button.click();

        const error = await page.locator("#error-message").innerText();

        assert.match(error, /between 0 and 100/);

        await page.setViewportSize({ width: 390, height: 844 });
        const mobileLayout = await page.evaluate(() => ({
            documentFits: document.documentElement.scrollWidth <= window.innerWidth,
            numericalWhiteSpace: Array.from(
                document.querySelectorAll(".scenario-metric strong")
            ).every(element => getComputedStyle(element).whiteSpace === "nowrap")
        }));
        assert.equal(mobileLayout.documentFits, true);
        assert.equal(mobileLayout.numericalWhiteSpace, true);
        assert.deepEqual(errors, []);

        console.log("PASS: Default EMI calculation");
        console.log("PASS: Zero-interest calculation");
        console.log("PASS: Invalid interest-rate validation");
        console.log("PASS: Rate-revision scenarios");
        console.log("PASS: Prepayment scenarios and dynamic event rows");
        console.log("PASS: Scenario input validation");
        console.log("PASS: No uncaught browser errors");
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
