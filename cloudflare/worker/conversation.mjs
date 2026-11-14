import {
    parsePrincipal,
    parseRate,
    parseTenure
} from "./input_parser.mjs";
import { calculateLoan } from "./loan_engine.mjs";

const STATE = {
    PRINCIPAL: "WAITING_FOR_PRINCIPAL",
    RATE: "WAITING_FOR_RATE",
    TENURE: "WAITING_FOR_TENURE"
};

function formatINR(value) {
    return new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 0
    }).format(value);
}

function formatTenure(months) {
    const years = Math.floor(months / 12);
    const remainingMonths = months % 12;

    if (years === 0) return `${months} months`;

    if (remainingMonths === 0) {
        return `${years} ${years === 1 ? "year" : "years"}`;
    }

    return (
        `${years} ${years === 1 ? "year" : "years"} and ` +
        `${remainingMonths} ${remainingMonths === 1 ? "month" : "months"}`
    );
}

function formatResult(result, principal, rate, months) {
    return (
        "Your loan calculation is ready!\n\n" +
        "Loan Amount: " + formatINR(principal) + "\n" +
        "Interest Rate: " + rate + "% p.a.\n" +
        "Loan Tenure: " + formatTenure(months) + "\n\n" +
        "Monthly EMI: " + formatINR(result.monthlyEmi) + "\n" +
        "Total Interest: " + formatINR(result.totalInterest) + "\n" +
        "Total Repayment: " + formatINR(result.totalRepayment) +
        "\n\n" +
        "This is an estimate based on a standard reducing-balance " +
        "EMI calculation. Actual lender charges may differ.\n\n" +
        "Send HI to calculate another loan.\n" +
        "Send RESET to restart or HELP for instructions."
    );
}

function startConversationReply() {
    return (
        "Welcome to Daily Finance India EMI Calculator!\n\n" +
        "Let's calculate your loan EMI.\n\n" +
        "Step 1 of 3: Enter your loan amount in rupees.\n\n" +
        "Examples:\n" +
        "500000 = ₹5 lakh\n" +
        "50000 = ₹50 thousand\n" +
        "5 lakh\n" +
        "50 lakh\n" +
        "5 crore\n\n" +
        "You can enter the amount in rupees or use lakh/crore.\n" +
        "Please don't use commas."
    );
}

export function buildMessageOutcome(text, conversation) {
    const message = text.trim();
    const command = message.toUpperCase();

    if (command === "CANCEL") {
        return {
            deleteConversation: true,
            reply: "Your EMI calculation has been cancelled. " +
                "Send HI whenever you want to start again."
        };
    }

    if (["RESET", "HI", "EMI", "LOAN"].includes(command)) {
        return {
            nextConversation: {
                state: STATE.PRINCIPAL,
                principal: null,
                rate: null,
                tenureMonths: null
            },
            reply: startConversationReply()
        };
    }

    if (command === "HELP") {
        return {
            reply: "EMI Calculator Help\n\n" +
            "Send HI to start.\n\n" +
            "1. Enter loan amount in rupees or lakh/crore.\n" +
            "   Example: 500000 or 5 lakh.\n\n" +
            "2. Enter annual interest rate.\n" +
            "   Example: 9.5\n\n" +
            "3. Enter tenure.\n" +
            "   Example: 5 years or 60 months.\n\n" +
            "Send RESET to restart or CANCEL to stop."
        };
    }

    if (!conversation) {
        return {
            reply: "Welcome! Send HI, EMI or LOAN to calculate your EMI."
        };
    }

    if (conversation.state === STATE.PRINCIPAL) {
        const principal = parsePrincipal(message);

        if (principal === null) {
            return {
                reply: "Invalid loan amount.\n\n" +
                "Enter an amount such as:\n" +
                "500000 = ₹5 lakh\n" +
                "50000 = ₹50 thousand\n" +
                "5 lakh\n" +
                "50 lakh\n" +
                "5 crore\n\n" +
                "Maximum supported amount: ₹100 crore.\n" +
                "Please don't use commas."
            };
        }

        return {
            nextConversation: {
                ...conversation,
                principal,
                state: STATE.RATE
            },
            reply: "Loan amount: " + formatINR(principal) +
                "\n\nStep 2 of 3: Enter the annual interest rate.\n" +
                "Example: 9.5"
        };
    }

    if (conversation.state === STATE.RATE) {
        const rate = parseRate(message);

        if (rate === null) {
            return {
                reply: "Invalid interest rate.\n\n" +
                "Enter an annual rate between 0 and 100.\n" +
                "Example: 9.5"
            };
        }

        return {
            nextConversation: {
                ...conversation,
                rate,
                state: STATE.TENURE
            },
            reply: "Interest rate: " + rate +
                "% p.a.\n\nStep 3 of 3: Enter the loan tenure.\n" +
                "Examples: 5 years or 60 months.\n" +
                "A number without a unit is treated as months."
        };
    }

    if (conversation.state === STATE.TENURE) {
        const months = parseTenure(message);

        if (months === null) {
            return {
                reply: "Invalid loan tenure.\n\n" +
                "Enter a value between 1 and 600 months.\n" +
                "Examples: 5 years or 60 months.\n" +
                "A number without a unit is treated as months."
            };
        }

        try {
            const result = calculateLoan(
                conversation.principal,
                conversation.rate,
                months
            );

            return {
                deleteConversation: true,
                reply: formatResult(
                    result,
                    conversation.principal,
                    conversation.rate,
                    months
                )
            };
        } catch (error) {
            console.error("Loan calculation error:", error);

            return {
                deleteConversation: true,
                reply: "Sorry, the calculation could not be completed. " +
                    "Please send HI to try again."
            };
        }
    }

    return {
        reply: "Sorry, I could not process that message. " +
            "Send HELP for instructions."
    };
}
