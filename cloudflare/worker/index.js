
import loanWasmModule from "./loan_worker.wasm";

// --------------------------------------------------
// Configuration
// --------------------------------------------------

const GRAPH_API_VERSION = "v27.0";
const INSTAGRAM_ACCOUNT_ID = "17841427456411892";

const MAX_PRINCIPAL = 1_000_000_000; // ₹100 crore
const MAX_ANNUAL_RATE = 100;
const MAX_TENURE_MONTHS = 600;
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

// Prototype storage only.
// This Map is not durable or shared across Worker isolates.
// Replace it with Cloudflare D1 before production.
const conversations = new Map();
const processedMessageIds = new Map();

// --------------------------------------------------
// C++ WebAssembly engine
// --------------------------------------------------

const wasmResult = await WebAssembly.instantiate(loanWasmModule, {});
const loanEngine = wasmResult.instance.exports;

function calculateLoan(principal, rate, months) {
    const status = loanEngine.dfi_calculate_loan(
        principal,
        rate,
        months
    );

    if (status !== 0) {
        throw new Error(`C++ loan calculation failed: ${status}`);
    }

    const pointer = loanEngine.dfi_get_result_ptr();

    const values = new Float64Array(
        loanEngine.memory.buffer,
        pointer,
        3
    );

    const [monthlyEmi, totalInterest, totalRepayment] =
        Array.from(values);

    if (
        !Number.isFinite(monthlyEmi) ||
        !Number.isFinite(totalInterest) ||
        !Number.isFinite(totalRepayment)
    ) {
        throw new Error("C++ engine returned non-finite results.");
    }

    return {
        monthlyEmi,
        totalInterest,
        totalRepayment
    };
}

// --------------------------------------------------
// Formatting and input parsing
// --------------------------------------------------

function formatINR(value) {
    return new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 0
    }).format(value);
}

function parsePrincipal(text) {
    const normalized = text
        .toLowerCase()
        .replace(/[₹,\s]/g, "")
        .trim();

    const match = normalized.match(
        /^(\d+(?:\.\d+)?)(lakh|lac|lakhs|lacs|crore|cr)?$/
    );

    if (!match) return null;

    let amount = Number(match[1]);
    const unit = match[2];

    if (unit && ["lakh", "lac", "lakhs", "lacs"].includes(unit)) {
        amount *= 100000;
    } else if (unit && ["crore", "cr"].includes(unit)) {
        amount *= 10000000;
    }

    if (
        !Number.isFinite(amount) ||
        amount <= 0 ||
        amount > MAX_PRINCIPAL
    ) {
        return null;
    }

    return amount;
}

function parseRate(text) {
    const normalized = text
        .trim()
        .replace(/%/g, "")
        .trim();

    if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
        return null;
    }

    const rate = Number(normalized);

    if (
        !Number.isFinite(rate) ||
        rate < 0 ||
        rate > MAX_ANNUAL_RATE
    ) {
        return null;
    }

    return rate;
}

function parseTenure(text) {
    const normalized = text.toLowerCase().trim();

    const match = normalized.match(
        /^(\d+)\s*(months?|mos?|years?|yrs?)?$/
    );

    if (!match) return null;

    const value = Number(match[1]);
    const unit = match[2] || "months";

    let months = value;

    if (
        unit.startsWith("year") ||
        unit.startsWith("yr")
    ) {
        months = value * 12;
    }

    if (
        !Number.isInteger(months) ||
        months < 1 ||
        months > MAX_TENURE_MONTHS
    ) {
        return null;
    }

    return months;
}

// --------------------------------------------------
// Instagram Send API
// --------------------------------------------------

async function sendInstagramText(env, recipientId, text) {
    const url =
        `https://graph.facebook.com/${GRAPH_API_VERSION}/` +
        `${INSTAGRAM_ACCOUNT_ID}/messages`;

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${env.META_ACCESS_TOKEN}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            recipient: {
                id: recipientId
            },
            message: {
                text
            }
        })
    });

    if (!response.ok) {
        const errorBody = await response.text();

        console.error("Instagram Send API error:", {
            status: response.status,
            body: errorBody.slice(0, 1000)
        });

        throw new Error(
            `Instagram Send API failed: ${response.status}`
        );
    }
}

// --------------------------------------------------
// Conversation state machine
// --------------------------------------------------

const STATE = {
    PRINCIPAL: "WAITING_FOR_PRINCIPAL",
    RATE: "WAITING_FOR_RATE",
    TENURE: "WAITING_FOR_TENURE"
};

function getConversation(senderId) {
    const conversation = conversations.get(senderId);

    if (!conversation) return null;

    if (
        Date.now() - conversation.updatedAt >
        SESSION_TIMEOUT_MS
    ) {
        conversations.delete(senderId);
        return null;
    }

    return conversation;
}

function saveConversation(senderId, conversation) {
    conversation.updatedAt = Date.now();
    conversations.set(senderId, conversation);
}

function startConversation(senderId) {
    saveConversation(senderId, {
        state: STATE.PRINCIPAL,
        principal: null,
        rate: null,
        tenureMonths: null,
        updatedAt: Date.now()
    });

    return (
        "Welcome to Daily Finance India EMI Calculator!\\n\\n" +
        "Let's calculate your loan EMI.\\n\\n" +
        "Step 1 of 3: What is your loan amount?\\n" +
        "Example: 500000 or 5 lakh"
    );
}

function formatResult(result, principal, rate, months) {
    const years = months / 12;

    return (
        "Your loan calculation is ready!\\n\\n" +
        "Loan Amount: " + formatINR(principal) + "\\n" +
        "Interest Rate: " + rate + "% p.a.\\n" +
        "Loan Tenure: " + months + " months (" +
            years.toString() + " years)\\n\\n" +
        "Monthly EMI: " + formatINR(result.monthlyEmi) + "\\n" +
        "Total Interest: " + formatINR(result.totalInterest) + "\\n" +
        "Total Repayment: " + formatINR(result.totalRepayment) +
        "\\n\\n" +
        "This is an estimate based on a standard reducing-balance " +
        "EMI calculation. Actual lender charges may differ.\\n\\n" +
        "Send HI to calculate another loan.\\n" +
        "Send RESET to restart or HELP for instructions."
    );
}

async function handleInstagramMessage(env, senderId, text) {
    const message = text.trim();
    const command = message.toUpperCase();

    if (command === "CANCEL") {
        conversations.delete(senderId);

        await sendInstagramText(
            env,
            senderId,
            "Your EMI calculation has been cancelled. " +
            "Send HI whenever you want to start again."
        );

        return;
    }

    if (command === "RESET" || command === "HI" ||
        command === "EMI" || command === "LOAN") {

        const reply = startConversation(senderId);

        await sendInstagramText(env, senderId, reply);
        return;
    }

    if (command === "HELP") {
        await sendInstagramText(
            env,
            senderId,
            "EMI Calculator Help\\n\\n" +
            "Send HI to start.\\n" +
            "1. Enter loan amount (example: 5 lakh).\\n" +
            "2. Enter annual interest rate (example: 9.5).\\n" +
            "3. Enter tenure (example: 5 years or 60 months).\\n\\n" +
            "Send RESET to restart or CANCEL to stop."
        );
        return;
    }

    const conversation = getConversation(senderId);

    if (!conversation) {
        await sendInstagramText(
            env,
            senderId,
            "Welcome! Send HI, EMI or LOAN to calculate your EMI."
        );
        return;
    }

    if (conversation.state === STATE.PRINCIPAL) {
        const principal = parsePrincipal(message);

        if (principal === null) {
            await sendInstagramText(
                env,
                senderId,
                "Please enter a valid loan amount.\\n" +
                "Example: 500000 or 5 lakh.\\n" +
                "Maximum supported amount: ₹100 crore."
            );
            return;
        }

        conversation.principal = principal;
        conversation.state = STATE.RATE;
        saveConversation(senderId, conversation);

        await sendInstagramText(
            env,
            senderId,
            "Loan amount: " + formatINR(principal) + "\\n\\n" +
            "Step 2 of 3: Enter the annual interest rate.\\n" +
            "Example: 9.5"
        );
        return;
    }

    if (conversation.state === STATE.RATE) {
        const rate = parseRate(message);

        if (rate === null) {
            await sendInstagramText(
                env,
                senderId,
                "Please enter a valid annual interest rate " +
                "between 0 and 100.\\nExample: 9.5"
            );
            return;
        }

        conversation.rate = rate;
        conversation.state = STATE.TENURE;
        saveConversation(senderId, conversation);

        await sendInstagramText(
            env,
            senderId,
            "Interest rate: " + rate + "% p.a.\\n\\n" +
            "Step 3 of 3: Enter the loan tenure.\\n" +
            "Examples: 5 years or 60 months."
        );
        return;
    }

    if (conversation.state === STATE.TENURE) {
        const months = parseTenure(message);

        if (months === null) {
            await sendInstagramText(
                env,
                senderId,
                "Please enter a valid tenure between 1 and 600 months.\\n" +
                "Examples: 5 years or 60 months."
            );
            return;
        }

        conversation.tenureMonths = months;

        try {
            const result = calculateLoan(
                conversation.principal,
                conversation.rate,
                conversation.tenureMonths
            );

            const reply = formatResult(
                result,
                conversation.principal,
                conversation.rate,
                conversation.tenureMonths
            );

            conversations.delete(senderId);

            await sendInstagramText(env, senderId, reply);
        } catch (error) {
            console.error("Loan calculation error:", error);

            conversations.delete(senderId);

            await sendInstagramText(
                env,
                senderId,
                "Sorry, the calculation could not be completed. " +
                "Please send HI to try again."
            );
        }
    }
}

// --------------------------------------------------
// Meta webhook signature verification
// --------------------------------------------------

function bytesFromHex(hex) {
    if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
        return null;
    }

    const bytes = new Uint8Array(hex.length / 2);

    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }

    return bytes;
}

function constantTimeEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;

    let difference = 0;

    for (let i = 0; i < a.length; i++) {
        difference |= a[i] ^ b[i];
    }

    return difference === 0;
}

async function verifyMetaSignature(rawBody, signatureHeader, appSecret) {
    if (!signatureHeader || !appSecret) return false;

    const match = signatureHeader.match(/^sha256=([0-9a-f]{64})$/i);

    if (!match) return false;

    const suppliedSignature = bytesFromHex(match[1]);

    if (!suppliedSignature) return false;

    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(appSecret),
        {
            name: "HMAC",
            hash: "SHA-256"
        },
        false,
        ["sign"]
    );

    const expectedSignature = new Uint8Array(
        await crypto.subtle.sign(
            "HMAC",
            key,
            rawBody
        )
    );

    return constantTimeEqual(
        expectedSignature,
        suppliedSignature
    );
}

// --------------------------------------------------
// Webhook event extraction
// --------------------------------------------------

function extractInstagramMessages(payload) {
    const messages = [];

    for (const entry of payload.entry || []) {
        // Instagram Messaging webhook format.
        for (const event of entry.messaging || []) {
            if (
                event.message &&
                typeof event.message.text === "string" &&
                event.sender?.id
            ) {
                messages.push({
                    senderId: event.sender.id,
                    messageId: event.message.mid || null,
                    text: event.message.text,
                    isEcho: event.message.is_echo === true
                });
            }
        }

        // Changes-based webhook format.
        for (const change of entry.changes || []) {
            if (change.field !== "messages") continue;

            const value = change.value || {};
            const senderId = value.sender?.id ||
                value.from?.id ||
                value.sender_id;

            const text = value.message?.text ||
                value.text;

            if (senderId && typeof text === "string") {
                messages.push({
                    senderId,
                    messageId: value.message?.mid ||
                        value.message_id ||
                        null,
                    text,
                    isEcho: value.message?.is_echo === true
                });
            }
        }
    }

    return messages;
}

function isDuplicateMessage(messageId) {
    if (!messageId) return false;

    const now = Date.now();

    // Remove old IDs and cap memory usage.
    for (const [id, timestamp] of processedMessageIds) {
        if (now - timestamp > 60 * 60 * 1000) {
            processedMessageIds.delete(id);
        }
    }

    if (processedMessageIds.has(messageId)) {
        return true;
    }

    processedMessageIds.set(messageId, now);

    if (processedMessageIds.size > 5000) {
        const oldestId = processedMessageIds.keys().next().value;
        processedMessageIds.delete(oldestId);
    }

    return false;
}

// --------------------------------------------------
// Cloudflare Worker entry point
// --------------------------------------------------

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // Meta webhook verification.
        if (request.method === "GET") {
            const mode = url.searchParams.get("hub.mode");
            const token = url.searchParams.get("hub.verify_token");
            const challenge = url.searchParams.get("hub.challenge");

            if (
                mode === "subscribe" &&
                token &&
                token === env.META_VERIFY_TOKEN &&
                challenge
            ) {
                return new Response(challenge, {
                    status: 200,
                    headers: {
                        "Content-Type": "text/plain"
                    }
                });
            }

            return new Response("Forbidden", { status: 403 });
        }

        if (request.method !== "POST") {
            return new Response("Method Not Allowed", {
                status: 405
            });
        }

        const rawBody = await request.arrayBuffer();

        const validSignature = await verifyMetaSignature(
            rawBody,
            request.headers.get("X-Hub-Signature-256"),
            env.META_APP_SECRET
        );

        if (!validSignature) {
            return new Response("Invalid signature", {
                status: 401
            });
        }

        let payload;

        try {
            payload = JSON.parse(
                new TextDecoder().decode(rawBody)
            );
        } catch {
            return new Response("Invalid JSON", {
                status: 400
            });
        }

        if (payload.object !== "instagram") {
            return new Response("Ignored", { status: 200 });
        }

        const messages = extractInstagramMessages(payload);

        for (const message of messages) {
            if (message.isEcho) continue;
            if (message.senderId === INSTAGRAM_ACCOUNT_ID) continue;
            if (isDuplicateMessage(message.messageId)) continue;

            try {
                await handleInstagramMessage(
                    env,
                    message.senderId,
                    message.text
                );
            } catch (error) {
                console.error("Instagram message processing failed:", {
                    senderId: message.senderId,
                    error: String(error)
                });
            }
        }

        return new Response("EVENT_RECEIVED", {
            status: 200
        });
    }
};
