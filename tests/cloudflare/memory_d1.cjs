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
                    stateData,
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
                    state_data: stateData,
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


module.exports = { MemoryD1 };
