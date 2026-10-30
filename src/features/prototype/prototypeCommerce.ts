import { record, type Raw } from "./prototypeTemplate";
import type { PrototypePlatformError } from "./prototypePlatform";

/**
 * Root `commerce` catalog rules (#14314) the contract cannot express: the block needs `commerce` in
 * `requires.platform`, product ids are unique, only a subscription has a `period` or `trialPeriod`,
 * a `commerce.*` call needs the catalog, and a literal `commerce.purchase` product id names a
 * catalog product. Kotlin `PrototypeCommerceRules` and Swift `PrototypeCommerceRules` mirror these
 * checks.
 */
export function prototypeCommerceBlockError(root: Raw): PrototypePlatformError | undefined {
  const commerce = record(root.commerce);
  if (!commerce) {
    return undefined;
  }
  const requires = record(root.requires);
  if (!Array.isArray(requires?.platform) || !requires.platform.includes("commerce")) {
    return {
      path: "commerce",
      message: "The commerce block requires commerce in requires.platform",
    };
  }
  const seen = new Set<unknown>();
  const products = Array.isArray(commerce.products) ? commerce.products : [];
  for (const [index, entry] of products.entries()) {
    const product = record(entry) ?? {};
    const at = `commerce.products[${index}]`;
    if (seen.has(product.id)) {
      return { path: `${at}.id`, message: "Duplicate product id" };
    }
    seen.add(product.id);
    const period = ["period", "trialPeriod"].find((field) => product[field] !== undefined);
    if (period && product.kind !== "subscription") {
      return { path: `${at}.${period}`, message: "Only a subscription has a period" };
    }
  }
  return undefined;
}

/** A `commerce.*` call without the catalog, or a literal product id the catalog does not list. */
export function prototypeCommerceCallError(
  action: Raw,
  path: string,
  root: Raw,
): PrototypePlatformError | undefined {
  const call = action.call;
  if (typeof call !== "string" || !call.startsWith("commerce.")) {
    return undefined;
  }
  const commerce = record(root.commerce);
  if (!commerce) {
    return { path: `${path}.call`, message: `${call} requires a root commerce block` };
  }
  const productId = record(record(action.args)?.productId)?.value;
  const products = Array.isArray(commerce.products) ? commerce.products : [];
  return typeof productId === "string" &&
    !products.some((product) => record(product)?.id === productId)
    ? { path: `${path}.args.productId.value`, message: "Unknown product" }
    : undefined;
}
