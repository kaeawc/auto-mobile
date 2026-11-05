import type { AndroidImageFamily } from "./deviceProvisioning";
import { androidSystemImageTagsFor, defaultAndroidProfileIdFor } from "../models/formFactor";

export type XrFormFactor = "xr-headset" | "xr-glasses";

function xrImageFamily(kind: XrFormFactor): AndroidImageFamily {
  const tags = androidSystemImageTagsFor(kind);
  return {
    kind,
    accepts: (tag) => tags.includes(tag),
    rank: (tag) => tags.indexOf(tag),
    deviceProfile: defaultAndroidProfileIdFor(kind),
    namePrefix: `android-${kind}`,
  };
}

/**
 * Android XR images, best first, exactly the tags inventory classifies as XR so a created AVD is
 * found again by a repeated request. Headsets prefer the plain `google-xr` image over its Play
 * variants, as TV prefers its rootable image; glasses ship one tag.
 */
export const XR_IMAGE_FAMILIES: Readonly<Record<XrFormFactor, AndroidImageFamily>> = {
  "xr-headset": xrImageFamily("xr-headset"),
  "xr-glasses": xrImageFamily("xr-glasses"),
};

/** The `sdkmanager` package shape suggested when no image of an XR family is installed. */
const XR_SUGGESTED_TAG: Readonly<Record<XrFormFactor, string>> = {
  "xr-headset": "google-xr",
  "xr-glasses": "ai-glasses",
};

/** The refusal for an XR request with no image of its family in the requested API range. */
export function xrMissingImageMessage(
  kind: XrFormFactor,
  range: string,
  installed: string,
  abi: string,
): string {
  const label = kind === "xr-headset" ? "Android XR headset" : "Android XR glasses";
  return (
    `No installed ${label} system image (${androidSystemImageTagsFor(kind).join(", ")}) matches ` +
    `the requested API range ${range}. Installed images: ${installed}. ` +
    "AutoMobile does not download system images. Install one with " +
    `'sdkmanager "system-images;android-<api>;${XR_SUGGESTED_TAG[kind]};${abi}"', then retry. ` +
    "XR images are published on the canary channel: 'sdkmanager --list --channel=3' shows the " +
    "API levels and ABIs available."
  );
}
