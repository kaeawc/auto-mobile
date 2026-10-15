import { createHash } from "node:crypto";
import { InvalidPrototypeIdError } from "./iosPrototypeInstallerErrors";

export const PROTOTYPE_BUNDLE_ID_PREFIX = "dev.jasonpearson.automobile.proto.";

export function prototypeBundleId(prototypeId: string): string {
  if (!prototypeId.trim()) {
    throw new InvalidPrototypeIdError();
  }
  const digest = createHash("sha256").update(prototypeId).digest("hex").slice(0, 8);
  const slug =
    prototypeId
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "prototype";
  const maxSlugLength = 155 - PROTOTYPE_BUNDLE_ID_PREFIX.length - 9;
  const boundedSlug = slug.slice(0, maxSlugLength).replace(/-$/, "");
  return `${PROTOTYPE_BUNDLE_ID_PREFIX}${boundedSlug}-${digest}`;
}

export function isPrototypeBundleId(id: string): boolean {
  return id.startsWith(PROTOTYPE_BUNDLE_ID_PREFIX);
}
