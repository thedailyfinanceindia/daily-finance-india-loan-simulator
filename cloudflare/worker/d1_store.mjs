import { getEventTimestamp, hashRawBody } from "./webhook_protocol.mjs";

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const MESSAGE_RETENTION_SECONDS = 24 * 60 * 60;
const COMPLETED_MESSAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SENDER_LOCK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SENDER_LOCK_MS = 2 * 60 * 1000;
const SQLITE_NOW_MS =
    "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
const ACTIVE_SENDER_LOCK_SQL = `
    EXISTS (
        SELECT 1 FROM sender_processing
        WHERE sender_id = ? AND lock_token = ?
            AND locked_until > ${SQLITE_NOW_MS}
    )
`;

export async function getConversation(env, senderId) {
    const row = await env.DB.prepare(`
        SELECT
            sender_id,
            state,
            principal,
            annual_rate,
            tenure_months,
            state_data,
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
            stateData: row.state_data,
            updatedAt: row.updated_at
        },
        expired: false
    };
}

export async function persistWebhookMessages(
    env,
    messages,
    rawBody,
    receivedAt
) {
    const bodyHash = await hashRawBody(rawBody);
    const statements = messages.map((message, index) => {
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

    return Array.from(new Set(messages.map(message => message.senderId)));
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
                state_data,
                updated_at
            )
            SELECT ?, ?, ?, ?, ?, ?, ${SQLITE_NOW_MS}
            WHERE ${ACTIVE_SENDER_LOCK_SQL}
            ON CONFLICT(sender_id) DO UPDATE SET
                state = excluded.state,
                principal = excluded.principal,
                annual_rate = excluded.annual_rate,
                tenure_months = excluded.tenure_months,
                state_data = excluded.state_data,
                updated_at = excluded.updated_at
        `).bind(
            senderId,
            conversation.state,
            conversation.principal,
            conversation.rate,
            conversation.tenureMonths,
            conversation.stateData || null,
            senderId,
            lockToken
        )];
    }

    return [];
}

export async function prepareOutboundReply(
    env,
    inboxMessage,
    outcome,
    lockToken
) {
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

export async function acquireSenderLock(env, senderId, lockToken) {
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

export async function renewSenderLock(env, senderId, lockToken) {
    const result = await activeSenderLockStatement(
        env,
        senderId,
        lockToken
    ).run();

    return result.meta?.changes === 1;
}

export async function releaseSenderLock(env, senderId, lockToken) {
    return env.DB.prepare(`
        UPDATE sender_processing
        SET lock_token = NULL, locked_until = 0, last_activity_at = ?
        WHERE sender_id = ? AND lock_token = ?
    `).bind(Date.now(), senderId, lockToken).run();
}

export async function getNextSenderMessage(env, senderId) {
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

export async function markReplySent(env, inboxMessage, lockToken) {
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

export async function recordSendFailure(
    env,
    inboxMessage,
    error,
    lockToken,
    permanent,
    maxAttempts
) {
    const attemptCount = inboxMessage.attempt_count + 1;
    const terminal = permanent || attemptCount >= maxAttempts;
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

export async function cleanupExpiredData(env, now) {
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
}

export async function getRetryableSenderIds(env, now, limit) {
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
    `).bind(now, limit).all();

    return results.map(row => row.sender_id);
}
