import type { AdbExecutor } from "./interfaces/AdbExecutor";
import { classifyAndroidUser } from "../../models/AndroidUser";

export type UserTargetSource = "explicit" | "foregroundPackage" | "managedProfile" | "primary";

export interface ResolvedUserTarget {
  userId: number;
  source: UserTargetSource;
}

export interface UserTargetRequest {
  packageName?: string;
  explicitUserId?: number;
  signal?: AbortSignal;
}

/**
 * Resolves the user for one public operation. Explicit IDs (including zero)
 * win; otherwise a foreground instance of the requested package wins, followed
 * by the sole running managed profile and finally the running primary user. A
 * secondary user is never treated as managed solely because its ID is nonzero.
 * Missing or ambiguous device state is rejected instead of silently targeting
 * user 0.
 */
export class AndroidUserTargetResolver {
  constructor(private readonly adb: AdbExecutor) {}

  async resolve(request: UserTargetRequest = {}): Promise<ResolvedUserTarget> {
    if (request.explicitUserId !== undefined) {
      return { userId: request.explicitUserId, source: "explicit" };
    }

    if (request.packageName) {
      const foreground = await this.adb.getForegroundApp(request.signal);
      if (foreground?.packageName === request.packageName) {
        return { userId: foreground.userId, source: "foregroundPackage" };
      }
    }

    const users = await this.adb.listUsers(request.signal);
    const managedProfiles = users.filter(
      (user) => user.running && (user.profileType ?? classifyAndroidUser(user.flags)) === "managed",
    );
    if (managedProfiles.length === 1) {
      const managedProfile = managedProfiles[0];
      return { userId: managedProfile.userId, source: "managedProfile" };
    }

    if (managedProfiles.length > 1) {
      throw new Error(
        `Android target user is ambiguous: ${managedProfiles.length} managed profiles are running`,
      );
    }

    const primary = users.find(
      (user) => user.running && (user.profileType ?? classifyAndroidUser(user.flags)) === "primary",
    );
    if (primary) {
      return { userId: primary.userId, source: "primary" };
    }

    throw new Error(
      "Android target user is unavailable: no running primary or uniquely selectable managed profile",
    );
  }
}
