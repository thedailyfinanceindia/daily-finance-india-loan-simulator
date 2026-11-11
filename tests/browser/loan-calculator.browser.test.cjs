const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");

const webRoot = path.resolve(__dirname, "../../build-wasm/web");

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
            return button && !button.disabled;
        }, null, { timeout: 15000 });

        await button.click();
        await page.locator("#results").waitFor({ state: "visible" });

        const emi = await page.locator("#monthly-emi").innerText();

        assert.match(emi, /43,391/, `Unexpected EMI: ${emi}`);

        await page.locator("#interest-rate").fill("0");
        await button.click();

        const zeroRateEmi = await page.locator("#monthly-emi").innerText();

        assert.match(zeroRateEmi, /20,833/);

        await page.locator("#interest-rate").fill("101");
        await button.click();

        const error = await page.locator("#error-message").innerText();

        assert.match(error, /between 0 and 100/);
        assert.deepEqual(errors, []);

        console.log("PASS: Default EMI calculation");
        console.log("PASS: Zero-interest calculation");
        console.log("PASS: Invalid interest-rate validation");
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
