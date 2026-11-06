import { createHash } from "node:crypto";
import { ActionableError } from "../../../models/ActionableError";

/**
 * Identity of a disposable prototype app (#14184). The id is always
 * `<reserved prefix><slug><separator><sha256(slug) 8 hex>`, so an agent never chooses the
 * prefix and a disposable app can never replace a real app.
 */

export type DisposableAppPlatform = "android" | "ios";

/** The reserved application-id prefix every disposable app shares, on both platforms. */
export const DISPOSABLE_APP_ID_PREFIX = "dev.jasonpearson.automobile.app.";

/** A slug is lowercase ASCII words joined by single hyphens, starting with a letter. */
export const DISPOSABLE_APP_SLUG_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const MAX_DISPOSABLE_APP_SLUG_LENGTH = 48;

/**
 * Android package segments allow only `[A-Za-z0-9_]`, so the slug's hyphens and the digest
 * separator become underscores there. iOS bundle ids keep the hyphens, matching
 * `prototypeBundleId`.
 */
const SEPARATOR: Record<DisposableAppPlatform, string> = { android: "_", ios: "-" };

export function assertDisposableAppSlug(slug: string): void {
  if (slug.length === 0 || slug.length > MAX_DISPOSABLE_APP_SLUG_LENGTH) {
    throw new ActionableError(
      `app.slug must be 1-${MAX_DISPOSABLE_APP_SLUG_LENGTH} characters; got ${slug.length}.`,
    );
  }
  if (!DISPOSABLE_APP_SLUG_PATTERN.test(slug)) {
    throw new ActionableError(
      `app.slug "${slug}" must be lowercase letters and digits in hyphen-separated words, starting with a letter (for example "feedly" or "news-reader").`,
    );
  }
}

export function disposableAppId(platform: DisposableAppPlatform, slug: string): string {
  assertDisposableAppSlug(slug);
  const digest = createHash("sha256").update(slug).digest("hex").slice(0, 8);
  const separator = SEPARATOR[platform];
  return `${DISPOSABLE_APP_ID_PREFIX}${slug.replaceAll("-", separator)}${separator}${digest}`;
}

export function isDisposableAppId(appId: string): boolean {
  return (
    appId.startsWith(DISPOSABLE_APP_ID_PREFIX) && appId.length > DISPOSABLE_APP_ID_PREFIX.length
  );
}

/** Uninstall and every other destructive path refuse ids outside the reserved prefix. */
export function assertDisposableAppId(appId: string): void {
  if (!isDisposableAppId(appId)) {
    throw new ActionableError(
      `${appId} is not a disposable prototype app: only ids starting with ${DISPOSABLE_APP_ID_PREFIX} can be removed this way. Use the uninstallApp tool for other apps.`,
    );
  }
}
