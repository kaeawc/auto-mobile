/** Resource URIs for booted devices and device images, shared by the lifecycle tools and the server resources. */
export const BOOTED_DEVICE_RESOURCE_URIS = {
  ALL_BOOTED: "automobile:devices/booted",
  PLATFORM_TEMPLATE: "automobile:devices/booted/{platform}",
} as const;

export const DEVICE_IMAGE_RESOURCE_URIS = {
  ALL_IMAGES: "automobile:devices/images",
  PLATFORM_TEMPLATE: "automobile:devices/images/{platform}",
} as const;

/** Retry hint for an Android inventory refresh that is still settling. */
export const ANDROID_INVENTORY_RETRY_AFTER_MS = 1_000;
