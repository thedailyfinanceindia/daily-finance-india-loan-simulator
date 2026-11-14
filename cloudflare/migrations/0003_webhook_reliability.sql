CREATE TABLE IF NOT EXISTS conversations (
    sender_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    principal REAL,
    annual_rate REAL,
    tenure_months INTEGER,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_inbox (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL UNIQUE,
    sender_id TEXT NOT NULL,
    message_text TEXT NOT NULL,
    event_timestamp INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'reply_pending', 'completed')),
    last_error TEXT,
    completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_webhook_inbox_sender_queue
ON webhook_inbox(sender_id, status, event_timestamp, sequence);

CREATE TABLE IF NOT EXISTS outbound_messages (
    inbound_message_id TEXT PRIMARY KEY
        REFERENCES webhook_inbox(message_id) ON DELETE CASCADE,
    recipient_id TEXT NOT NULL,
    message_text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sent')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    sent_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_outbound_messages_retry
ON outbound_messages(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS sender_processing (
    sender_id TEXT PRIMARY KEY,
    lock_token TEXT,
    locked_until INTEGER NOT NULL DEFAULT 0,
    last_event_timestamp INTEGER NOT NULL DEFAULT 0,
    last_activity_at INTEGER NOT NULL DEFAULT 0
);
