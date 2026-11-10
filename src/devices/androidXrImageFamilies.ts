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
const XR_SUGGESTED_API: Readonly<Record<XrFormFactor, number>> = {
  "xr-headset": 34,
  "xr-glasses": 36,
};

/** What the refusal reports: resolved API bounds (`max` absent when unbounded) and their text. */
export interface XrMissingImageContext {
  bounds: { min: number; max: number | undefined };
  range: string;
  installed: string;
  abi: string;
}

/**
 * The refusal for an XR request with no image of its family in the requested API range. The
 * install command is suggested only when the known image's API level is inside the bounds;
 * otherwise installing it could not satisfy the retry, so the caller is told to widen the range.
 */
export function xrMissingImageMessage(
  kind: XrFormFactor,
  { bounds, range, installed, abi }: XrMissingImageContext,
): string {
  const label = kind === "xr-headset" ? "Android XR headset" : "Android XR glasses";
  const api = XR_SUGGESTED_API[kind];
  const preamble =
    `No installed ${label} system image (${androidSystemImageTagsFor(kind).join(", ")}) matches ` +
    `the requested API range ${range}. Installed images: ${installed}. `;
  if (api < bounds.min || (bounds.max !== undefined && api > bounds.max)) {
    return (
      preamble +
      `No ${label} system image is available in the requested API range: the known image is ` +
      `API ${api} (${XR_SUGGESTED_TAG[kind]}). Widen minOsVersion/maxOsVersion to include ` +
      `API ${api}, then retry. 'sdkmanager --list --channel=3' shows the XR API levels published.`
    );
  }
  return (
    preamble +
    "AutoMobile does not download system images. Install one with " +
    `'sdkmanager --channel=3 --install "system-images;android-${api};${XR_SUGGESTED_TAG[kind]};${abi}"', then retry. ` +
    "XR images are published on the canary channel: 'sdkmanager --list --channel=3' shows the " +
    "API levels and ABIs available."
  );
}
