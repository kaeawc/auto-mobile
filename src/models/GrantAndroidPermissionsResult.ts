/**
 * One step in an Android runtime-permission mutation (`pm grant`, `pm revoke`, or reset).
 */
export interface GrantAndroidPermissionItemResult {
  /** Stable step id, e.g. pm_grant:android.permission.CAMERA, cmd.notification.allow_dnd */
  operationId: string;
  /** Present when this row mutates one runtime permission with `pm grant` or `pm revoke`. */
  permission?: string;
  success: boolean;
  /**
   * When false, a failed step is recorded but does not fail the tool (matches FUB-style best-effort revokes).
   */
  countsTowardSuccess: boolean;
  skipped?: boolean;
  skipReason?: string;
  error?: string;
}

/**
 * Result of an Android runtime-permission mutation for a package.
 */
export interface GrantAndroidPermissionsResult {
  success: boolean;
  appId: string;
  /**
   * User id used with `pm grant` or `pm revoke` (0 = primary, 10+ = work profile when inferred).
   * Device-wide `pm reset-permissions` does not target a user and returns 0.
   */
  userId: number;
  results: GrantAndroidPermissionItemResult[];
  error?: string;
}
