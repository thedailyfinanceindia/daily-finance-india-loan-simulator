import { buildMessageOutcome } from "./conversation.mjs";
import {
    acquireSenderLock,
    cleanupExpiredData,
    getConversation,
    getNextSenderMessage,
    getRetryableSenderIds,
    markReplySent,
    prepareOutboundReply,
    recordSendFailure,
    releaseSenderLock,
    renewSenderLock
} from "./d1_store.mjs";
import {
    InstagramSendError,
    sendInstagramText
} from "./instagram_client.mjs";

const MAX_OUTBOUND_ATTEMPTS = 8;
const MAX_MESSAGES_PER_DRAIN = 10;
const MAX_SENDERS_PER_SCHEDULED_RUN = 25;
const REORDER_BUFFER_MS = 250;

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
        outcome = buildMessageOutcome(
            inboxMessage.message_text,
            stored.conversation
        );

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
                    lockToken,
                    error instanceof InstagramSendError && error.permanent,
                    MAX_OUTBOUND_ATTEMPTS
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
        await releaseSenderLock(env, senderId, lockToken);
    }
}

export async function drainSenderSafely(
    env,
    senderId,
    settleConcurrentMessages,
    maxMessages = MAX_MESSAGES_PER_DRAIN
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

export async function retryPendingMessages(env) {
    const now = Date.now();
    await cleanupExpiredData(env, now);
    const senderIds = await getRetryableSenderIds(
        env,
        now,
        MAX_SENDERS_PER_SCHEDULED_RUN
    );

    await Promise.all(senderIds.map(senderId =>
        drainSenderSafely(env, senderId, false)
    ));
}
