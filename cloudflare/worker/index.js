import loanWasmModule from "./loan_worker.wasm";

import {
    MAX_PRINCIPAL,
    MAX_ANNUAL_RATE,
    MAX_TENURE_MONTHS,
    parsePrincipal,
    parseRate,
    parseTenure
} from "./input_parser.mjs";

const GRAPH_API_VERSION = "v27.0";
const INSTAGRAM_ACCOUNT_ID = "17841427456411892";

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const MESSAGE_RETENTION_SECONDS = 24 * 60 * 60;

// Existing in-memory deduplication remains as an additional safeguard.
const processedMessageIds = new Map();

const STATE = {
    PRINCIPAL: "WAITING_FOR_PRINCIPAL",
    RATE: "WAITING_FOR_RATE",
    TENURE: "WAITING_FOR_TENURE"
};

// --------------------------------------------------
// Tester/public access control
// --------------------------------------------------

function getAllowedSenderIds(env) {
    return new Set(
        (env.ALLOWED_INSTAGRAM_SENDER_IDS || "")
            .split(",")
            .map(id => id.trim())
            .filter(Boolean)
    );
}

function isSenderAllowed(env, senderId) {
    const mode = (env.BOT_ACCESS_MODE || "TESTERS")
        .trim()
        .toUpperCase();

    if (mode === "PUBLIC") {
        return true;
    }

    if (mode !== "TESTERS") {
        console.error("Invalid BOT_ACCESS_MODE configuration.");
        return false;
    }

    const allowedSenderIds = getAllowedSenderIds(env);

    return (
        allowedSenderIds.size > 0 &&
        allowedSenderIds.has(senderId)
    );
}

// --------------------------------------------------
// C++ WebAssembly engine
// --------------------------------------------------

const loanWasmInstance = await WebAssembly.instantiate(
    loanWasmModule,
    {}
);

const loanEngine = loanWasmInstance.exports;

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
        throw new Error("C++ engine returned invalid results.");
    }

    return { monthlyEmi, totalInterest, totalRepayment };
}

// --------------------------------------------------
// Formatting
// --------------------------------------------------

function formatINR(value) {
    return new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 0
    }).format(value);
}

function formatTenure(months) {
    const years = Math.floor(months / 12);
    const remainingMonths = months % 12;

    if (years === 0) return `${months} months`;

    if (remainingMonths === 0) {
        return `${years} ${years === 1 ? "year" : "years"}`;
    }

    return (
        `${years} ${years === 1 ? "year" : "years"} and ` +
        `${remainingMonths} ${remainingMonths === 1 ? "month" : "months"}`
    );
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
            Authorization: `Bearer ${env.META_ACCESS_TOKEN}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            recipient: { id: recipientId },
            message: { text }
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
// D1 conversation storage
// --------------------------------------------------

async function getConversation(env, senderId) {
    const row = await env.DB.prepare(`
        SELECT
            sender_id,
            state,
            principal,
            annual_rate,
            tenure_months,
            updated_at
        FROM conversations
        WHERE sender_id = ?
    `).bind(senderId).first();

    if (!row) return null;

    if (Date.now() - row.updated_at > SESSION_TIMEOUT_MS) {
        await deleteConversation(env, senderId);
        return null;
    }

    return {
        state: row.state,
        principal: row.principal,
        rate: row.annual_rate,
        tenureMonths: row.tenure_months,
        updatedAt: row.updated_at
    };
}

async function saveConversation(env, senderId, conversation) {
    await env.DB.prepare(`
        INSERT INTO conversations (
            sender_id,
            state,
            principal,
            annual_rate,
            tenure_months,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(sender_id) DO UPDATE SET
            state = excluded.state,
            principal = excluded.principal,
            annual_rate = excluded.annual_rate,
            tenure_months = excluded.tenure_months,
            updated_at = excluded.updated_at
    `).bind(
        senderId,
        conversation.state,
        conversation.principal,
        conversation.rate,
        conversation.tenureMonths,
        Date.now()
    ).run();
}

async function deleteConversation(env, senderId) {
    await env.DB.prepare(`
        DELETE FROM conversations
        WHERE sender_id = ?
    `).bind(senderId).run();
}

async function startConversation(env, senderId) {
    await saveConversation(env, senderId, {
        state: STATE.PRINCIPAL,
        principal: null,
        rate: null,
        tenureMonths: null
    });

    return (
        "Welcome to Daily Finance India EMI Calculator!\n\n" +
        "Let's calculate your loan EMI.\n\n" +
        "Step 1 of 3: Enter your loan amount in rupees.\n\n" +
        "Examples:\n" +
        "500000 = ₹5 lakh\n" +
        "50000 = ₹50 thousand\n" +
        "5 lakh\n" +
        "50 lakh\n" +
        "5 crore\n\n" +
        "Please don't use commas."
    );
}

// --------------------------------------------------
// EMI result
// --------------------------------------------------

function formatResult(result, principal, rate, months) {
    return (
        "Your loan calculation is ready!\n\n" +
        "Loan Amount: " + formatINR(principal) + "\n" +
        "Interest Rate: " + rate + "% p.a.\n" +
        "Loan Tenure: " + formatTenure(months) + "\n\n" +
        "Monthly EMI: " + formatINR(result.monthlyEmi) + "\n" +
        "Total Interest: " + formatINR(result.totalInterest) + "\n" +
        "Total Repayment: " + formatINR(result.totalRepayment) +
        "\n\n" +
        "This is an estimate based on a standard reducing-balance " +
        "EMI calculation. Actual lender charges may differ.\n\n" +
        "Send HI to calculate another loan.\n" +
        "Send RESET to restart or HELP for instructions."
    );
}

// --------------------------------------------------
// Conversation state machine
// --------------------------------------------------

async function handleInstagramMessage(env, senderId, text) {
    const message = text.trim();
    const command = message.toUpperCase();

    if (command === "CANCEL") {
        await deleteConversation(env, senderId);

        await sendInstagramText(
            env,
            senderId,
            "Your EMI calculation has been cancelled. " +
            "Send HI whenever you want to start again."
        );

        return;
    }

    if (["RESET", "HI", "EMI", "LOAN"].includes(command)) {
        const reply = await startConversation(env, senderId);
        await sendInstagramText(env, senderId, reply);
        return;
    }

    if (command === "HELP") {
        await sendInstagramText(
            env,
            senderId,
            "EMI Calculator Help\n\n" +
            "Send HI to start.\n\n" +
            "1. Enter loan amount in rupees or lakh/crore.\n" +
            "   Example: 500000 or 5 lakh.\n\n" +
            "2. Enter annual interest rate.\n" +
            "   Example: 9.5\n\n" +
            "3. Enter tenure.\n" +
            "   Example: 5 years or 60 months.\n\n" +
            "Send RESET to restart or CANCEL to stop."
        );

        return;
    }

    const conversation = await getConversation(env, senderId);

    if (!conversation) {
        await sendInstagramText(
            env,
            senderId,
            "Welcome! Send HI, EMI or LOAN to calculate your EMI."
        );

        return;
    }

    // Step 1: Principal
    if (conversation.state === STATE.PRINCIPAL) {
        const principal = parsePrincipal(message);

        if (principal === null) {
            await sendInstagramText(
                env,
                senderId,
                "Invalid loan amount.\n\n" +
                "Enter an amount such as:\n" +
                "500000 = ₹5 lakh\n" +
                "50000 = ₹50 thousand\n" +
                "5 lakh\n\n" +
                "Maximum supported amount: ₹100 crore.\n" +
                "Please don't use commas."
            );

            return;
        }

        conversation.principal = principal;
        conversation.state = STATE.RATE;

        await saveConversation(env, senderId, conversation);

        await sendInstagramText(
            env,
            senderId,
            "Loan amount: " + formatINR(principal) +
            "\n\nStep 2 of 3: Enter the annual interest rate.\n" +
            "Example: 9.5"
        );

        return;
    }

    // Step 2: Interest rate
    if (conversation.state === STATE.RATE) {
        const rate = parseRate(message);

        if (rate === null) {
            await sendInstagramText(
                env,
                senderId,
                "Invalid interest rate.\n\n" +
                "Enter an annual rate between 0 and 100.\n" +
                "Example: 9.5"
            );

            return;
        }

        conversation.rate = rate;
        conversation.state = STATE.TENURE;

        await saveConversation(env, senderId, conversation);

        await sendInstagramText(
            env,
            senderId,
            "Interest rate: " + rate +
            "% p.a.\n\nStep 3 of 3: Enter the loan tenure.\n" +
            "Examples: 5 years or 60 months."
        );

        return;
    }

    // Step 3: Tenure
    if (conversation.state === STATE.TENURE) {
        const months = parseTenure(message);

        if (months === null) {
            await sendInstagramText(
                env,
                senderId,
                "Invalid loan tenure.\n\n" +
                "Enter a value between 1 and 600 months.\n" +
                "Examples: 5 years or 60 months."
            );

            return;
        }

        try {
            const result = calculateLoan(
                conversation.principal,
                conversation.rate,
                months
            );

            const reply = formatResult(
                result,
                conversation.principal,
                conversation.rate,
                months
            );

            await deleteConversation(env, senderId);
            await sendInstagramText(env, senderId, reply);
        } catch (error) {
            console.error("Loan calculation error:", error);

            await deleteConversation(env, senderId);

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
// Meta signature verification
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
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );

    const expectedSignature = new Uint8Array(
        await crypto.subtle.sign("HMAC", key, rawBody)
    );

    return constantTimeEqual(expectedSignature, suppliedSignature);
}

// --------------------------------------------------
// Webhook message extraction
// --------------------------------------------------

function extractInstagramMessages(payload) {
    const messages = [];

    for (const entry of payload.entry || []) {
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

        for (const change of entry.changes || []) {
            if (change.field !== "messages") continue;

            const value = change.value || {};
            const senderId =
                value.sender?.id ||
                value.from?.id ||
                value.sender_id;

            const text =
                value.message?.text ||
                value.text;

            if (senderId && typeof text === "string") {
                messages.push({
                    senderId,
                    messageId:
                        value.message?.mid ||
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

// --------------------------------------------------
// Persistent webhook deduplication using D1
// --------------------------------------------------

async function claimMessageId(env, messageId) {
    if (!messageId) return true;

    const now = Math.floor(Date.now() / 1000);

    // Remove old records periodically.
    await env.DB.prepare(`
        DELETE FROM processed_messages
        WHERE processed_at < ?
    `).bind(now - MESSAGE_RETENTION_SECONDS).run();

    // Only the first request can insert this message ID.
    const result = await env.DB.prepare(`
        INSERT OR IGNORE INTO processed_messages (
            message_id,
            processed_at
        )
        VALUES (?, ?)
    `).bind(messageId, now).run();

    return result.meta.changes === 1;
}

async function releaseMessageId(env, messageId) {
    if (!messageId) return;

    await env.DB.prepare(`
        DELETE FROM processed_messages
        WHERE message_id = ?
    `).bind(messageId).run();
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
                    headers: { "Content-Type": "text/plain" }
                });
            }

            return new Response("Forbidden", { status: 403 });
        }

        if (request.method !== "POST") {
            return new Response("Method Not Allowed", { status: 405 });
        }

        const rawBody = await request.arrayBuffer();

        const validSignature = await verifyMetaSignature(
            rawBody,
            request.headers.get("X-Hub-Signature-256"),
            env.META_APP_SECRET
        );

        if (!validSignature) {
            return new Response("Invalid signature", { status: 401 });
        }

        let payload;

        try {
            payload = JSON.parse(new TextDecoder().decode(rawBody));
        } catch {
            return new Response("Invalid JSON", { status: 400 });
        }

        if (payload.object !== "instagram") {
            return new Response("Ignored", { status: 200 });
        }

        const messages = extractInstagramMessages(payload);

        for (const message of messages) {
            if (message.isEcho) continue;

            if (message.senderId === INSTAGRAM_ACCOUNT_ID) {
                continue;
            }

            console.log("Instagram sender detected:", {
                senderId: message.senderId,
                messageId: message.messageId
            });

            if (!isSenderAllowed(env, message.senderId)) {
                console.log("Ignoring unauthorized Instagram sender:", {
                    senderId: message.senderId
                });

                continue;
            }

            if (isDuplicateMessage(message.messageId)) continue;

            let claimed = false;

            try {
                claimed = await claimMessageId(env, message.messageId);

                if (!claimed) continue;

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

                // Permit a future Meta retry if processing failed.
                if (claimed) {
                    try {
                        await releaseMessageId(env, message.messageId);
                    } catch (releaseError) {
                        console.error(
                            "Could not release failed message ID:",
                            String(releaseError)
                        );
                    }
                }
            }
        }

        return new Response("EVENT_RECEIVED", { status: 200 });
    }
};
