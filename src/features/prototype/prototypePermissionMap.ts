import { z } from "zod/v3";
import mapping from "../../../schemas/prototype-platform-permissions.json";
import contract from "../../../schemas/prototype-spec-contract.json";

/**
 * Canonical prototype permission names (#14297), in contract order. `requires.permissions[].name`,
 * `permissions.request` and `/platform/permissions/<name>` all use these.
 */
export const PROTOTYPE_PERMISSION_NAMES = contract.definitions.platformPermission.fields.name.rule
  .values as readonly PrototypePermissionName[];

export type PrototypePermissionName =
  | "camera"
  | "microphone"
  | "location"
  | "locationBackground"
  | "notifications"
  | "photos"
  | "photosAdd"
  | "contacts"
  | "calendar"
  | "bluetooth"
  | "nearbyWifi"
  | "motion"
  | "speech";

/** A permission state the runtime reports at `/platform/permissions/<name>`. */
export type PrototypePermissionState =
  | "granted"
  | "denied"
  | "blocked"
  | "notDetermined"
  | "limited"
  | "restricted"
  | "unavailable";

/**
 * How the host grants an Android permission before launch: `pmGrant` runs `pm grant` per manifest
 * permission, `notifications` toggles the app's notification setting (POST_NOTIFICATIONS is not a
 * `pm grant` permission for setAppPermissions), and `none` means no runtime grant exists.
 */
const androidEntry = z
  .object({
    manifest: z.array(z.string().startsWith("android.permission.")),
    grant: z.enum(["pmGrant", "notifications", "none"]),
  })
  .strict();

/** `simctlService` is the `simctl privacy` service; null means notGrantableOnSimulator. */
const iosEntry = z
  .object({
    usageKey: z.string().startsWith("NS").nullable(),
    simctlService: z.string().nullable(),
  })
  .strict();

const mappingSchema = z.record(z.object({ android: androidEntry, ios: iosEntry }).strict());

export type PrototypeAndroidPermissionMapping = z.infer<typeof androidEntry>;
export type PrototypeIosPermissionMapping = z.infer<typeof iosEntry>;
export interface PrototypePermissionMapping {
  android: PrototypeAndroidPermissionMapping;
  ios: PrototypeIosPermissionMapping;
}

/** Parsed `schemas/prototype-platform-permissions.json`, keyed by canonical name. */
export const PROTOTYPE_PERMISSION_MAP: Readonly<
  Record<PrototypePermissionName, PrototypePermissionMapping>
> = mappingSchema.parse(mapping) as Record<PrototypePermissionName, PrototypePermissionMapping>;

/** Whether a canonical name has no `simctl privacy` service, so a simulator cannot grant or deny it. */
export function notGrantableOnSimulator(name: PrototypePermissionName): boolean {
  return PROTOTYPE_PERMISSION_MAP[name].ios.simctlService === null;
}
