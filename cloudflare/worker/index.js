import loanWasmModule from "./loan_worker.wasm";

import {
    parsePrincipal,
    parseRate,
    parseTenure
} from "./input_parser.mjs";

const GRAPH_API_VERSION = "v27.0";
const INSTAGRAM_ACCOUNT_ID = "17841427456411892";

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const MESSAGE_RETENTION_SECONDS = 24 * 60 * 60;
const COMPLETED_MESSAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SENDER_LOCK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SENDER_LOCK_MS = 2 * 60 * 1000;
const SEND_TIMEOUT_MS = 10 * 1000;
const MAX_OUTBOUND_ATTEMPTS = 8;
const MAX_MESSAGES_PER_DRAIN = 10;
const MAX_MESSAGES_PER_WEBHOOK_DRAIN = 2;
const MAX_SENDERS_PER_SCHEDULED_RUN = 25;
const REORDER_BUFFER_MS = 250;
const SQLITE_NOW_MS =
    "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
const ACTIVE_SENDER_LOCK_SQL = `
    EXISTS (
        SELECT 1 FROM sender_processing
        WHERE sender_id = ? AND lock_token = ?
            AND locked_until > ${SQLITE_NOW_MS}
    )
`;

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

const loanEngine = loanWasmInstance instanceof WebAssembly.Instance
    ? loanWasmInstance.exports
    : loanWasmInstance.instance.exports;

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

class InstagramSendError extends Error {
    constructor(message, status, permanent) {
        super(message);
        this.name = "InstagramSendError";
        this.status = status;
        this.permanent = permanent;
    }
}

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
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        body: JSON.stringify({
            recipient: { id: recipientId },
            message: { text }
        })
    });

    if (!response.ok) {
        const errorBody = await response.text();
        let graphError = null;

        try {
            graphError = JSON.parse(errorBody).error || null;
        } catch {
            // Non-JSON error bodies are classified from the HTTP status.
        }

        console.error("Instagram Send API error:", {
            status: response.status,
            body: errorBody.slice(0, 1000)
        });

        const transientStatus = [408, 425, 429].includes(response.status) ||
            response.status >= 500;
        const permanent = graphError?.is_transient !== true &&
            !transientStatus;
        const graphMessage = typeof graphError?.message === "string"
            ? `: ${graphError.message.slice(0, 300)}`
            : "";

        throw new InstagramSendError(
            `Instagram Send API failed: ${response.status}` +
                (graphError?.code ? ` (code ${graphError.code})` : "") +
                graphMessage,
            response.status,
            permanent
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

    if (!row) return { conversation: null, expired: false };

    if (Date.now() - row.updated_at > SESSION_TIMEOUT_MS) {
        return { conversation: null, expired: true };
    }

    return {
        conversation: {
            state: row.state,
            principal: row.principal,
            rate: row.annual_rate,
            tenureMonths: row.tenure_months,
            updatedAt: row.updated_at
        },
        expired: false
    };
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

function startConversationReply() {
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
        "You can enter the amount in rupees or use lakh/crore.\n" +
        "Please don't use commas."
    );
}

function buildMessageOutcome(text, conversation) {
    const message = text.trim();
    const command = message.toUpperCase();

    if (command === "CANCEL") {
        return {
            deleteConversation: true,
            reply: "Your EMI calculation has been cancelled. " +
                "Send HI whenever you want to start again."
        };
    }

    if (["RESET", "HI", "EMI", "LOAN"].includes(command)) {
        return {
            nextConversation: {
                state: STATE.PRINCIPAL,
                principal: null,
                rate: null,
                tenureMonths: null
            },
            reply: startConversationReply()
        };
    }

    if (command === "HELP") {
        return {
            reply: "EMI Calculator Help\n\n" +
            "Send HI to start.\n\n" +
            "1. Enter loan amount in rupees or lakh/crore.\n" +
            "   Example: 500000 or 5 lakh.\n\n" +
            "2. Enter annual interest rate.\n" +
            "   Example: 9.5\n\n" +
            "3. Enter tenure.\n" +
            "   Example: 5 years or 60 months.\n\n" +
            "Send RESET to restart or CANCEL to stop."
        };
    }

    if (!conversation) {
        return {
            reply: "Welcome! Send HI, EMI or LOAN to calculate your EMI."
        };
    }

    // Step 1: Principal
    if (conversation.state === STATE.PRINCIPAL) {
        const principal = parsePrincipal(message);

        if (principal === null) {
            return {
                reply: "Invalid loan amount.\n\n" +
                "Enter an amount such as:\n" +
                "500000 = ₹5 lakh\n" +
                "50000 = ₹50 thousand\n" +
                "5 lakh\n" +
                "50 lakh\n" +
                "5 crore\n\n" +
                "Maximum supported amount: ₹100 crore.\n" +
                "Please don't use commas."
            };
        }

        return {
            nextConversation: {
                ...conversation,
                principal,
                state: STATE.RATE
            },
            reply: "Loan amount: " + formatINR(principal) +
                "\n\nStep 2 of 3: Enter the annual interest rate.\n" +
                "Example: 9.5"
        };
    }

    // Step 2: Interest rate
    if (conversation.state === STATE.RATE) {
        const rate = parseRate(message);

        if (rate === null) {
            return {
                reply: "Invalid interest rate.\n\n" +
                "Enter an annual rate between 0 and 100.\n" +
                "Example: 9.5"
            };
        }

        return {
            nextConversation: {
                ...conversation,
                rate,
                state: STATE.TENURE
            },
            reply: "Interest rate: " + rate +
                "% p.a.\n\nStep 3 of 3: Enter the loan tenure.\n" +
                "Examples: 5 years or 60 months.\n" +
                "A number without a unit is treated as months."
        };
    }

    // Step 3: Tenure
    if (conversation.state === STATE.TENURE) {
        const months = parseTenure(message);

        if (months === null) {
            return {
                reply: "Invalid loan tenure.\n\n" +
                "Enter a value between 1 and 600 months.\n" +
                "Examples: 5 years or 60 months.\n" +
                "A number without a unit is treated as months."
            };
        }

        try {
            const result = calculateLoan(
                conversation.principal,
                conversation.rate,
                months
            );

            return {
                deleteConversation: true,
                reply: formatResult(
                    result,
                    conversation.principal,
                    conversation.rate,
                    months
                )
            };
        } catch (error) {
            console.error("Loan calculation error:", error);

            return {
                deleteConversation: true,
                reply: "Sorry, the calculation could not be completed. " +
                    "Please send HI to try again."
            };
        }
    }

    return {
        reply: "Sorry, I could not process that message. " +
            "Send HELP for instructions."
    };
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
                    senderId: String(event.sender.id),
                    messageId: event.message.mid
                        ? String(event.message.mid)
                        : null,
                    eventTimestamp: event.timestamp,
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
                    senderId: String(senderId),
                    messageId: value.message?.mid || value.message_id
                        ? String(value.message?.mid || value.message_id)
                        : null,
                    eventTimestamp: value.timestamp,
                    text,
                    isEcho: value.message?.is_echo === true
                });
            }
        }
    }

    return messages;
}

// --------------------------------------------------
// Durable webhook inbox and outbound reply delivery
// --------------------------------------------------

function getEventTimestamp(value, fallback) {
    const timestamp = Number(value);
    return Number.isSafeInteger(timestamp) && timestamp > 0
        ? timestamp
        : fallback;
}

async function hashRawBody(rawBody) {
    const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", rawBody)
    );

    return Array.from(digest, byte => byte.toString(16).padStart(2, "0"))
        .join("");
}

async function persistWebhookMessages(env, messages, rawBody, receivedAt) {
    const bodyHash = await hashRawBody(rawBody);
    const acceptedMessages = [];

    for (const message of messages) {
        if (
            message.isEcho ||
            message.senderId === INSTAGRAM_ACCOUNT_ID
        ) {
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

        acceptedMessages.push(message);
    }

    const statements = acceptedMessages.map((message, index) => {
        const messageId = message.messageId ||
            `fallback-${bodyHash}-${index}`;

        return env.DB.prepare(`
            INSERT OR IGNORE INTO webhook_inbox (
                message_id,
                sender_id,
                message_text,
                event_timestamp,
                received_at,
                status
            )
            VALUES (?, ?, ?, ?, ?, 'queued')
        `).bind(
            messageId,
            message.senderId,
            message.text,
            getEventTimestamp(message.eventTimestamp, receivedAt),
            receivedAt
        );
    });

    if (statements.length > 0) {
        await env.DB.batch(statements);
    }

    return Array.from(new Set(acceptedMessages.map(message => message.senderId)));
}

function activeSenderLockStatement(env, senderId, lockToken) {
    return env.DB.prepare(`
        UPDATE sender_processing
        SET locked_until = ${SQLITE_NOW_MS} + ?,
            last_activity_at = ${SQLITE_NOW_MS}
        WHERE sender_id = ? AND lock_token = ?
            AND locked_until > ${SQLITE_NOW_MS}
    `).bind(SENDER_LOCK_MS, senderId, lockToken);
}

function buildConversationStatements(env, senderId, outcome, lockToken) {
    if (outcome.deleteConversation) {
        return [env.DB.prepare(`
            DELETE FROM conversations
            WHERE sender_id = ? AND ${ACTIVE_SENDER_LOCK_SQL}
        `).bind(senderId, senderId, lockToken)];
    }

    if (outcome.nextConversation) {
        const conversation = outcome.nextConversation;

        return [env.DB.prepare(`
            INSERT INTO conversations (
                sender_id,
                state,
                principal,
                annual_rate,
                tenure_months,
                updated_at
            )
            SELECT ?, ?, ?, ?, ?, ${SQLITE_NOW_MS}
            WHERE ${ACTIVE_SENDER_LOCK_SQL}
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
            senderId,
            lockToken
        )];
    }

    return [];
}

async function prepareOutboundReply(env, inboxMessage, outcome, lockToken) {
    const statements = buildConversationStatements(
        env,
        inboxMessage.sender_id,
        outcome,
        lockToken
    );

    statements.unshift(
        activeSenderLockStatement(env, inboxMessage.sender_id, lockToken)
    );

    statements.push(env.DB.prepare(`
        INSERT OR IGNORE INTO outbound_messages (
            inbound_message_id,
            recipient_id,
            message_text,
            status,
            created_at
        )
        SELECT ?, ?, ?, 'pending', ${SQLITE_NOW_MS}
        WHERE ${ACTIVE_SENDER_LOCK_SQL}
    `).bind(
        inboxMessage.message_id,
        inboxMessage.sender_id,
        outcome.reply,
        inboxMessage.sender_id,
        lockToken
    ));

    statements.push(env.DB.prepare(`
        UPDATE webhook_inbox
        SET status = 'reply_pending'
        WHERE message_id = ? AND status = 'queued'
            AND ${ACTIVE_SENDER_LOCK_SQL}
    `).bind(
        inboxMessage.message_id,
        inboxMessage.sender_id,
        lockToken
    ));

    const results = await env.DB.batch(statements);
    return results[0].meta?.changes === 1;
}

async function acquireSenderLock(env, senderId, lockToken) {
    return env.DB.prepare(`
        INSERT INTO sender_processing (
            sender_id,
            lock_token,
            locked_until,
            last_event_timestamp,
            last_activity_at
        )
        VALUES (?, ?, ${SQLITE_NOW_MS} + ?, 0, ${SQLITE_NOW_MS})
        ON CONFLICT(sender_id) DO UPDATE SET
            lock_token = excluded.lock_token,
            locked_until = excluded.locked_until,
            last_activity_at = excluded.last_activity_at
        WHERE sender_processing.locked_until <= ${SQLITE_NOW_MS}
        RETURNING last_event_timestamp
    `).bind(
        senderId,
        lockToken,
        SENDER_LOCK_MS
    ).first();
}

async function renewSenderLock(env, senderId, lockToken) {
    const result = await activeSenderLockStatement(
        env,
        senderId,
        lockToken
    ).run();

    return result.meta?.changes === 1;
}

async function getNextSenderMessage(env, senderId) {
    return env.DB.prepare(`
        SELECT
            inbox.message_id,
            inbox.sender_id,
            inbox.message_text,
            inbox.event_timestamp,
            inbox.status,
            outbound.message_text AS reply_text,
            outbound.attempt_count,
            outbound.next_attempt_at
        FROM webhook_inbox AS inbox
        LEFT JOIN outbound_messages AS outbound
            ON outbound.inbound_message_id = inbox.message_id
        WHERE inbox.sender_id = ?
            AND inbox.status IN ('queued', 'reply_pending')
        ORDER BY inbox.event_timestamp, inbox.sequence
        LIMIT 1
    `).bind(senderId).first();
}

async function createPendingReply(
    env,
    inboxMessage,
    lastEventTimestamp,
    lockToken
) {
    let outcome;

    if (inboxMessage.event_timestamp < lastEventTimestamp) {
        outcome = {
            reply: "I received that message out of order. To avoid mixing " +
                "your calculation steps, please send that answer again now."
        };
    } else {
        const stored = await getConversation(env, inboxMessage.sender_id);
        outcome = buildMessageOutcome(inboxMessage.message_text, stored.conversation);

        if (
            stored.expired &&
            !outcome.nextConversation &&
            !outcome.deleteConversation
        ) {
            outcome.deleteConversation = true;
        }
    }

    return prepareOutboundReply(env, inboxMessage, outcome, lockToken);
}

async function markReplySent(env, inboxMessage, lockToken) {
    const results = await env.DB.batch([
        activeSenderLockStatement(env, inboxMessage.sender_id, lockToken),
        env.DB.prepare(`
            UPDATE outbound_messages
            SET status = 'sent', sent_at = ${SQLITE_NOW_MS}, last_error = NULL
            WHERE inbound_message_id = ? AND status = 'pending'
                AND ${ACTIVE_SENDER_LOCK_SQL}
        `).bind(
            inboxMessage.message_id,
            inboxMessage.sender_id,
            lockToken
        ),
        env.DB.prepare(`
            UPDATE webhook_inbox
            SET status = 'completed',
                completed_at = ${SQLITE_NOW_MS},
                last_error = NULL
            WHERE message_id = ? AND status = 'reply_pending'
                AND ${ACTIVE_SENDER_LOCK_SQL}
        `).bind(
            inboxMessage.message_id,
            inboxMessage.sender_id,
            lockToken
        ),
        env.DB.prepare(`
            UPDATE sender_processing
            SET last_event_timestamp = MAX(last_event_timestamp, ?),
                last_activity_at = ${SQLITE_NOW_MS}
            WHERE sender_id = ? AND lock_token = ?
                AND locked_until > ${SQLITE_NOW_MS}
        `).bind(
            inboxMessage.event_timestamp,
            inboxMessage.sender_id,
            lockToken
        )
    ]);

    return results.every(result => result.meta?.changes === 1);
}

async function recordSendFailure(env, inboxMessage, error, lockToken) {
    const attemptCount = inboxMessage.attempt_count + 1;
    const permanent = error instanceof InstagramSendError && error.permanent;
    const terminal = permanent || attemptCount >= MAX_OUTBOUND_ATTEMPTS;
    const failureType = permanent
        ? "permanent"
        : terminal
            ? "retry_exhausted"
            : "transient";
    const status = terminal ? "failed" : "pending";
    const nextAttemptAt = terminal
        ? 0
        : Date.now() + Math.min(
            60 * 60 * 1000,
            1000 * (2 ** Math.min(attemptCount, 12))
        );
    const errorText = String(error).slice(0, 1000);

    const statements = [
        activeSenderLockStatement(env, inboxMessage.sender_id, lockToken),
        env.DB.prepare(`
            UPDATE outbound_messages
            SET status = ?,
                attempt_count = attempt_count + 1,
                next_attempt_at = ?,
                last_error = ?,
                failed_at = CASE WHEN ? = 1
                    THEN ${SQLITE_NOW_MS} ELSE NULL END
            WHERE inbound_message_id = ? AND status = 'pending'
                AND ${ACTIVE_SENDER_LOCK_SQL}
        `).bind(
            status,
            nextAttemptAt,
            errorText,
            terminal ? 1 : 0,
            inboxMessage.message_id,
            inboxMessage.sender_id,
            lockToken
        ),
        env.DB.prepare(`
            UPDATE webhook_inbox
            SET status = ?,
                last_error = ?,
                failed_at = CASE WHEN ? = 1
                    THEN ${SQLITE_NOW_MS} ELSE NULL END
            WHERE message_id = ? AND status = 'reply_pending'
                AND ${ACTIVE_SENDER_LOCK_SQL}
        `).bind(
            terminal ? "failed" : "reply_pending",
            errorText,
            terminal ? 1 : 0,
            inboxMessage.message_id,
            inboxMessage.sender_id,
            lockToken
        )
    ];

    if (terminal) {
        statements.push(env.DB.prepare(`
            UPDATE sender_processing
            SET last_event_timestamp = MAX(last_event_timestamp, ?),
                last_activity_at = ${SQLITE_NOW_MS}
            WHERE sender_id = ? AND lock_token = ?
                AND locked_until > ${SQLITE_NOW_MS}
        `).bind(
            inboxMessage.event_timestamp,
            inboxMessage.sender_id,
            lockToken
        ));
    }

    const results = await env.DB.batch(statements);

    if (!results.every(result => result.meta?.changes === 1)) {
        return { recorded: false, terminal: false };
    }

    console.error("Instagram reply delivery failure recorded:", {
        senderId: inboxMessage.sender_id,
        messageId: inboxMessage.message_id,
        attemptCount,
        failureType,
        nextAttemptAt: terminal ? null : nextAttemptAt,
        error: errorText
    });

    return { recorded: true, terminal };
}

async function drainSenderQueue(
    env,
    senderId,
    settleConcurrentMessages,
    maxMessages = MAX_MESSAGES_PER_DRAIN
) {
    if (settleConcurrentMessages) {
        await new Promise(resolve => setTimeout(resolve, REORDER_BUFFER_MS));
    }

    const lockToken = crypto.randomUUID();
    const lock = await acquireSenderLock(env, senderId, lockToken);

    if (!lock) return;

    let lastEventTimestamp = lock.last_event_timestamp;

    try {
        for (let count = 0; count < maxMessages; count++) {
            if (!await renewSenderLock(env, senderId, lockToken)) {
                return;
            }

            const inboxMessage = await getNextSenderMessage(env, senderId);
            if (!inboxMessage) return;

            if (inboxMessage.status === "reply_pending") {
                if (!inboxMessage.reply_text) {
                    throw new Error(
                        `Missing outbound reply for ${inboxMessage.message_id}`
                    );
                }

                if (inboxMessage.next_attempt_at > Date.now()) return;
            } else {
                const prepared = await createPendingReply(
                    env,
                    inboxMessage,
                    lastEventTimestamp,
                    lockToken
                );
                if (!prepared) return;

                const pending = await getNextSenderMessage(env, senderId);
                if (!pending || pending.message_id !== inboxMessage.message_id) {
                    throw new Error(
                        `Could not persist reply for ${inboxMessage.message_id}`
                    );
                }

                inboxMessage.reply_text = pending.reply_text;
                inboxMessage.attempt_count = pending.attempt_count;
                inboxMessage.status = pending.status;
            }

            if (!await renewSenderLock(env, senderId, lockToken)) {
                return;
            }

            try {
                await sendInstagramText(
                    env,
                    inboxMessage.sender_id,
                    inboxMessage.reply_text
                );
            } catch (error) {
                const failure = await recordSendFailure(
                    env,
                    inboxMessage,
                    error,
                    lockToken
                );
                if (!failure.recorded || !failure.terminal) return;
                lastEventTimestamp = Math.max(
                    lastEventTimestamp,
                    inboxMessage.event_timestamp
                );
                continue;
            }

            if (!await markReplySent(env, inboxMessage, lockToken)) {
                return;
            }
            lastEventTimestamp = Math.max(
                lastEventTimestamp,
                inboxMessage.event_timestamp
            );
        }
    } finally {
        await env.DB.prepare(`
            UPDATE sender_processing
            SET lock_token = NULL, locked_until = 0, last_activity_at = ?
            WHERE sender_id = ? AND lock_token = ?
        `).bind(Date.now(), senderId, lockToken).run();
    }
}

async function drainSenderSafely(
    env,
    senderId,
    settleConcurrentMessages,
    maxMessages
) {
    try {
        await drainSenderQueue(
            env,
            senderId,
            settleConcurrentMessages,
            maxMessages
        );
    } catch (error) {
        console.error("Could not drain Instagram sender queue:", {
            senderId,
            error: String(error)
        });
    }
}

async function retryPendingMessages(env) {
    const now = Date.now();

    await env.DB.batch([
        env.DB.prepare(`
            DELETE FROM webhook_inbox
            WHERE (status = 'completed' AND completed_at < ?)
                OR (status = 'failed' AND failed_at < ?)
        `).bind(
            now - COMPLETED_MESSAGE_RETENTION_MS,
            now - COMPLETED_MESSAGE_RETENTION_MS
        ),
        env.DB.prepare(`
            DELETE FROM sender_processing
            WHERE locked_until = 0
                AND last_activity_at < ?
                AND NOT EXISTS (
                    SELECT 1 FROM webhook_inbox
                    WHERE webhook_inbox.sender_id = sender_processing.sender_id
                        AND webhook_inbox.status != 'completed'
                )
                AND NOT EXISTS (
                    SELECT 1 FROM conversations
                    WHERE conversations.sender_id = sender_processing.sender_id
                        AND conversations.updated_at >= ?
                )
        `).bind(
            now - SENDER_LOCK_RETENTION_MS,
            now - SESSION_TIMEOUT_MS
        ),
        env.DB.prepare(`
            DELETE FROM processed_messages
            WHERE processed_at < ?
        `).bind(
            Math.floor(now / 1000) - MESSAGE_RETENTION_SECONDS
        )
    ]);

    const { results } = await env.DB.prepare(`
        SELECT DISTINCT inbox.sender_id
        FROM webhook_inbox AS inbox
        LEFT JOIN outbound_messages AS outbound
            ON outbound.inbound_message_id = inbox.message_id
        WHERE inbox.status = 'queued'
            OR (
                inbox.status = 'reply_pending' AND
                (
                    outbound.next_attempt_at IS NULL OR
                    outbound.next_attempt_at <= ?
                )
            )
        ORDER BY inbox.sender_id
        LIMIT ?
    `).bind(
        now,
        MAX_SENDERS_PER_SCHEDULED_RUN
    ).all();

    await Promise.all(results.map(row =>
        drainSenderSafely(env, row.sender_id, false)
    ));
}

// --------------------------------------------------
// Cloudflare Worker entry point
// --------------------------------------------------

export default {
    async fetch(request, env, ctx) {
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
        let senderIds;

        try {
            senderIds = await persistWebhookMessages(
                env,
                messages,
                rawBody,
                Date.now()
            );
        } catch (error) {
            console.error("Could not persist Instagram webhook messages:", {
                error: String(error)
            });
            return new Response("Temporary failure", { status: 503 });
        }

        const processing = Promise.all(senderIds.map(senderId =>
            drainSenderSafely(
                env,
                senderId,
                true,
                MAX_MESSAGES_PER_WEBHOOK_DRAIN
            )
        ));

        if (ctx && typeof ctx.waitUntil === "function") {
            ctx.waitUntil(processing);
        } else {
            await processing;
        }

        return new Response("EVENT_RECEIVED", { status: 200 });
    },

    async scheduled(controller, env, ctx) {
        const processing = retryPendingMessages(env);

        if (ctx && typeof ctx.waitUntil === "function") {
            ctx.waitUntil(processing);
        } else {
            await processing;
        }
    }
};
