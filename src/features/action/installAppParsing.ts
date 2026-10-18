import path from "path";
import { errorMessage } from "../../utils/describeUnknownError";

export function extractErrorText(error: unknown): string {
  if (error instanceof Error) {
    const details = error as Error & { stderr?: unknown; stdout?: unknown };
    return [error.message, details.stderr, details.stdout]
      .filter((value) => typeof value === "string" && value.length > 0)
      .join("\n");
  }
  return String(error);
}

/**
 * The part of an iOS install failure that the tool itself printed, for classification only.
 * The rejection's `message` is `Command failed: <argv>` plus stderr, and the argv carries the
 * user's artifact path, so searching it would match a path such as `build/downgrade-test/`.
 * Prefer stderr/stdout (walking `cause` for wrapped errors); when none is attached, drop the
 * command line from the message. Either way the artifact path (and its basename) is removed,
 * because the tool may echo it in its own output.
 */
export function iosToolOutput(error: unknown, artifactPath: string): string {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const details = current as Error & { stderr?: unknown; stdout?: unknown };
    const streams = [details.stderr, details.stdout].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    if (streams.length > 0) {
      return withoutArtifactPath(streams.join("\n"), artifactPath);
    }
    current = current.cause;
  }
  return withoutArtifactPath(
    errorMessage(error)
      .split("\n")
      .filter((line) => !line.includes("Command failed:"))
      .join("\n"),
    artifactPath,
  );
}

/** Remove the artifact path, and its basename, so a tool that echoes either cannot match a keyword. */
export function withoutArtifactPath(text: string, artifactPath: string): string {
  const withoutPath = text.split(artifactPath).join("");
  const base = path.basename(artifactPath);
  return base.length > 0 ? withoutPath.split(base).join("") : withoutPath;
}

/**
 * Detect an iOS install failure caused by the installed version being newer
 * than the artifact (simctl/devicectl downgrade rejection).
 */
export function isiOSDowngradeError(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.includes("downgrade")) {
    return true;
  }
  return lower.includes("newer version") && lower.includes("already installed");
}

export function diffSets(before: Set<string>, after: Set<string>): string[] {
  const added: string[] = [];
  for (const item of after) {
    if (!before.has(item)) {
      added.push(item);
    }
  }
  return added.sort();
}

export function extractBundleIds(apps: any[]): Set<string> {
  const bundleIds = new Set<string>();
  for (const app of apps) {
    const bundleId = getBundleId(app);
    if (bundleId) {
      bundleIds.add(bundleId);
    }
  }
  return bundleIds;
}

export function getBundleId(app: any): string | undefined {
  if (!app || typeof app !== "object") {
    return undefined;
  }
  if (typeof app.bundleId === "string" && app.bundleId.trim().length > 0) {
    return app.bundleId;
  }
  if (typeof app.bundleIdentifier === "string" && app.bundleIdentifier.trim().length > 0) {
    return app.bundleIdentifier;
  }
  if (typeof app.CFBundleIdentifier === "string" && app.CFBundleIdentifier.trim().length > 0) {
    return app.CFBundleIdentifier;
  }
  return undefined;
}

export function findBundleIdByPath(apps: any[], appPath: string): string | undefined {
  const normalizedPath = path.resolve(appPath);
  for (const app of apps) {
    if (!app || typeof app !== "object") {
      continue;
    }
    const bundleId = getBundleId(app);
    if (!bundleId) {
      continue;
    }
    const bundlePath =
      typeof app.bundlePath === "string"
        ? app.bundlePath
        : typeof app.path === "string"
          ? app.path
          : undefined;
    if (!bundlePath) {
      continue;
    }
    if (path.resolve(bundlePath) === normalizedPath) {
      return bundleId;
    }
  }
  return undefined;
}
