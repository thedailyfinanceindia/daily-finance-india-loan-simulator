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

export async function verifyMetaSignature(
    rawBody,
    signatureHeader,
    appSecret
) {
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

export function extractInstagramMessages(payload) {
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
            const text = value.message?.text || value.text;

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

export function getEventTimestamp(value, fallback) {
    const timestamp = Number(value);
    return Number.isSafeInteger(timestamp) && timestamp > 0
        ? timestamp
        : fallback;
}

export async function hashRawBody(rawBody) {
    const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", rawBody)
    );

    return Array.from(digest, byte => byte.toString(16).padStart(2, "0"))
        .join("");
}
