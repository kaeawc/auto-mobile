import type { AdbExecutor } from "./interfaces/AdbExecutor";

export type UserTargetSource =
  | "explicit"
  | "foregroundPackage"
  | "managedProfile"
  | "primaryFallback";

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
 * by a running managed profile and finally the primary user. A secondary user
 * is never treated as managed solely because its ID is nonzero.
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
    const managedProfile = users.find((user) => user.running && (user.flags & 0x20) !== 0);
    if (managedProfile) {
      return { userId: managedProfile.userId, source: "managedProfile" };
    }

    return { userId: 0, source: "primaryFallback" };
  }
}
