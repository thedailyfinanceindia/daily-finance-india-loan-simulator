CREATE TABLE webhook_inbox_new (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL UNIQUE,
    sender_id TEXT NOT NULL,
    message_text TEXT NOT NULL,
    event_timestamp INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'reply_pending', 'completed', 'failed')),
    last_error TEXT,
    completed_at INTEGER,
    failed_at INTEGER
);

INSERT INTO webhook_inbox_new (
    sequence,
    message_id,
    sender_id,
    message_text,
    event_timestamp,
    received_at,
    status,
    last_error,
    completed_at
)
SELECT
    sequence,
    message_id,
    sender_id,
    message_text,
    event_timestamp,
    received_at,
    status,
    last_error,
    completed_at
FROM webhook_inbox;

CREATE TABLE outbound_messages_new (
    inbound_message_id TEXT PRIMARY KEY
        REFERENCES webhook_inbox_new(message_id) ON DELETE CASCADE,
    recipient_id TEXT NOT NULL,
    message_text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sent', 'failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    sent_at INTEGER,
    failed_at INTEGER
);

INSERT INTO outbound_messages_new (
    inbound_message_id,
    recipient_id,
    message_text,
    status,
    attempt_count,
    next_attempt_at,
    last_error,
    created_at,
    sent_at
)
SELECT
    inbound_message_id,
    recipient_id,
    message_text,
    status,
    attempt_count,
    next_attempt_at,
    last_error,
    created_at,
    sent_at
FROM outbound_messages;

DROP TABLE outbound_messages;
DROP TABLE webhook_inbox;

ALTER TABLE webhook_inbox_new RENAME TO webhook_inbox;
ALTER TABLE outbound_messages_new RENAME TO outbound_messages;

CREATE INDEX idx_webhook_inbox_sender_queue
ON webhook_inbox(sender_id, status, event_timestamp, sequence);

CREATE INDEX idx_outbound_messages_retry
ON outbound_messages(status, next_attempt_at);
