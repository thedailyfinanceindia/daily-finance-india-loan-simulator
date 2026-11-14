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
        this.processedMessages = new Map();
    }

    prepare(sql) {
        const statement = sql.replace(/\s+/g, " ").trim().toLowerCase();

        return {
            bind: (...values) => ({
                first: async () => {
                    await Promise.resolve();

                    if (statement.includes("from conversations")) {
                        const row = this.conversations.get(values[0]);
                        return row ? { ...row } : null;
                    }

                    throw new Error(`Unsupported D1 query: ${statement}`);
                },
                run: async () => {
                    await Promise.resolve();

                    if (statement.startsWith("insert into conversations")) {
                        this.conversations.set(values[0], {
                            sender_id: values[0],
                            state: values[1],
                            principal: values[2],
                            annual_rate: values[3],
                            tenure_months: values[4],
                            updated_at: values[5]
                        });

                        return { meta: { changes: 1 } };
                    }

                    if (statement.startsWith("delete from conversations")) {
                        const changes = this.conversations.delete(values[0]) ? 1 : 0;
                        return { meta: { changes } };
                    }

                    if (
                        statement.startsWith("delete from processed_messages") &&
                        statement.includes("processed_at <")
                    ) {
                        let changes = 0;

                        for (const [messageId, processedAt] of this.processedMessages) {
                            if (processedAt < values[0]) {
                                this.processedMessages.delete(messageId);
                                changes++;
                            }
                        }

                        return { meta: { changes } };
                    }

                    if (statement.startsWith("insert or ignore into processed_messages")) {
                        if (this.processedMessages.has(values[0])) {
                            return { meta: { changes: 0 } };
                        }

                        this.processedMessages.set(values[0], values[1]);
                        return { meta: { changes: 1 } };
                    }

                    if (statement.startsWith("delete from processed_messages")) {
                        const changes = this.processedMessages.delete(values[0]) ? 1 : 0;
                        return { meta: { changes } };
                    }

                    throw new Error(`Unsupported D1 statement: ${statement}`);
                }
            })
        };
    }
}

async function signedRequest(senderId, messageId, text, secret) {
    const body = JSON.stringify({
        object: "instagram",
        entry: [{
            messaging: [{
                sender: { id: senderId },
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
    const env = {
        ALLOWED_INSTAGRAM_SENDER_IDS: senderIds.join(","),
        BOT_ACCESS_MODE: "TESTERS",
        META_ACCESS_TOKEN: "local-test-token",
        META_APP_SECRET: secret,
        DB: new MemoryD1()
    };
    const sentMessages = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url, options) => {
        sentMessages.push({
            url: String(url),
            ...JSON.parse(options.body)
        });
        return new Response(null, { status: 200 });
    };

    try {
        const startResponses = await Promise.all(senderIds.map((senderId, index) =>
            signedRequest(senderId, `start-${index}`, "HI", secret)
                .then(request => worker.fetch(request, env))
        ));

        assert.ok(startResponses.every(response => response.status === 200));
        assert.equal(sentMessages.length, senderIds.length);
        assert.equal(env.DB.conversations.size, senderIds.length);

        for (const senderId of senderIds) {
            const conversation = env.DB.conversations.get(senderId);
            assert.equal(conversation.state, "WAITING_FOR_PRINCIPAL");
            const reply = sentMessages.find(
                message => message.recipient.id === senderId
            );
            assert.ok(reply, `Expected a reply for ${senderId}.`);
            assert.equal(
                reply.recipient.id,
                senderId,
                "Each reply should go to its own sender."
            );
        }

        const principalResponses = await Promise.all(senderIds.map((senderId, index) =>
            signedRequest(senderId, `principal-${index}`, String(500000 + index), secret)
                .then(request => worker.fetch(request, env))
        ));

        assert.ok(principalResponses.every(response => response.status === 200));

        for (const [index, senderId] of senderIds.entries()) {
            const conversation = env.DB.conversations.get(senderId);
            assert.equal(conversation.state, "WAITING_FOR_RATE");
            assert.equal(conversation.principal, 500000 + index);
        }

        const sentBeforeRetry = sentMessages.length;
        const duplicateRequests = await Promise.all([0, 1].map(() =>
            signedRequest(senderIds[0], "duplicate-rate-event", "8.5", secret)
        ));
        const duplicateResponses = await Promise.all(
            duplicateRequests.map(request => worker.fetch(request, env))
        );

        assert.ok(duplicateResponses.every(response => response.status === 200));
        assert.equal(
            sentMessages.length,
            sentBeforeRetry + 1,
            "A concurrently retried webhook event should be processed once."
        );
        assert.equal(
            env.DB.conversations.get(senderIds[0]).state,
            "WAITING_FOR_TENURE"
        );

        const sameSenderResetRequests = await Promise.all([
            signedRequest(senderIds[1], "reset-a", "RESET", secret),
            signedRequest(senderIds[1], "reset-b", "RESET", secret)
        ]);
        const sameSenderResetResponses = await Promise.all(
            sameSenderResetRequests.map(request => worker.fetch(request, env))
        );
        assert.ok(
            sameSenderResetResponses.every(response => response.status === 200)
        );
        assert.equal(
            env.DB.conversations.get(senderIds[1]).state,
            "WAITING_FOR_PRINCIPAL",
            "Concurrent resets for one sender should leave a valid fresh session."
        );

        const sentBeforeUnauthorized = sentMessages.length;
        const unauthorizedResponse = await worker.fetch(
            await signedRequest("not-allowed", "unauthorized-event", "HI", secret),
            env
        );

        assert.equal(unauthorizedResponse.status, 200);
        assert.equal(sentMessages.length, sentBeforeUnauthorized);
        assert.equal(env.DB.conversations.has("not-allowed"), false);
    } finally {
        globalThis.fetch = originalFetch;
    }

    console.log(
        "Worker concurrency simulation passed (16 senders, duplicate retry, " +
        "same-sender resets, access control)."
    );
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
