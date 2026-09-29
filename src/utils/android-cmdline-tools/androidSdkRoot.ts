export interface AndroidSdkEnvironment {
  ANDROID_HOME?: string;
  ANDROID_SDK_ROOT?: string;
  ANDROID_SDK_HOME?: string;
}

type AndroidSdkRootCheck = (path: string) => boolean;
type AndroidSdkRootCheckAsync = (path: string) => Promise<boolean>;

function androidSdkRootCandidates(environment: AndroidSdkEnvironment): string[] {
  return [environment.ANDROID_HOME, environment.ANDROID_SDK_ROOT, environment.ANDROID_SDK_HOME]
    .map((candidate) => candidate?.trim())
    .filter((candidate): candidate is string => Boolean(candidate));
}

/** Resolve an SDK root using the shared ANDROID_HOME, SDK_ROOT, SDK_HOME precedence. */
export function resolveAndroidSdkRoot(
  environment: AndroidSdkEnvironment,
  pathExists?: AndroidSdkRootCheck,
): string | undefined {
  return androidSdkRootCandidates(environment).find(
    (candidate) => !pathExists || pathExists(candidate),
  );
}

/** Async counterpart for callers that already use asynchronous filesystem checks. */
export async function resolveAndroidSdkRootAsync(
  environment: AndroidSdkEnvironment,
  pathExists: AndroidSdkRootCheckAsync,
): Promise<string | undefined> {
  for (const candidate of androidSdkRootCandidates(environment)) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
