export const MAX_PRINCIPAL = 1_000_000_000;
export const MAX_ANNUAL_RATE = 100;
export const MAX_TENURE_MONTHS = 600;

const PRINCIPAL_MULTIPLIERS = Object.freeze({
    "": 1,
    k: 1_000,
    thousand: 1_000,
    l: 100_000,
    lac: 100_000,
    lacs: 100_000,
    lakh: 100_000,
    lakhs: 100_000,
    cr: 10_000_000,
    crore: 10_000_000,
    crores: 10_000_000
});

export function parsePrincipal(text) {
    if (typeof text !== "string") return null;

    const normalized = text
        .replace(/₹/g, "")
        .trim()
        .toLowerCase();

    // Do not silently remove commas or other unsupported characters.
    const match = normalized.match(
        /^(\d+(?:\.\d+)?)\s*(k|thousand|l|lac|lacs|lakh|lakhs|cr|crore|crores)?$/
    );

    if (!match) return null;

    const value = Number(match[1]);
    const unit = match[2] || "";
    const amount = value * PRINCIPAL_MULTIPLIERS[unit];

    if (
        !Number.isFinite(amount) ||
        amount <= 0 ||
        amount > MAX_PRINCIPAL
    ) {
        return null;
    }

    return amount;
}

export function parseRate(text) {
    if (typeof text !== "string") return null;

    const normalized = text.trim().replace(/%/g, "").trim();

    if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;

    const rate = Number(normalized);

    if (
        !Number.isFinite(rate) ||
        rate < 0 ||
        rate > MAX_ANNUAL_RATE
    ) {
        return null;
    }

    return rate;
}

export function parseTenure(text) {
    if (typeof text !== "string") return null;

    const normalized = text.toLowerCase().trim();

    const match = normalized.match(
        /^(\d+)\s*(months?|mos?|years?|yrs?)?$/
    );

    if (!match) return null;

    const value = Number(match[1]);
    const unit = match[2] || "months";

    const months =
        unit.startsWith("year") || unit.startsWith("yr")
            ? value * 12
            : value;

    if (
        !Number.isInteger(months) ||
        months < 1 ||
        months > MAX_TENURE_MONTHS
    ) {
        return null;
    }

    return months;
}
