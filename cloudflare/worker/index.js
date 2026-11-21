import { persistWebhookMessages } from "./d1_store.mjs";
import {
    drainSenderSafely,
    retryPendingMessages
} from "./message_processor.mjs";
import {
    extractInstagramMessages,
    verifyMetaSignature
} from "./webhook_protocol.mjs";
import { INSTAGRAM_ACCOUNT_ID } from "./instagram_client.mjs";

const MAX_MESSAGES_PER_WEBHOOK_DRAIN = 2;

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

    const allowedSenderIds = new Set(
        (env.ALLOWED_INSTAGRAM_SENDER_IDS || "")
            .split(",")
            .map(id => id.trim())
            .filter(Boolean)
    );

    return allowedSenderIds.size > 0 && allowedSenderIds.has(senderId);
}

function verifyWebhookSubscription(url, env) {
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

async function handleWebhook(request, env, ctx) {
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

    const acceptedMessages = [];
    for (const message of extractInstagramMessages(payload)) {
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

    let senderIds;
    try {
        senderIds = await persistWebhookMessages(
            env,
            acceptedMessages,
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
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (request.method === "GET") {
            return verifyWebhookSubscription(url, env);
        }

        if (request.method !== "POST") {
            return new Response("Method Not Allowed", { status: 405 });
        }

        return handleWebhook(request, env, ctx);
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
