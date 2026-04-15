/**
 * One step in a grantAndroidPermissions run (`pm grant` only).
 */
export interface GrantAndroidPermissionItemResult {
  /** Stable step id, e.g. pm_grant:android.permission.CAMERA, cmd.notification.allow_dnd */
  operationId: string;
  /** Present when this row is a runtime `pm grant` */
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
 * Result of batch-granting Android runtime permissions (`pm grant`) for a package.
 */
export interface GrantAndroidPermissionsResult {
  success: boolean;
  appId: string;
  /** User id used with `pm grant --user` (0 = primary, 10+ = work profile when inferred). */
  userId: number;
  results: GrantAndroidPermissionItemResult[];
  error?: string;
}
