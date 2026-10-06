import type { AdbExecutor } from "./interfaces/AdbExecutor";
import { classifyAndroidUser, type AndroidUser } from "../../models/AndroidUser";
import { isPackageInstalledForUser } from "./isPackageInstalledForUser";
import { logger } from "../logger";

export type UserTargetSource =
  | "explicit"
  | "currentUser"
  | "foregroundPackage"
  | "managedProfile"
  | "primary";

export interface ResolvedUserTarget<Source extends string = UserTargetSource> {
  userId: number;
  source: Source;
}

export interface UserTargetRequest<InstalledOnly extends boolean = false> {
  packageName?: string;
  explicitUserId?: number;
  /** Resolve Android's current user before applying package/profile heuristics. */
  currentUser?: boolean;
  /** Restrict background package targeting to installed running users on multi-user devices. */
  installedOnly?: InstalledOnly;
  signal?: AbortSignal;
}

/**
 * Device state was read, but no unambiguous active target can be selected.
 * `kind` separates an ambiguous choice (several managed profiles) from a missing
 * one (no running primary, which is also what an empty or unparsed user list
 * looks like); `users` is every user the device listed, so a caller can tell a
 * single-user device from a multi-user one before deciding how to react.
 */
export class AndroidUserTargetUnavailableError extends Error {
  constructor(
    message: string,
    readonly details: { kind: "ambiguous" | "unavailable"; users: readonly AndroidUser[] } = {
      kind: "unavailable",
      users: [],
    },
  ) {
    super(message);
  }
}

/**
 * Resolves the user for one public operation. Explicit IDs (including zero)
 * win; otherwise a foreground instance of the requested package wins, followed
 * by the sole running managed profile and finally the running primary user. A
 * secondary user is never treated as managed solely because its ID is nonzero.
 * Missing or ambiguous device state is rejected instead of silently targeting
 * user 0. With installedOnly, background multi-user selection applies this
 * order only to running users where the requested package is installed.
 */
export class AndroidUserTargetResolver {
  constructor(private readonly adb: AdbExecutor) {}

  resolve<InstalledOnly extends boolean = false>(
    request?: UserTargetRequest<InstalledOnly>,
  ): Promise<
    ResolvedUserTarget<UserTargetSource | (InstalledOnly extends true ? "installedUser" : never)>
  >;
  async resolve(
    request: UserTargetRequest<boolean> = {},
  ): Promise<ResolvedUserTarget<UserTargetSource | "installedUser">> {
    if (request.explicitUserId !== undefined) {
      return { userId: request.explicitUserId, source: "explicit" };
    }

    if (request.currentUser) {
      const result = await this.adb.executeCommand(
        "shell am get-current-user",
        undefined,
        undefined,
        true,
        request.signal,
      );
      const currentUserId = Number.parseInt(result.stdout.trim(), 10);
      if (Number.isSafeInteger(currentUserId) && currentUserId >= 0) {
        return { userId: currentUserId, source: "currentUser" };
      }
    }

    if (request.packageName) {
      const foreground = await this.adb.getForegroundApp(request.signal);
      if (foreground?.packageName === request.packageName) {
        return { userId: foreground.userId, source: "foregroundPackage" };
      }
    }

    const allUsers = await this.adb.listUsers(request.signal);
    const users = await this.installedCandidates(request, allUsers);
    if (users !== allUsers && users.length === 1) {
      return { userId: users[0].userId, source: "installedUser" };
    }
    return this.selectDefaultUser(users, allUsers);
  }

  private selectDefaultUser(users: AndroidUser[], allUsers: AndroidUser[]): ResolvedUserTarget {
    const managedProfiles = users.filter(
      (user) => user.running && (user.profileType ?? classifyAndroidUser(user.flags)) === "managed",
    );
    if (managedProfiles.length === 1) {
      const managedProfile = managedProfiles[0];
      return { userId: managedProfile.userId, source: "managedProfile" };
    }

    if (managedProfiles.length > 1) {
      throw new AndroidUserTargetUnavailableError(
        `Android target user is ambiguous: ${managedProfiles.length} managed profiles are running`,
        { kind: "ambiguous", users: allUsers },
      );
    }

    const primary = users.find(
      (user) => user.running && (user.profileType ?? classifyAndroidUser(user.flags)) === "primary",
    );
    if (primary) {
      return { userId: primary.userId, source: "primary" };
    }

    throw new AndroidUserTargetUnavailableError(
      "Android target user is unavailable: no running primary or uniquely selectable managed profile",
      { kind: "unavailable", users: allUsers },
    );
  }

  private async installedCandidates(
    request: UserTargetRequest<boolean>,
    users: AndroidUser[],
  ): Promise<AndroidUser[]> {
    if (!request.installedOnly || !request.packageName || request.currentUser) {
      return users;
    }
    const runningUsers = users.filter((user) => user.running);
    if (runningUsers.length <= 1) {
      return users;
    }
    const candidates: AndroidUser[] = [];
    for (const user of runningUsers) {
      if (
        await isPackageInstalledForUser(
          this.adb,
          request.packageName,
          user.userId,
          undefined,
          request.signal,
        )
      ) {
        candidates.push(user);
      }
    }
    if (candidates.length > 0) {
      return candidates;
    }
    // Preserve the tools' existing not-installed results without adding public fields.
    logger.info(
      `Android app ${request.packageName} is not installed for any running user; checked users: ${runningUsers.map((user) => user.userId).join(", ")}`,
    );
    return users;
  }
}
