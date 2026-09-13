/**
 * Represents an installed app on Android with user profile information
 */
export interface InstalledApp {
  /**
   * Package name (e.g., "com.example.app")
   */
  packageName: string;

  /**
   * Android user ID where this app is installed
   * - 0: Primary user (personal profile)
   * - 10+: Work profile or other managed profiles
   */
  userId: number;

  /**
   * Android's parsed profile classification. It is optional for cached rows
   * created before profile metadata was persisted.
   */
  profileType?: "primary" | "managed" | "secondary" | "unknown";

  /**
   * Whether this app instance is currently in the foreground
   */
  foreground: boolean;

  /**
   * Whether this app instance was recently used
   * (Placeholder for future implementation - currently always false)
   */
  recent: boolean;

  /**
   * Launcher label as a human sees it ("Contacts"). Optional: it is only
   * available where a label source reported one (issue #6798) — on Android
   * that is the CtrlProxy accessibility service, since no adb shell surface
   * resolves a package's `labelRes` resource id.
   */
  label?: string;

  /**
   * Whether the package exposes a MAIN/LAUNCHER entry point, i.e. whether
   * `launchApp` can do anything with it. `undefined` means "not reported"
   * (the launcher probe was unavailable), never "no" (issue #6798).
   */
  launchable?: boolean;
}

/**
 * Represents a system app installed across one or more Android user profiles.
 */
export interface SystemInstalledApp {
  /**
   * Package name (e.g., "com.android.settings")
   */
  packageName: string;

  /**
   * Android user IDs where this system app is installed
   */
  userIds: number[];

  /**
   * Whether this app instance is currently in the foreground
   */
  foreground: boolean;

  /**
   * Whether this app instance was recently used
   * (Placeholder for future implementation - currently always false)
   */
  recent: boolean;

  /**
   * Launcher label as a human sees it ("Contacts"). Optional: it is only
   * available where a label source reported one (issue #6798) — on Android
   * that is the CtrlProxy accessibility service, since no adb shell surface
   * resolves a package's `labelRes` resource id.
   */
  label?: string;

  /**
   * Whether the package exposes a MAIN/LAUNCHER entry point for AT LEAST ONE of
   * `userIds`. `undefined` means "not reported" (the launcher probe was
   * unavailable), never "no" (issue #6798).
   */
  launchable?: boolean;

  /**
   * Launchability per Android user id, for the users where it was reported. A
   * launcher activity can be disabled for the owner and enabled in a work
   * profile, so a deduplicated system app cannot carry a single scalar without
   * misreporting one of its profiles (#6798 review). A user id absent from this
   * map had no launchability signal.
   */
  launchableByUserId?: Record<number, boolean>;
}

/**
 * Grouped installed apps by profile with system apps deduped.
 */
export interface InstalledAppsByProfile {
  profiles: Record<number, InstalledApp[]>;
  system: SystemInstalledApp[];
}
