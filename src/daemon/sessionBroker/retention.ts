/**
 * Terminal receipts answer exact replay for 30 days after they become terminal. The protocol
 * promises a durable receipt for an ambiguous reply but names no horizon; this is far beyond any
 * preparation or release budget, so only a long-finished identity is ever forgotten.
 */
export const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
