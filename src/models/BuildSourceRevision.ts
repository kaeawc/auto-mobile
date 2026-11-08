/**
 * Git source revision an app build declares about itself (#16954): display metadata
 * only. Build-key identity stays (appId, versionCode, contentHash); a revision never
 * participates in matching or diffing.
 */
export interface BuildSourceRevision {
  gitBranch: string;
  /** Lower-case hex commit sha (7–64 chars). */
  gitSha: string;
}

/** Android manifest `<meta-data>` name and iOS Info.plist key for the branch. */
export const BUILD_GIT_BRANCH_KEY = "dev.jasonpearson.automobile.build.gitBranch";
/** Android manifest `<meta-data>` name and iOS Info.plist key for the commit sha. */
export const BUILD_GIT_SHA_KEY = "dev.jasonpearson.automobile.build.gitSha";

const MAX_BRANCH_LENGTH = 255;
const SHA_PATTERN = /^[0-9a-f]{7,64}$/;
// C0/C1 controls would corrupt labels and log lines.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Validate an app-declared branch/sha pair. Both values must be present: a partial or
 * malformed declaration yields `undefined`, so the build keeps its version/hash label.
 */
export function parseBuildSourceRevision(
  gitBranch: unknown,
  gitSha: unknown,
): BuildSourceRevision | undefined {
  if (typeof gitBranch !== "string" || typeof gitSha !== "string") {
    return undefined;
  }
  const branch = gitBranch.trim();
  const sha = gitSha.trim().toLowerCase();
  if (
    branch.length === 0 ||
    branch.length > MAX_BRANCH_LENGTH ||
    CONTROL_CHARS.test(branch) ||
    !SHA_PATTERN.test(sha)
  ) {
    return undefined;
  }
  return { gitBranch: branch, gitSha: sha };
}

/** Whether two optional revisions are the same (both absent counts as equal). */
export function sameBuildSourceRevision(
  a: BuildSourceRevision | undefined,
  b: BuildSourceRevision | undefined,
): boolean {
  return a?.gitBranch === b?.gitBranch && a?.gitSha === b?.gitSha;
}
