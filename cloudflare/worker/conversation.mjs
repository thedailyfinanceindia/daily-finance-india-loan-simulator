import {
    parsePrincipal,
    parseRate,
    parseTenure
} from "./input_parser.mjs";
import {
    calculateLoan,
    simulateRateRevision,
    simulatePrepayments
} from "./loan_engine.mjs";

const STATE = {
    PRINCIPAL: "WAITING_FOR_PRINCIPAL",
    RATE: "WAITING_FOR_RATE",
    TENURE: "WAITING_FOR_TENURE",
    NEW_LOAN_RESULT: "WAITING_FOR_NEW_LOAN_RESULT",
    MAIN_MENU: "WAITING_FOR_MAIN_MENU",
    EXISTING_MENU: "WAITING_FOR_EXISTING_MENU",
    EXISTING_OUTSTANDING: "WAITING_FOR_EXISTING_OUTSTANDING",
    EXISTING_RATE: "WAITING_FOR_EXISTING_RATE",
    EXISTING_EMI: "WAITING_FOR_EXISTING_EMI",
    EXISTING_TENURE: "WAITING_FOR_EXISTING_TENURE",
    EXISTING_REVISED_RATE: "WAITING_FOR_EXISTING_REVISED_RATE",
    PREPAYMENT_EVENT: "WAITING_FOR_PREPAYMENT_EVENT"
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
    return `${years} ${years === 1 ? "year" : "years"} and ` +
        `${remainingMonths} ${remainingMonths === 1 ? "month" : "months"}`;
}

function signedMonths(value) {
    if (value === null) return "Unavailable";
    return `${value > 0 ? "+" : ""}${value} months`;
}

function signedCurrency(value) {
    if (value === null) return "Unavailable";
    const sign = value > 0 ? "+" : "";
    return sign + formatINR(value);
}

function readStateData(conversation) {
    if (!conversation?.stateData) return {};
    try {
        return JSON.parse(conversation.stateData);
    } catch {
        return {};
    }
}

function withStateData(conversation, additions) {
    return {
        ...conversation,
        stateData: JSON.stringify({
            ...readStateData(conversation),
            ...additions
        })
    };
}

function mainMenuReply() {
    return (
        "Welcome to Daily Finance India!\n\n" +
        "I can help you understand your loan EMI, outstanding balance, interest costs and prepayment benefits.\n\n" +
        "What would you like to do?\n\n" +
        "1. Calculate a New Loan EMI\n" +
        "Find the EMI, total interest and total repayment for a new loan.\n\n" +
        "2. Analyse an Existing Loan\n" +
        "Check your current loan position, understand interest-rate changes or calculate prepayment benefits.\n\n" +
        "Reply with 1 or 2.\n\n" +
        "Send HELP for instructions."
    );
}

function existingMenuReply() {
    return (
        "Existing Loan Analysis\n\n" +
        "What would you like to know about your current loan?\n\n" +
        "1. Current Loan Position\n" +
        "Find out how much you still owe and how much future interest you may pay.\n\n" +
        "2. Interest-Rate Revision\n" +
        "Understand what happens if your bank increases or decreases your interest rate.\n\n" +
        "3. Prepayment Planning\n" +
        "Find out how much interest you could save by making additional payments.\n\n" +
        "Reply with 1, 2 or 3."
    );
}

function startNewLoanReply() {
    return (
        "How much loan do you need?\n\n" +
        "Enter the amount in rupees, lakh or crore.\n\n" +
        "Examples:\n" +
        "500000\n" +
        "5 lakh\n" +
        "50 lakh"
    );
}

function formatNewLoanResult(result, principal, rate, months) {
    return (
        `Loan Amount: ${formatINR(principal)}\n` +
        `Interest Rate: ${rate}% p.a.\n` +
        `Loan Tenure: ${formatTenure(months)}\n\n` +
        `Monthly EMI: ${formatINR(result.monthlyEmi)}\n` +
        `Total Interest: ${formatINR(result.totalInterest)}\n` +
        `Total Repayment: ${formatINR(result.totalRepayment)}\n\n` +
        "1. Calculate another new loan.\n" +
        "2. Analyse an existing loan.\n" +
        "3. Main menu."
    );
}

function formatNewLoanResultOptions() {
    return (
        "1. Calculate another new loan.\n" +
        "2. Analyse an existing loan.\n" +
        "3. Main menu."
    );
}

function estimateDisclaimer() {
    return (
        "This projection starts from today's outstanding principal and uses " +
        "monthly interest at annual rate divided by 12. It does not include " +
        "historical interest already paid. Lender-specific rounding, fees, " +
        "payment timing and contractual terms may differ. Verify with your lender."
    );
}

function formatCurrentPosition(simulation, outstanding, rate, emi, months) {
    const baseline = simulation.baseline;
    let warning = "";
    const projectedMonths = baseline.installments;
    const difference = Math.abs(projectedMonths - months);
    if (difference > 1) {
        warning =
            `\n\nYour current EMI is projected to close the loan in ` +
            `${projectedMonths} months, compared with the stated remaining tenure ` +
            `of ${months} months.`;
    }
    return (
        "Current Loan Position\n\n" +
        `Outstanding Balance: ${formatINR(outstanding)}\n` +
        `Current Interest Rate: ${rate}% p.a.\n` +
        `Current Monthly EMI: ${formatINR(emi)}\n\n` +
        `Contractual Remaining Tenure: ${formatTenure(months)}\n` +
        `Calculated Payoff Tenure: ${formatTenure(projectedMonths)}\n` +
        `Projected Future Interest: ${formatINR(baseline.totalInterest)}\n` +
        `Projected Future Repayment: ${formatINR(baseline.totalRepayment)}` +
        warning +
        "\n\n" +
        estimateDisclaimer()
    );
}

function formatRateRevision(simulation, currentRate, revisedRate, emi) {
    return (
        "Interest-Rate Revision\n\n" +
        `Original Rate: ${currentRate}% p.a.\n` +
        `Revised Rate: ${revisedRate}% p.a.\n` +
        `Existing EMI: ${formatINR(emi)}\n\n` +
        "Scenario A - Keep EMI unchanged\n" +
        `Revised EMI: ${formatINR(simulation.keepEmi.emi)}\n` +
        `Revised Tenure: ${formatTenure(simulation.keepEmi.installments)}\n` +
        `Future Interest: ${formatINR(simulation.keepEmi.totalInterest)}\n` +
        `Future Repayment: ${formatINR(simulation.keepEmi.totalRepayment)}\n` +
        `Change in Tenure: ${signedMonths(simulation.keepEmiTermChangeMonths)}\n\n` +
        "Scenario B - Keep remaining tenure unchanged\n" +
        `Revised EMI: ${formatINR(simulation.keepTenure.emi)}\n` +
        `Future Interest: ${formatINR(simulation.keepTenure.totalInterest)}\n` +
        `Future Repayment: ${formatINR(simulation.keepTenure.totalRepayment)}\n` +
        `Interest Difference: ${signedCurrency(simulation.keepTenureInterestChange)}\n\n` +
        estimateDisclaimer() +
        "\n\nSend 1, 2 or 3 for another existing-loan option.\n" +
        "Send MENU for the main menu."
    );
}

function formatPrepayments(simulation) {
    const tenureSavings = simulation.reduceTenureInstallmentsSaved;
    const reduceEmiSavings = simulation.reduceEmiInterestSaved;
    return (
        "Multiple Prepayment Comparison\n\n" +
        "Strategy A - Reduce tenure\n" +
        `EMI Kept: ${formatINR(simulation.reduceTenure.emi)}\n` +
        `Projected Tenure: ${formatTenure(simulation.reduceTenure.installments)}\n` +
        `Future Interest: ${formatINR(simulation.reduceTenure.totalInterest)}\n` +
        `Tenure Saved: ${tenureSavings === null ? "Unavailable" : signedMonths(tenureSavings)}\n` +
        `Interest Saved: ${signedCurrency(simulation.reduceTenureInterestSaved)}\n\n` +
        "Strategy B - Reduce EMI\n" +
        `Revised EMI: ${formatINR(simulation.reduceEmi.emi)}\n` +
        `Tenure Kept: ${formatTenure(simulation.reduceEmi.installments)}\n` +
        `Future Interest: ${formatINR(simulation.reduceEmi.totalInterest)}\n` +
        `Interest Difference: ${signedCurrency(reduceEmiSavings === null ? null : -reduceEmiSavings)}\n\n` +
        estimateDisclaimer() +
        "\n\nSend 1, 2 or 3 for another existing-loan option.\n" +
        "Send MENU for the main menu."
    );
}

function parsePrepayment(message, remainingTenure) {
    let amountText;
    let monthText;
    const comma = message.match(/^(.+?)\s*,\s*(\d+)$/);
    const separated = message.match(/^(.+?)\s+(?:at\s+)?(?:month\s+)?(\d+)$/i);
    const colon = message.match(/^(.+?)\s*:\s*(\d+)$/);
    const slash = message.match(/^(.+?)\s*\/\s*(\d+)$/);
    const match = comma || colon || slash || separated;
    if (!match) return null;

    amountText = match[1];
    monthText = match[2];
    const amount = parsePrincipal(amountText.trim());
    const month = parseTenure(monthText.trim());
    if (amount === null || month === null || month < 1 || month > remainingTenure) {
        return null;
    }
    return { installmentNumber: month, amount };
}

export function buildMessageOutcome(text, conversation) {
    const message = String(text).trim();
    const command = message.toUpperCase();

    if (command === "CANCEL") {
        return {
            deleteConversation: true,
            reply: "Calculation stopped. Send HI or RESET whenever you want to start again."
        };
    }
    if (command === "RESET") {
        return {
            nextConversation: { state: STATE.MAIN_MENU },
            reply: mainMenuReply()
        };
    }
    if (command === "HELP") {
        return {
            reply:
                "DM Calculator Help\n\n" +
                "Choose 1 for New Loan EMI or 2 for Existing Loan Analysis.\n" +
                "New loan: amount, annual rate and tenure.\n" +
                "Existing loan: outstanding balance, rate, EMI and remaining tenure.\n\n" +
                "Send RESET to restart, CANCEL to stop or MENU for the main menu."
        };
    }
    if (["HI", "HELLO", "MENU", "RESET"].includes(command)) {
        return {
            nextConversation: {
                state: STATE.MAIN_MENU,
                principal: null,
                rate: null,
                tenureMonths: null,
                stateData: null
            },
            reply: mainMenuReply()
        };
    }
    if (["EMI", "LOAN"].includes(command)) {
        return {
            nextConversation: {
                state: STATE.PRINCIPAL,
                principal: null,
                rate: null,
                tenureMonths: null,
                stateData: null
            },
            reply: startNewLoanReply()
        };
    }

    if (!conversation) {
        if (command === "1") {
            return {
                nextConversation: { state: STATE.PRINCIPAL, principal: null, rate: null, tenureMonths: null, stateData: null },
                reply: startNewLoanReply()
            };
        }
        if (command === "2") {
            return {
                nextConversation: { state: STATE.EXISTING_MENU },
                reply: existingMenuReply()
            };
        }
        return {
            nextConversation: { state: STATE.MAIN_MENU },
            reply: mainMenuReply()
        };
    }

    if (conversation.state === STATE.MAIN_MENU) {
        if (command === "1") {
            return {
                nextConversation: { state: STATE.PRINCIPAL, principal: null, rate: null, tenureMonths: null, stateData: null },
                reply: startNewLoanReply()
            };
        }
        if (command === "2") {
            return {
                nextConversation: { ...conversation, state: STATE.EXISTING_MENU },
                reply: existingMenuReply()
            };
        }
        return { reply: "Please reply 1 or 2.\n\n" + mainMenuReply() };
    }

    if (conversation.state === STATE.PRINCIPAL) {
        const principal = parsePrincipal(message);
        if (principal === null) {
            return { reply: "Invalid loan amount. Enter an amount such as 500000, 5 lakh or 5 crore. Maximum: ₹100 crore." };
        }
        return {
            nextConversation: { ...conversation, principal, state: STATE.RATE },
            reply: `Loan amount: ${formatINR(principal)}\n\nStep 2 of 3: Enter the annual interest rate. Example: 9.5`
        };
    }
    if (conversation.state === STATE.RATE) {
        const rate = parseRate(message);
        if (rate === null) {
            return { reply: "Invalid interest rate. Enter 0 to 100, for example 9.5 or 9.5%." };
        }
        return {
            nextConversation: { ...conversation, rate, state: STATE.TENURE },
            reply: `Interest rate: ${rate}% p.a.\n\nStep 3 of 3: Enter the loan tenure. Example: 5 years or 60 months.`
        };
    }
    if (conversation.state === STATE.TENURE) {
        const months = parseTenure(message);
        if (months === null) {
            return { reply: "Invalid loan tenure. Enter 1 to 600 months, for example 60 months or 5 years." };
        }
        try {
            const result = calculateLoan(conversation.principal, conversation.rate, months);
            return {
                nextConversation: {
                    ...conversation,
                    tenureMonths: months,
                    state: STATE.NEW_LOAN_RESULT,
                    stateData: JSON.stringify({
                        principal: conversation.principal,
                        rate: conversation.rate,
                        tenureMonths: months
                    })
                },
                reply: formatNewLoanResult(result, conversation.principal, conversation.rate, months)
            };
        } catch (error) {
            console.error("Loan calculation error:", error);
            return { deleteConversation: true, reply: "The calculation could not be completed. Send HI or RESET to try again." };
        }
    }

    if (conversation.state === STATE.NEW_LOAN_RESULT) {
        if (command === "1") {
            return {
                nextConversation: {
                    state: STATE.PRINCIPAL,
                    principal: null,
                    rate: null,
                    tenureMonths: null,
                    stateData: null
                },
                reply: startNewLoanReply()
            };
        }
        if (command === "2") {
            return {
                nextConversation: { ...conversation, state: STATE.EXISTING_MENU, stateData: null },
                reply: existingMenuReply()
            };
        }
        if (command === "3") {
            return {
                nextConversation: {
                    state: STATE.MAIN_MENU,
                    principal: null,
                    rate: null,
                    tenureMonths: null,
                    stateData: null
                },
                reply: mainMenuReply()
            };
        }
        return { reply: "Please reply 1, 2 or 3.\n\n" + formatNewLoanResultOptions() };
    }

    if (conversation.state === STATE.EXISTING_MENU) {
        if (command === "1") {
            const data = readStateData(conversation);
            if (data.outstanding && data.currentRate !== undefined && data.emi && data.remainingTenure) {
                try {
                    const simulation = simulatePrepayments(
                        data.outstanding,
                        data.currentRate,
                        data.emi,
                        data.remainingTenure,
                        []
                    );
                    return {
                        nextConversation: { ...conversation, state: STATE.EXISTING_MENU, stateData: JSON.stringify(data) },
                        reply: formatCurrentPosition(simulation, data.outstanding, data.currentRate, data.emi, data.remainingTenure)
                    };
                } catch (error) {
                    console.error("Current-position calculation error:", error);
                    return { reply: "The projection could not be completed. Check your inputs or send RESET to restart." };
                }
            }
            return {
                nextConversation: { ...conversation, principal: null, rate: null, tenureMonths: null, state: STATE.EXISTING_OUTSTANDING, stateData: JSON.stringify({ capability: "position" }) },
                reply: "What is your current outstanding loan balance?\n\nThis is the amount you still owe the bank, NOT the original loan amount.\n\nExample: 35 lakh"
            };
        }
        if (command === "2") {
            const data = readStateData(conversation);
            if (data.outstanding && data.currentRate !== undefined && data.emi && data.remainingTenure) {
                return {
                    nextConversation: { ...conversation, state: STATE.EXISTING_REVISED_RATE, stateData: JSON.stringify({ ...data, capability: "rate" }) },
                    reply: "What is the revised annual interest rate?\n\nExample: 8.5%"
                };
            }
            return {
                nextConversation: { ...conversation, principal: null, rate: null, tenureMonths: null, state: STATE.EXISTING_OUTSTANDING, stateData: JSON.stringify({ capability: "rate" }) },
                reply: "What is your current outstanding loan balance?\n\nThis is the amount you still owe the bank, NOT the original loan amount.\n\nExample: 35 lakh"
            };
        }
        if (command === "3") {
            const data = readStateData(conversation);
            if (data.outstanding && data.currentRate !== undefined && data.emi && data.remainingTenure) {
                return {
                    nextConversation: { ...conversation, state: STATE.PREPAYMENT_EVENT, stateData: JSON.stringify({ ...data, capability: "prepayment", prepayments: [] }) },
                    reply: "Enter one prepayment as \"amount, installment number\".\nExamples: 100000, 12 or 1 lakh, 12.\nAfter one or more entries, send DONE."
                };
            }
            return {
                nextConversation: { ...conversation, principal: null, rate: null, tenureMonths: null, state: STATE.EXISTING_OUTSTANDING, stateData: JSON.stringify({ capability: "prepayment", prepayments: [] }) },
                reply: "What is your current outstanding loan balance?\n\nThis is the amount you still owe the bank, NOT the original loan amount.\n\nExample: 35 lakh"
            };
        }
        return { reply: "Please reply 1, 2 or 3.\n\n" + existingMenuReply() };
    }

    if (conversation.state === STATE.EXISTING_OUTSTANDING) {
        const outstanding = parsePrincipal(message);
        if (outstanding === null) {
            return { reply: "Invalid outstanding balance. Enter a positive amount up to ₹100 crore, for example 10 lakh." };
        }
        return {
            nextConversation: withStateData({ ...conversation, state: STATE.EXISTING_RATE, principal: null }, { outstanding }),
            reply: "What is your current annual interest rate?\n\nExample: 8.5%"
        };
    }
    if (conversation.state === STATE.EXISTING_RATE) {
        const rate = parseRate(message);
        if (rate === null) return { reply: "Invalid interest rate. Enter 0 to 100, for example 9.5." };
        return {
            nextConversation: withStateData({ ...conversation, state: STATE.EXISTING_EMI, rate: null }, { currentRate: rate }),
            reply: "How much EMI are you currently paying every month?\n\nExample: 40000"
        };
    }
    if (conversation.state === STATE.EXISTING_EMI) {
        const emi = parsePrincipal(message);
        if (emi === null) return { reply: "Invalid EMI. Enter a positive monthly EMI in rupees, for example 25000." };
        return {
            nextConversation: withStateData(
                { ...conversation, state: STATE.EXISTING_TENURE },
                { emi }
            ),
            reply: "How many months or years are left on your loan?\n\nExamples:\n140 months\n12 years"
        };
    }
    if (conversation.state === STATE.EXISTING_TENURE) {
        const months = parseTenure(message);
        if (months === null) return { reply: "Invalid remaining tenure. Enter 1 to 600 months, for example 60 months or 5 years." };

        const data = readStateData(conversation);
        const outstanding = data.outstanding;
        const rate = data.currentRate;
        const emi = data.emi;

        if (data.capability === "position") {
            try {
                const simulation = simulatePrepayments(outstanding, rate, emi, months, []);
                return {
                    nextConversation: { ...conversation, state: STATE.EXISTING_MENU, tenureMonths: null, stateData: JSON.stringify({ ...data, remainingTenure: months }) },
                    reply: formatCurrentPosition(simulation, outstanding, rate, emi, months)
                };
            } catch (error) {
                console.error("Current-position calculation error:", error);
                return { reply: "The projection could not be completed. Check your inputs or send RESET to restart." };
            }
        }
        if (data.capability === "rate") {
            return {
                nextConversation: withStateData({ ...conversation, state: STATE.EXISTING_REVISED_RATE, tenureMonths: null }, { remainingTenure: months }),
                reply: "What is the revised annual interest rate?\n\nExample: 8.5%"
            };
        }
        if (data.capability === "prepayment") {
            return {
                nextConversation: withStateData({ ...conversation, state: STATE.PREPAYMENT_EVENT, tenureMonths: null }, { remainingTenure: months, prepayments: [] }),
                reply: "Enter one prepayment as \"amount, installment number\".\nExamples: 100000, 12 or 1 lakh, 12.\nAfter one or more entries, send DONE."
            };
        }
    }

    if (conversation.state === STATE.EXISTING_REVISED_RATE) {
        const revisedRate = parseRate(message);
        if (revisedRate === null) return { reply: "Invalid revised rate. Enter 0 to 100, for example 8.5." };
        const data = readStateData(conversation);
        try {
            const simulation = simulateRateRevision(
                data.outstanding,
                data.currentRate,
                data.emi,
                data.remainingTenure,
                revisedRate
            );
            return {
                nextConversation: { ...conversation, state: STATE.EXISTING_MENU, stateData: JSON.stringify(data) },
                reply: formatRateRevision(simulation, data.currentRate, revisedRate, data.emi)
            };
        } catch (error) {
            console.error("Rate revision calculation error:", error);
            return { reply: "The rate comparison could not be completed. Check your inputs or send RESET to restart." };
        }
    }

    if (conversation.state === STATE.PREPAYMENT_EVENT) {
        const data = readStateData(conversation);
        if (command === "DONE") {
            if (!Array.isArray(data.prepayments) || data.prepayments.length === 0) {
                return { reply: "Add at least one prepayment before sending DONE. Example: 100000, 12." };
            }
            try {
                const simulation = simulatePrepayments(
                    data.outstanding,
                    data.currentRate,
                    data.emi,
                    data.remainingTenure,
                    data.prepayments
                );
                return {
                    nextConversation: { ...conversation, state: STATE.EXISTING_MENU, stateData: JSON.stringify(data) },
                    reply: formatPrepayments(simulation)
                };
            } catch (error) {
                console.error("Prepayment calculation error:", error);
                return { reply: "The prepayment plan could not be completed. Enter valid amounts and installment numbers, or send RESET." };
            }
        }
        const event = parsePrepayment(message, data.remainingTenure);
        if (!event) {
            return { reply: "Invalid prepayment. Use \"amount, installment number\", for example 100000, 12. The installment must be within the remaining tenure." };
        }
        const prepayments = [...(data.prepayments || []), event];
        const total = prepayments.reduce((sum, item) => sum + item.amount, 0);
        if (event.amount > data.outstanding || total > data.outstanding) {
            return { reply: "Prepayments must not exceed the outstanding balance. Enter a smaller amount or send DONE." };
        }
        return {
            nextConversation: withStateData({ ...conversation, state: STATE.PREPAYMENT_EVENT }, { prepayments }),
            reply: `Prepayment added: ${formatINR(event.amount)} at installment ${event.installmentNumber}.\n\nEnter another as \"amount, installment number\", or send DONE.`
        };
    }

    if (conversation.state === STATE.EXISTING_EMI) {
        // retained as a no-op guard
    }

    return {
        reply: "Sorry, I could not process that message. Send HELP for instructions or RESET to restart."
    };
}
