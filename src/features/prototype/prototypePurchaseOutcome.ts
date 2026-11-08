/**
 * The fake store's reference reducer (#14314): what a `commerce.purchase` outcome, a deferred or
 * pending transaction's resolution, and a simulated `commerce.entitlementsChanged` do to the
 * read-only `/platform/commerce` state. The Kotlin twin `PrototypePurchaseOutcome` replays the same
 * corpus, `test/fixtures/prototype-purchase/`.
 *
 * - `entitlements` maps a product id to `active`, `gracePeriod` or `billingRetry`. A consumable never
 *   holds an entitlement. `lastTransaction` is `{transactionId, productId, status}` or null. Both are
 *   flat, as the module's state contract requires.
 * - A purchase of a product the catalog does not list is `platform_error` with reason `unavailable`.
 *   A non-consumable or subscription that is `active` or in `gracePeriod` is `alreadyOwned`, whatever
 *   outcome was queued; one in `billingRetry` can be bought again.
 * - A queued error leaves the state untouched. Codes outside `PROTOTYPE_PURCHASE_ERROR_CODES` become
 *   `platform_error`, and only `platform_error` keeps a `reason` from
 *   `PROTOTYPE_PURCHASE_ERROR_REASONS`.
 * - A result records `lastTransaction`; only `purchased` grants the entitlement. A `deferred` or
 *   `pending` transaction is resolved later: `approved` grants it, `declined` records `declined`.
 * - `entitlementsChanged` is true only when `entitlements` actually changed, so the runtime raises
 *   `commerce.entitlementsChanged` once per real change.
 */

export const PROTOTYPE_PURCHASE_STATUSES = ["purchased", "deferred", "pending"] as const;
export type PrototypePurchaseStatus = (typeof PROTOTYPE_PURCHASE_STATUSES)[number];

export const PROTOTYPE_PURCHASE_ERROR_CODES = [
  "cancelled",
  "alreadyOwned",
  "platform_error",
] as const;
export type PrototypePurchaseErrorCode = (typeof PROTOTYPE_PURCHASE_ERROR_CODES)[number];

export const PROTOTYPE_PURCHASE_ERROR_REASONS = ["network", "declined", "unavailable"] as const;
export type PrototypePurchaseErrorReason = (typeof PROTOTYPE_PURCHASE_ERROR_REASONS)[number];

export const PROTOTYPE_ENTITLEMENT_CHANGES = [
  "renew",
  "expire",
  "refund",
  "gracePeriod",
  "billingRetry",
] as const;
export type PrototypeEntitlementChange = (typeof PROTOTYPE_ENTITLEMENT_CHANGES)[number];

export type PrototypeEntitlementStatus = "active" | "gracePeriod" | "billingRetry";
export type PrototypeTransactionStatus = PrototypePurchaseStatus | "declined";

/** What the reducer reads from a catalog product. */
export interface PrototypeCommerceProduct {
  id: string;
  kind: "consumable" | "nonConsumable" | "subscription";
}

export interface PrototypeCommerceTransaction {
  transactionId: string;
  productId: string;
  status: PrototypeTransactionStatus;
}

export interface PrototypeCommerceState {
  entitlements: Record<string, PrototypeEntitlementStatus>;
  lastTransaction: PrototypeCommerceTransaction | null;
}

export interface PrototypePurchaseError {
  code: PrototypePurchaseErrorCode;
  message: string;
  reason?: PrototypePurchaseErrorReason;
}

/** One queued or tapped outcome for `commerce.purchase`. */
export type PrototypePurchaseOutcome =
  | { result: { status: PrototypePurchaseStatus; transactionId: string } }
  | { error: { code: string; message: string; reason?: string } };

export interface PrototypeCommerceStep {
  state: PrototypeCommerceState;
  /** The `into` value of a successful `commerce.purchase`. */
  into?: { status: PrototypePurchaseStatus; transactionId: string };
  error?: PrototypePurchaseError;
  entitlementsChanged: boolean;
}

export const EMPTY_PROTOTYPE_COMMERCE_STATE: PrototypeCommerceState = {
  entitlements: {},
  lastTransaction: null,
};

const MAX_TRANSACTION_ID_LENGTH = 64;

function failed(
  state: PrototypeCommerceState,
  error: PrototypePurchaseError,
): PrototypeCommerceStep {
  return { state, error, entitlementsChanged: false };
}

function unknownProduct(state: PrototypeCommerceState, productId: string): PrototypeCommerceStep {
  return failed(state, {
    code: "platform_error",
    message: `Unknown product ${productId}`,
    reason: "unavailable",
  });
}

function typedError(error: {
  code: string;
  message: string;
  reason?: string;
}): PrototypePurchaseError {
  const code = (PROTOTYPE_PURCHASE_ERROR_CODES as readonly string[]).includes(error.code)
    ? (error.code as PrototypePurchaseErrorCode)
    : "platform_error";
  const reason = (PROTOTYPE_PURCHASE_ERROR_REASONS as readonly string[]).includes(
    error.reason ?? "",
  )
    ? (error.reason as PrototypePurchaseErrorReason)
    : undefined;
  return code === "platform_error" && reason !== undefined
    ? { code, message: error.message, reason }
    : { code, message: error.message };
}

/** The held status; own properties only, so an id such as `constructor` is never inherited. */
function entitlementOf(
  state: PrototypeCommerceState,
  productId: string,
): PrototypeEntitlementStatus | undefined {
  return Object.hasOwn(state.entitlements, productId) ? state.entitlements[productId] : undefined;
}

function isOwned(state: PrototypeCommerceState, productId: string): boolean {
  const status = entitlementOf(state, productId);
  return status === "active" || status === "gracePeriod";
}

function withEntitlement(
  state: PrototypeCommerceState,
  productId: string,
  status: PrototypeEntitlementStatus | undefined,
  lastTransaction: PrototypeCommerceTransaction | null = state.lastTransaction,
): PrototypeCommerceStep {
  const previous = entitlementOf(state, productId);
  const rest = Object.fromEntries(
    Object.entries(state.entitlements).filter(([id]) => id !== productId),
  );
  const entitlements = status === undefined ? rest : { ...rest, [productId]: status };
  return {
    state: {
      entitlements: status === previous ? state.entitlements : entitlements,
      lastTransaction,
    },
    entitlementsChanged: status !== previous,
  };
}

/** Applies one `commerce.purchase` outcome for `productId` against the catalog `products`. */
export function applyPrototypePurchaseOutcome(
  products: readonly PrototypeCommerceProduct[],
  state: PrototypeCommerceState,
  productId: string,
  outcome: PrototypePurchaseOutcome,
): PrototypeCommerceStep {
  const product = products.find((candidate) => candidate.id === productId);
  if (!product) {
    return unknownProduct(state, productId);
  }
  if (product.kind !== "consumable" && isOwned(state, productId)) {
    return failed(state, { code: "alreadyOwned", message: `${productId} is already owned` });
  }
  if ("error" in outcome) {
    return failed(state, typedError(outcome.error));
  }
  const { status, transactionId } = outcome.result;
  if (transactionId.length === 0 || transactionId.length > MAX_TRANSACTION_ID_LENGTH) {
    return failed(state, { code: "platform_error", message: "Invalid transaction id" });
  }
  const lastTransaction = { transactionId, productId, status };
  const grants = status === "purchased" && product.kind !== "consumable";
  const step = grants
    ? withEntitlement(state, productId, "active", lastTransaction)
    : { state: { ...state, lastTransaction }, entitlementsChanged: false };
  return { ...step, into: { status, transactionId } };
}

/** Resolves the open `deferred` or `pending` transaction `transactionId`. */
export function applyPrototypeTransactionResolution(
  products: readonly PrototypeCommerceProduct[],
  state: PrototypeCommerceState,
  transactionId: string,
  resolution: "approved" | "declined",
): PrototypeCommerceStep {
  const open = state.lastTransaction;
  if (
    open?.transactionId !== transactionId ||
    (open.status !== "deferred" && open.status !== "pending")
  ) {
    return failed(state, {
      code: "platform_error",
      message: `No open transaction ${transactionId}`,
    });
  }
  const product = products.find((candidate) => candidate.id === open.productId);
  if (!product) {
    return unknownProduct(state, open.productId);
  }
  if (resolution === "declined") {
    return {
      state: { ...state, lastTransaction: { ...open, status: "declined" } },
      entitlementsChanged: false,
    };
  }
  const lastTransaction: PrototypeCommerceTransaction = { ...open, status: "purchased" };
  return product.kind === "consumable"
    ? { state: { ...state, lastTransaction }, entitlementsChanged: false }
    : withEntitlement(state, open.productId, "active", lastTransaction);
}

const CHANGE_STATUS: Record<PrototypeEntitlementChange, PrototypeEntitlementStatus | undefined> = {
  renew: "active",
  gracePeriod: "gracePeriod",
  billingRetry: "billingRetry",
  expire: undefined,
  refund: undefined,
};

/**
 * Applies one simulated `commerce.entitlementsChanged`. `renew`, `gracePeriod` and `billingRetry`
 * apply only to a subscription the user holds; `expire` and `refund` remove the entitlement and
 * are no-ops when there is none. A consumable has no entitlement to change.
 */
export function applyPrototypeEntitlementChange(
  products: readonly PrototypeCommerceProduct[],
  state: PrototypeCommerceState,
  productId: string,
  change: PrototypeEntitlementChange,
): PrototypeCommerceStep {
  const product = products.find((candidate) => candidate.id === productId);
  if (!product) {
    return unknownProduct(state, productId);
  }
  if (product.kind === "consumable") {
    return failed(state, {
      code: "platform_error",
      message: `${productId} is a consumable and has no entitlement`,
    });
  }
  const status = CHANGE_STATUS[change];
  if (status !== undefined && product.kind !== "subscription") {
    return failed(state, {
      code: "platform_error",
      message: `Only a subscription can ${change}`,
    });
  }
  if (status !== undefined && entitlementOf(state, productId) === undefined) {
    return failed(state, { code: "platform_error", message: `${productId} is not held` });
  }
  return withEntitlement(state, productId, status);
}
