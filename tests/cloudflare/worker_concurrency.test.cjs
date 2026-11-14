const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const { webcrypto } = require("node:crypto");

if (!globalThis.crypto) {
    globalThis.crypto = webcrypto;
}

class MemoryD1 {
    constructor() {
        this.conversations = new Map();
        this.inbox = new Map();
        this.outbound = new Map();
        this.senderProcessing = new Map();
        this.processedMessages = new Map();
        this.nextSequence = 1;
        this.failNextBatch = false;
        this.pauseNextOutboundBatch = null;
    }

    prepare(sql) {
        const statement = sql.replace(/\s+/g, " ").trim().toLowerCase();
        const hasActiveLease = (senderId, lockToken) => {
            const lock = this.senderProcessing.get(senderId);
            return Boolean(
                lock &&
                lock.lock_token === lockToken &&
                lock.locked_until > Date.now()
            );
        };
        const execute = async (method, values) => {
            await Promise.resolve();

            if (method === "first" && statement.includes("from conversations")) {
                const row = this.conversations.get(values[0]);
                return row ? { ...row } : null;
            }

            if (
                method === "first" &&
                statement.startsWith("insert into sender_processing")
            ) {
                const [senderId, lockToken, leaseDuration] = values;
                let row = this.senderProcessing.get(senderId);

                if (!row) {
                    row = {
                        sender_id: senderId,
                        lock_token: lockToken,
                        locked_until: Date.now() + leaseDuration,
                        last_event_timestamp: 0,
                        last_activity_at: Date.now()
                    };
                    this.senderProcessing.set(senderId, row);
                    return { last_event_timestamp: row.last_event_timestamp };
                }

                if (row.locked_until > Date.now()) return null;

                row.lock_token = lockToken;
                row.locked_until = Date.now() + leaseDuration;
                row.last_activity_at = Date.now();
                return { last_event_timestamp: row.last_event_timestamp };
            }

            if (
                method === "first" &&
                statement.includes("from webhook_inbox as inbox")
            ) {
                const [senderId] = values;
                const row = Array.from(this.inbox.values())
                    .filter(item =>
                        item.sender_id === senderId &&
                        ["queued", "reply_pending"].includes(item.status)
                    )
                    .sort((a, b) =>
                        a.event_timestamp - b.event_timestamp ||
                        a.sequence - b.sequence
                    )[0];

                if (!row) return null;
                const outbound = this.outbound.get(row.message_id);

                return {
                    ...row,
                    reply_text: outbound ? outbound.message_text : null,
                    attempt_count: outbound ? outbound.attempt_count : null,
                    next_attempt_at: outbound ? outbound.next_attempt_at : null
                };
            }

            if (
                method === "all" &&
                statement.startsWith("select distinct inbox.sender_id from webhook_inbox")
            ) {
                const [now, limit] = values;
                const senders = new Set(
                    Array.from(this.inbox.values())
                        .filter(row =>
                            row.status === "queued" ||
                            (
                                row.status === "reply_pending" &&
                                this.outbound.get(row.message_id)?.status === "pending" &&
                                this.outbound.get(row.message_id)?.next_attempt_at <= now
                            )
                        )
                        .map(row => row.sender_id)
                );

                return {
                    results: Array.from(senders)
                        .sort()
                        .slice(0, limit)
                        .map(sender_id => ({ sender_id }))
                };
            }

            if (statement.startsWith("insert or ignore into webhook_inbox")) {
                const [
                    messageId,
                    senderId,
                    messageText,
                    eventTimestamp,
                    receivedAt
                ] = values;

                if (this.inbox.has(messageId)) {
                    return { meta: { changes: 0 } };
                }

                this.inbox.set(messageId, {
                    sequence: this.nextSequence++,
                    message_id: messageId,
                    sender_id: senderId,
                    message_text: messageText,
                    event_timestamp: eventTimestamp,
                    received_at: receivedAt,
                    status: "queued",
                    last_error: null,
                    completed_at: null,
                    failed_at: null
                });
                return { meta: { changes: 1 } };
            }

            if (statement.startsWith("insert into conversations")) {
                const [
                    senderId,
                    state,
                    principal,
                    rate,
                    tenureMonths,
                    lockSenderId,
                    lockToken
                ] = values;

                if (!hasActiveLease(lockSenderId, lockToken)) {
                    return { meta: { changes: 0 } };
                }

                this.conversations.set(senderId, {
                    sender_id: senderId,
                    state,
                    principal,
                    annual_rate: rate,
                    tenure_months: tenureMonths,
                    updated_at: Date.now()
                });
                return { meta: { changes: 1 } };
            }

            if (statement.startsWith("delete from conversations")) {
                if (!hasActiveLease(values[1], values[2])) {
                    return { meta: { changes: 0 } };
                }
                const changes = this.conversations.delete(values[0]) ? 1 : 0;
                return { meta: { changes } };
            }

            if (statement.startsWith("insert or ignore into outbound_messages")) {
                const [
                    messageId,
                    recipientId,
                    messageText,
                    lockSenderId,
                    lockToken
                ] = values;

                if (!hasActiveLease(lockSenderId, lockToken)) {
                    return { meta: { changes: 0 } };
                }
                if (this.outbound.has(messageId)) {
                    return { meta: { changes: 0 } };
                }

                this.outbound.set(messageId, {
                    inbound_message_id: messageId,
                    recipient_id: recipientId,
                    message_text: messageText,
                    status: "pending",
                    attempt_count: 0,
                    next_attempt_at: 0,
                    last_error: null,
                    created_at: Date.now(),
                    sent_at: null,
                    failed_at: null
                });
                return { meta: { changes: 1 } };
            }

            if (statement.startsWith("update webhook_inbox")) {
                let messageId;
                let lockSenderId;
                let lockToken;
                if (statement.includes("set status = ?")) {
                    [, , , messageId, lockSenderId, lockToken] = values;
                } else {
                    [messageId, lockSenderId, lockToken] = values;
                }
                if (!hasActiveLease(lockSenderId, lockToken)) {
                    return { meta: { changes: 0 } };
                }
                const row = this.inbox.get(messageId);
                if (!row) return { meta: { changes: 0 } };

                if (statement.includes("set status = 'reply_pending'")) {
                    if (row.status !== "queued") return { meta: { changes: 0 } };
                    row.status = "reply_pending";
                } else if (statement.includes("set status = 'completed'")) {
                    if (row.status !== "reply_pending") return { meta: { changes: 0 } };
                    row.status = "completed";
                    row.completed_at = Date.now();
                    row.last_error = null;
                } else if (statement.includes("set status = ?")) {
                    const [status, error, failed] = values;
                    if (row.status !== "reply_pending") {
                        return { meta: { changes: 0 } };
                    }
                    row.status = status;
                    row.last_error = error;
                    row.failed_at = failed ? Date.now() : null;
                } else if (statement.includes("set last_error = ?")) {
                    row.last_error = values[0];
                } else {
                    throw new Error(`Unsupported inbox update: ${statement}`);
                }

                return { meta: { changes: 1 } };
            }

            if (statement.startsWith("update outbound_messages")) {
                const sent = statement.includes("set status = 'sent'");
                const messageId = sent ? values[0] : values[4];
                const lockSenderId = sent ? values[1] : values[5];
                const lockToken = sent ? values[2] : values[6];
                if (!hasActiveLease(lockSenderId, lockToken)) {
                    return { meta: { changes: 0 } };
                }
                const row = this.outbound.get(messageId);
                if (!row || row.status !== "pending") {
                    return { meta: { changes: 0 } };
                }

                if (sent) {
                    row.status = "sent";
                    row.sent_at = Date.now();
                    row.last_error = null;
                } else if (statement.includes("attempt_count = attempt_count + 1")) {
                    const [status, nextAttemptAt, error, failed] = values;
                    row.status = status;
                    row.attempt_count++;
                    row.next_attempt_at = nextAttemptAt;
                    row.last_error = error;
                    row.failed_at = failed ? Date.now() : null;
                } else {
                    throw new Error(`Unsupported outbound update: ${statement}`);
                }

                return { meta: { changes: 1 } };
            }

            if (statement.startsWith("update sender_processing")) {
                if (statement.includes("set locked_until = cast(")) {
                    const [leaseDuration, senderId, lockToken] = values;
                    const row = this.senderProcessing.get(senderId);
                    if (!hasActiveLease(senderId, lockToken)) {
                        return { meta: { changes: 0 } };
                    }
                    row.locked_until = Date.now() + leaseDuration;
                    row.last_activity_at = Date.now();
                    return { meta: { changes: 1 } };
                }

                if (statement.includes("set last_event_timestamp = max")) {
                    const [
                        timestamp,
                        senderId,
                        lockToken
                    ] = values;
                    const row = this.senderProcessing.get(senderId);
                    if (!hasActiveLease(senderId, lockToken)) {
                        return { meta: { changes: 0 } };
                    }
                    row.last_event_timestamp = Math.max(
                        row.last_event_timestamp,
                        timestamp
                    );
                    row.last_activity_at = Date.now();
                    return { meta: { changes: 1 } };
                }

                if (statement.includes("set lock_token = null")) {
                    const [lastActivityAt, senderId, lockToken] = values;
                    const row = this.senderProcessing.get(senderId);
                    if (!row || row.lock_token !== lockToken) {
                        return { meta: { changes: 0 } };
                    }
                    row.lock_token = null;
                    row.locked_until = 0;
                    row.last_activity_at = lastActivityAt;
                    return { meta: { changes: 1 } };
                }

                throw new Error(`Unsupported sender update: ${statement}`);
            }

            if (statement.startsWith("delete from webhook_inbox")) {
                const [completedCutoff, failedCutoff] = values;
                let changes = 0;
                for (const [messageId, row] of this.inbox) {
                    if (
                        (
                            row.status === "completed" &&
                            row.completed_at < completedCutoff
                        ) ||
                        (
                            row.status === "failed" &&
                            row.failed_at < failedCutoff
                        )
                    ) {
                        this.inbox.delete(messageId);
                        this.outbound.delete(messageId);
                        changes++;
                    }
                }
                return { meta: { changes } };
            }

            if (statement.startsWith("delete from sender_processing")) {
                return { meta: { changes: 0 } };
            }

            if (statement.startsWith("delete from processed_messages")) {
                return { meta: { changes: 0 } };
            }

            throw new Error(`Unsupported D1 ${method} query: ${statement}`);
        };

        return {
            sql: statement,
            bind: (...values) => ({
                sql: statement,
                first: () => execute("first", values),
                all: () => execute("all", values),
                run: () => execute("run", values)
            })
        };
    }

    async batch(statements) {
        if (this.failNextBatch) {
            this.failNextBatch = false;
            throw new Error("simulated D1 batch failure");
        }

        if (
            this.pauseNextOutboundBatch &&
            statements.some(statement =>
                statement.sql.startsWith(
                    "insert or ignore into outbound_messages"
                )
            )
        ) {
            const pause = this.pauseNextOutboundBatch;
            this.pauseNextOutboundBatch = null;
            pause.onReached();
            await pause.continue;
        }

        const snapshot = {
            conversations: structuredClone(this.conversations),
            inbox: structuredClone(this.inbox),
            outbound: structuredClone(this.outbound),
            senderProcessing: structuredClone(this.senderProcessing),
            processedMessages: structuredClone(this.processedMessages),
            nextSequence: this.nextSequence
        };

        try {
            const results = [];
            for (const statement of statements) {
                results.push(await statement.run());
            }
            return results;
        } catch (error) {
            this.conversations = snapshot.conversations;
            this.inbox = snapshot.inbox;
            this.outbound = snapshot.outbound;
            this.senderProcessing = snapshot.senderProcessing;
            this.processedMessages = snapshot.processedMessages;
            this.nextSequence = snapshot.nextSequence;
            throw error;
        }
    }
}

async function signedRequest(senderId, messageId, text, secret, timestamp) {
    const body = JSON.stringify({
        object: "instagram",
        entry: [{
            messaging: [{
                sender: { id: senderId },
                timestamp,
                message: { mid: messageId, text }
            }]
        }]
    });

    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(body)
    );

    return new Request("https://worker.test/webhook", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Hub-Signature-256": `sha256=${Buffer.from(signature).toString("hex")}`
        },
        body
    });
}

async function main() {
    assert.ok(process.argv[2], "Pass the bundled Worker module path.");
    const workerPath = path.resolve(process.argv[2]);
    const { default: worker } = await import(pathToFileURL(workerPath).href);
    const senderIds = Array.from({ length: 16 }, (_, index) => `test-sender-${index}`);
    const secret = "local-worker-simulation-secret";
    const baseTimestamp = Date.now();
    const env = {
        ALLOWED_INSTAGRAM_SENDER_IDS: senderIds.join(","),
        BOT_ACCESS_MODE: "TESTERS",
        META_ACCESS_TOKEN: "local-test-token",
        META_APP_SECRET: secret,
        DB: new MemoryD1()
    };
    const sentMessages = [];
    const originalFetch = globalThis.fetch;
    let failedSendsRemaining = 0;
    const queuedSendResponses = [];
    let pauseNextSend = null;

    globalThis.fetch = async (url, options) => {
        const requestBody = JSON.parse(options.body);
        const sentMessage = {
            url: String(url),
            ...requestBody
        };

        if (
            pauseNextSend &&
            sentMessage.recipient.id === pauseNextSend.senderId
        ) {
            const pause = pauseNextSend;
            pauseNextSend = null;
            pause.onReached();
            await pause.continue;
        }

        if (failedSendsRemaining > 0) {
            failedSendsRemaining--;
            return new Response("temporary send failure", { status: 503 });
        }

        if (queuedSendResponses.length > 0) {
            const queuedResponse = queuedSendResponses.shift();
            return new Response(queuedResponse.body, {
                status: queuedResponse.status
            });
        }

        sentMessages.push(sentMessage);
        return new Response(null, { status: 200 });
    };

    try {
        const startResponses = await Promise.all(senderIds.map((senderId, index) =>
            signedRequest(
                senderId,
                `start-${index}`,
                "HI",
                secret,
                baseTimestamp + index
            ).then(request => worker.fetch(request, env))
        ));

        assert.ok(startResponses.every(response => response.status === 200));
        assert.equal(sentMessages.length, senderIds.length);
        assert.equal(env.DB.conversations.size, senderIds.length);

        for (const senderId of senderIds) {
            assert.equal(
                env.DB.conversations.get(senderId).state,
                "WAITING_FOR_PRINCIPAL"
            );
            assert.ok(
                sentMessages.some(message => message.recipient.id === senderId),
                `Expected a reply for ${senderId}.`
            );
        }

        const sentBeforeRetry = sentMessages.length;
        const duplicateRequests = await Promise.all([0, 1].map(() =>
            signedRequest(
                senderIds[0],
                "duplicate-event",
                "500000",
                secret,
                baseTimestamp + 100
            )
        ));
        const duplicateResponses = await Promise.all(
            duplicateRequests.map(request => worker.fetch(request, env))
        );

        assert.ok(duplicateResponses.every(response => response.status === 200));
        assert.equal(
            sentMessages.length,
            sentBeforeRetry + 1,
            "A duplicate inbound event should create one outbound reply."
        );
        assert.equal(
            env.DB.conversations.get(senderIds[0]).state,
            "WAITING_FOR_RATE"
        );

        const sequentialRequests = await Promise.all([
            signedRequest(
                senderIds[1],
                "same-sender-principal",
                "500000",
                secret,
                baseTimestamp + 200
            ),
            signedRequest(
                senderIds[1],
                "same-sender-rate",
                "8.5",
                secret,
                baseTimestamp + 201
            )
        ]);
        const sequentialResponses = await Promise.all(
            sequentialRequests.map(request => worker.fetch(request, env))
        );

        assert.ok(sequentialResponses.every(response => response.status === 200));
        assert.equal(
            env.DB.conversations.get(senderIds[1]).state,
            "WAITING_FOR_TENURE",
            "Same-sender messages should be applied in provider timestamp order."
        );
        assert.equal(
            env.DB.conversations.get(senderIds[1]).principal,
            500000
        );
        assert.equal(
            env.DB.conversations.get(senderIds[1]).annual_rate,
            8.5
        );

        const staleMessageResponse = await worker.fetch(
            await signedRequest(
                senderIds[1],
                "late-old-event",
                "900000",
                secret,
                baseTimestamp + 199
            ),
            env
        );
        assert.equal(staleMessageResponse.status, 200);
        assert.equal(
            env.DB.conversations.get(senderIds[1]).state,
            "WAITING_FOR_TENURE",
            "A late older event must not overwrite newer conversation state."
        );
        assert.equal(
            env.DB.outbound.get("late-old-event").message_text.includes(
                "received that message out of order"
            ),
            true
        );

        const resetRequests = await Promise.all([
            signedRequest(
                senderIds[2],
                "reset-a",
                "RESET",
                secret,
                baseTimestamp + 300
            ),
            signedRequest(
                senderIds[2],
                "reset-b",
                "RESET",
                secret,
                baseTimestamp + 301
            )
        ]);
        const resetResponses = await Promise.all(
            resetRequests.map(request => worker.fetch(request, env))
        );

        assert.ok(resetResponses.every(response => response.status === 200));
        assert.equal(
            env.DB.conversations.get(senderIds[2]).state,
            "WAITING_FOR_PRINCIPAL"
        );

        const senderForFencing = senderIds[6];
        const fencingStart = await worker.fetch(
            await signedRequest(
                senderForFencing,
                "fencing-start",
                "HI",
                secret,
                baseTimestamp + 700
            ),
            env
        );
        assert.equal(fencingStart.status, 200);

        let notifyPausedBatch;
        let releasePausedBatch;
        const pausedBatchReached = new Promise(resolve => {
            notifyPausedBatch = resolve;
        });
        const pausedBatchGate = new Promise(resolve => {
            releasePausedBatch = resolve;
        });
        env.DB.pauseNextOutboundBatch = {
            onReached: notifyPausedBatch,
            continue: pausedBatchGate
        };

        const sentBeforeTakeover = sentMessages.length;
        const staleWorkerRequest = await signedRequest(
            senderForFencing,
            "fencing-stale-amount",
            "500000",
            secret,
            baseTimestamp + 701
        );
        const staleWorkerPromise = worker.fetch(staleWorkerRequest, env);
        await pausedBatchReached;

        const senderLock = env.DB.senderProcessing.get(senderForFencing);
        assert.ok(senderLock?.lock_token);
        senderLock.locked_until = 0;

        const takeoverResponse = await worker.fetch(
            await signedRequest(
                senderForFencing,
                "fencing-reset",
                "RESET",
                secret,
                baseTimestamp + 702
            ),
            env
        );
        assert.equal(takeoverResponse.status, 200);

        releasePausedBatch();
        assert.equal((await staleWorkerPromise).status, 200);
        assert.equal(
            env.DB.conversations.get(senderForFencing).state,
            "WAITING_FOR_PRINCIPAL",
            "A stale lease owner must not overwrite the takeover's RESET."
        );
        assert.equal(
            env.DB.inbox.get("fencing-stale-amount").status,
            "completed"
        );
        assert.equal(env.DB.inbox.get("fencing-reset").status, "completed");
        assert.equal(
            sentMessages.length,
            sentBeforeTakeover + 2,
            "The stale owner must not send a reply after losing its lease."
        );

        const senderForStaleSend = senderIds[9];
        await worker.fetch(
            await signedRequest(
                senderForStaleSend,
                "stale-send-start",
                "HI",
                secret,
                baseTimestamp + 705
            ),
            env
        );

        let notifyPausedSend;
        let releasePausedSend;
        const pausedSendReached = new Promise(resolve => {
            notifyPausedSend = resolve;
        });
        const pausedSendGate = new Promise(resolve => {
            releasePausedSend = resolve;
        });
        pauseNextSend = {
            senderId: senderForStaleSend,
            onReached: notifyPausedSend,
            continue: pausedSendGate
        };
        const sentBeforeStaleSend = sentMessages.length;
        const staleSendPromise = worker.fetch(
            await signedRequest(
                senderForStaleSend,
                "stale-send-message",
                "500000",
                secret,
                baseTimestamp + 706
            ),
            env
        );
        await pausedSendReached;

        env.DB.senderProcessing.get(senderForStaleSend).locked_until = 0;
        queuedSendResponses.push({
            status: 503,
            body: "takeover send failure"
        });
        let takeoverRetryTask;
        await worker.scheduled({}, env, {
            waitUntil(promise) {
                takeoverRetryTask = promise;
            }
        });
        await takeoverRetryTask;
        assert.equal(
            env.DB.inbox.get("stale-send-message").status,
            "reply_pending"
        );
        assert.equal(
            env.DB.outbound.get("stale-send-message").attempt_count,
            1
        );

        releasePausedSend();
        assert.equal((await staleSendPromise).status, 200);
        assert.equal(
            env.DB.inbox.get("stale-send-message").status,
            "reply_pending",
            "A stale send completion must not mark the message completed."
        );
        assert.equal(
            env.DB.outbound.get("stale-send-message").status,
            "pending"
        );
        assert.equal(
            sentMessages.length,
            sentBeforeStaleSend + 1,
            "The paused request may have reached Meta despite losing its lease."
        );

        env.DB.outbound.get("stale-send-message").next_attempt_at = 0;
        let staleSendRecoveryTask;
        await worker.scheduled({}, env, {
            waitUntil(promise) {
                staleSendRecoveryTask = promise;
            }
        });
        await staleSendRecoveryTask;
        assert.equal(
            env.DB.inbox.get("stale-send-message").status,
            "completed"
        );
        assert.equal(
            sentMessages.length,
            sentBeforeStaleSend + 2,
            "Recovery retains at-least-once delivery after a lost lease."
        );

        const senderForPermanentFailure = senderIds[7];
        queuedSendResponses.push({
            status: 400,
            body: JSON.stringify({
                error: {
                    message: "Invalid recipient",
                    code: 100,
                    is_transient: false
                }
            })
        });
        const permanentFailureResponse = await worker.fetch(
            await signedRequest(
                senderForPermanentFailure,
                "permanent-send-failure",
                "HI",
                secret,
                baseTimestamp + 710
            ),
            env
        );
        assert.equal(permanentFailureResponse.status, 200);
        assert.equal(
            env.DB.inbox.get("permanent-send-failure").status,
            "failed"
        );
        assert.equal(
            env.DB.outbound.get("permanent-send-failure").status,
            "failed"
        );
        assert.match(
            env.DB.outbound.get("permanent-send-failure").last_error,
            /400/
        );

        const resetAfterPermanentFailure = await worker.fetch(
            await signedRequest(
                senderForPermanentFailure,
                "reset-after-permanent-failure",
                "RESET",
                secret,
                baseTimestamp + 711
            ),
            env
        );
        assert.equal(resetAfterPermanentFailure.status, 200);
        assert.equal(
            env.DB.inbox.get("reset-after-permanent-failure").status,
            "completed",
            "A permanent send error must not block later messages."
        );
        assert.equal(
            env.DB.conversations.get(senderForPermanentFailure).state,
            "WAITING_FOR_PRINCIPAL"
        );

        const senderForRetryExhaustion = senderIds[8];
        await worker.fetch(
            await signedRequest(
                senderForRetryExhaustion,
                "retry-exhaustion-start",
                "HI",
                secret,
                baseTimestamp + 720
            ),
            env
        );
        queuedSendResponses.push({
            status: 503,
            body: "temporary send failure"
        });
        await worker.fetch(
            await signedRequest(
                senderForRetryExhaustion,
                "retry-exhaustion-message",
                "500000",
                secret,
                baseTimestamp + 721
            ),
            env
        );
        env.DB.outbound.get("retry-exhaustion-message").attempt_count = 7;
        env.DB.outbound.get("retry-exhaustion-message").next_attempt_at = 0;
        queuedSendResponses.push({
            status: 503,
            body: "temporary send failure"
        });

        let exhaustedRetryTask;
        await worker.scheduled({}, env, {
            waitUntil(promise) {
                exhaustedRetryTask = promise;
            }
        });
        await exhaustedRetryTask;
        assert.equal(
            env.DB.inbox.get("retry-exhaustion-message").status,
            "failed",
            "Transient failures must reach a terminal state at the retry limit."
        );

        const resetAfterExhaustion = await worker.fetch(
            await signedRequest(
                senderForRetryExhaustion,
                "reset-after-retry-exhaustion",
                "RESET",
                secret,
                baseTimestamp + 722
            ),
            env
        );
        assert.equal(resetAfterExhaustion.status, 200);
        assert.equal(
            env.DB.inbox.get("reset-after-retry-exhaustion").status,
            "completed",
            "Exhausted retries must not block later messages."
        );

        const senderForPersistenceFailure = senderIds[4];
        env.DB.failNextBatch = true;
        const persistenceFailureResponse = await worker.fetch(
            await signedRequest(
                senderForPersistenceFailure,
                "persistence-failure",
                "HI",
                secret,
                baseTimestamp + 350
            ),
            env
        );
        assert.equal(persistenceFailureResponse.status, 503);
        assert.equal(env.DB.inbox.has("persistence-failure"), false);

        const persistenceRetryResponse = await worker.fetch(
            await signedRequest(
                senderForPersistenceFailure,
                "persistence-failure",
                "HI",
                secret,
                baseTimestamp + 350
            ),
            env
        );
        assert.equal(persistenceRetryResponse.status, 200);
        assert.equal(
            env.DB.inbox.get("persistence-failure").status,
            "completed"
        );

        const senderForRetry = senderIds[3];
        failedSendsRemaining = 1;
        const failedSendResponse = await worker.fetch(
            await signedRequest(
                senderForRetry,
                "temporary-send-failure",
                "500000",
                secret,
                baseTimestamp + 400
            ),
            env
        );

        assert.equal(failedSendResponse.status, 200);
        assert.equal(
            env.DB.conversations.get(senderForRetry).state,
            "WAITING_FOR_RATE",
            "Conversation state and pending reply should commit together."
        );
        assert.equal(
            env.DB.inbox.get("temporary-send-failure").status,
            "reply_pending"
        );
        assert.equal(
            env.DB.outbound.get("temporary-send-failure").status,
            "pending"
        );

        const duplicateFailedResponse = await worker.fetch(
            await signedRequest(
                senderForRetry,
                "temporary-send-failure",
                "500000",
                secret,
                baseTimestamp + 400
            ),
            env
        );

        assert.equal(duplicateFailedResponse.status, 200);
        assert.equal(
            env.DB.conversations.get(senderForRetry).state,
            "WAITING_FOR_RATE",
            "Retrying a pending reply must not apply the input a second time."
        );

        env.DB.outbound.get("temporary-send-failure").next_attempt_at = 0;
        let scheduledTask;
        await worker.scheduled({}, env, {
            waitUntil(promise) {
                scheduledTask = promise;
            }
        });
        await scheduledTask;

        assert.equal(
            env.DB.outbound.get("temporary-send-failure").status,
            "sent"
        );
        assert.equal(
            env.DB.inbox.get("temporary-send-failure").status,
            "completed"
        );
        assert.equal(
            env.DB.conversations.get(senderForRetry).state,
            "WAITING_FOR_RATE"
        );

        const senderForFinalResult = senderIds[5];
        for (const [index, text] of ["HI", "500000", "9.5"].entries()) {
            const response = await worker.fetch(
                await signedRequest(
                    senderForFinalResult,
                    `final-flow-${index}`,
                    text,
                    secret,
                    baseTimestamp + 600 + index
                ),
                env
            );
            assert.equal(response.status, 200);
        }

        failedSendsRemaining = 1;
        const finalMessageRequest = await signedRequest(
            senderForFinalResult,
            "final-tenure",
            "60",
            secret,
            baseTimestamp + 603
        );
        const failedFinalResponse = await worker.fetch(finalMessageRequest, env);
        assert.equal(failedFinalResponse.status, 200);
        assert.equal(
            env.DB.conversations.has(senderForFinalResult),
            false,
            "The completed calculation should clear the conversation."
        );
        assert.equal(
            env.DB.outbound.get("final-tenure").message_text.includes("Monthly EMI"),
            true
        );
        assert.equal(
            env.DB.inbox.get("final-tenure").status,
            "reply_pending"
        );

        const finalDuplicateResponse = await worker.fetch(
            await signedRequest(
                senderForFinalResult,
                "final-tenure",
                "60",
                secret,
                baseTimestamp + 603
            ),
            env
        );
        assert.equal(finalDuplicateResponse.status, 200);
        assert.equal(
            env.DB.conversations.has(senderForFinalResult),
            false,
            "Retrying a pending result must not recreate or advance the conversation."
        );

        env.DB.outbound.get("final-tenure").next_attempt_at = 0;
        let finalRetryTask;
        await worker.scheduled({}, env, {
            waitUntil(promise) {
                finalRetryTask = promise;
            }
        });
        await finalRetryTask;
        assert.equal(env.DB.outbound.get("final-tenure").status, "sent");
        assert.equal(env.DB.inbox.get("final-tenure").status, "completed");
        assert.equal(env.DB.conversations.has(senderForFinalResult), false);

        const sentBeforeUnauthorized = sentMessages.length;
        const unauthorizedResponse = await worker.fetch(
            await signedRequest(
                "not-allowed",
                "unauthorized-event",
                "HI",
                secret,
                baseTimestamp + 500
            ),
            env
        );

        assert.equal(unauthorizedResponse.status, 200);
        assert.equal(sentMessages.length, sentBeforeUnauthorized);
        assert.equal(env.DB.conversations.has("not-allowed"), false);
        assert.equal(env.DB.inbox.has("unauthorized-event"), false);
    } finally {
        globalThis.fetch = originalFetch;
    }

    console.log(
        "Worker reliability simulation passed (16 senders, duplicate delivery, " +
        "same-sender ordering, lease fencing, bounded send retries, and access control)."
    );
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
