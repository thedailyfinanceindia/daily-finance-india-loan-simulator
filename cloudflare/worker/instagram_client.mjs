const GRAPH_API_VERSION = "v27.0";
export const INSTAGRAM_ACCOUNT_ID = "17841427456411892";
const SEND_TIMEOUT_MS = 10 * 1000;

export class InstagramSendError extends Error {
    constructor(message, status, permanent) {
        super(message);
        this.name = "InstagramSendError";
        this.status = status;
        this.permanent = permanent;
    }
}

export async function sendInstagramText(env, recipientId, text) {
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
