import type { AndroidImageFamily } from "./deviceProvisioning";
import {
  androidProfileFormFactor,
  androidSystemImageTagsFor,
  defaultAndroidProfileIdFor,
} from "../models/formFactor";

/** Wear images use the same tags inventory classifies as watch, in provisioning preference order. */
export function watchImageFamily(screenRound?: boolean, profileName?: string): AndroidImageFamily {
  const tags = androidSystemImageTagsFor("watch");
  return {
    kind: "watch",
    accepts: (tag) => tags.includes(tag),
    rank: (tag) => tags.indexOf(tag),
    deviceProfile:
      androidProfileFormFactor({ profileId: profileName }) === "watch"
        ? profileName?.trim()
        : defaultAndroidProfileIdFor("watch", screenRound),
    namePrefix: "android-watch",
  };
}

/** Missing-image guidance stays explicit about the requested range and host-runnable ABIs. */
export function watchMissingImageMessage(
  range: string,
  installed: string,
  abis: readonly string[],
): string {
  const tags = androidSystemImageTagsFor("watch");
  return (
    `No installed Wear OS system image (${tags.join(", ")}) matches the requested API range ` +
    `${range} and host ABIs ${abis.join(" or ")}. Installed images: ${installed}. ` +
    "AutoMobile does not download system images. Install one with " +
    `'sdkmanager "system-images;android-<api>;${tags[0]};${abis[0]}"', then retry.`
  );
}
