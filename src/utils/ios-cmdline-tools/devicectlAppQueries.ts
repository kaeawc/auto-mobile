import { normalizeIosDevicePath as normalizeDevicePath } from "./iosInstalledApp";

const bundleIdentifier = (record: Record<string, unknown>): unknown => {
  return (
    record.bundleIdentifier ??
    record.bundleID ??
    record.bundleId ??
    record.CFBundleIdentifier ??
    record.BUNDLE_IDENTIFIER
  );
};

export const findBundleEntry = (
  data: unknown,
  bundleId: string,
): Record<string, unknown> | null => {
  if (!data || typeof data !== "object") {
    return null;
  }
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findBundleEntry(item, bundleId);
      if (found) {
        return found;
      }
    }
    return null;
  }

  const record = data as Record<string, unknown>;
  const idValue = bundleIdentifier(record);
  if (typeof idValue === "string" && idValue === bundleId) {
    return record;
  }

  for (const value of Object.values(record)) {
    const found = findBundleEntry(value, bundleId);
    if (found) {
      return found;
    }
  }
  return null;
};

/**
 * Pull the installed-app records out of a `devicectl device info apps`
 * payload. devicectl nests the listing under `result.apps`, while the
 * `--bundle-id` shape used elsewhere in this module (and the fixtures that
 * pin it) writes a bare `{ apps: [...] }`. Search for the first `apps` array
 * either way rather than hardcoding one envelope, and drop non-object
 * members so callers can treat every entry as a record.
 *
 * Returns null when the payload carries no `apps` array at all, or carries one
 * whose members are all unreadable — those are payloads this code does not
 * understand, which must not be reported as the device having no apps
 * installed. An `apps` array that is present but empty returns `[]`, because
 * that genuinely means "nothing installed".
 */
export const extractInstalledAppEntries = (data: unknown): Record<string, unknown>[] | null => {
  if (!data || typeof data !== "object") {
    return null;
  }
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = extractInstalledAppEntries(item);
      if (found) {
        return found;
      }
    }
    return null;
  }

  const record = data as Record<string, unknown>;
  if (Array.isArray(record.apps)) {
    const entries = record.apps.filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
    );
    // An array that carried members but none we can read is a payload shape we
    // do not understand; only an originally empty array means "nothing installed".
    if (entries.length === 0 && record.apps.length > 0) {
      return null;
    }
    return entries;
  }

  for (const value of Object.values(record)) {
    const found = extractInstalledAppEntries(value);
    if (found) {
      return found;
    }
  }
  return null;
};

export const extractBundlePath = (entry: Record<string, unknown>): string | null => {
  const candidates = [
    entry.bundleURL,
    entry.bundlePath,
    entry.bundleURLString,
    entry.bundle_url,
    entry.bundle_path,
    entry.url,
    entry.path,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      return normalizeDevicePath(candidate);
    }
  }
  return null;
};

/**
 * Recursively find the launched process's `processIdentifier` in a devicectl
 * `process launch --json-output` payload. The stable location is
 * `result.process.processIdentifier`; we prefer it and fall back to a deep
 * search so a devicectl-version reshuffle of the envelope still yields the PID.
 */
export const findProcessIdentifier = (data: unknown): number | undefined => {
  const direct = (data as { result?: { process?: { processIdentifier?: unknown } } })?.result
    ?.process?.processIdentifier;
  if (typeof direct === "number") {
    return direct;
  }

  const walk = (node: unknown): number | undefined => {
    if (!node || typeof node !== "object") {
      return undefined;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item);
        if (found !== undefined) {
          return found;
        }
      }
      return undefined;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.processIdentifier === "number") {
      return record.processIdentifier;
    }
    for (const value of Object.values(record)) {
      const found = walk(value);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  };
  return walk(data);
};

const extractExecutablePath = (record: Record<string, unknown>): string | null => {
  const raw = record.executable ?? record.executablePath ?? record.executableURL ?? record.path;
  if (typeof raw === "string") {
    return normalizeDevicePath(raw);
  }
  if (raw && typeof raw === "object") {
    const inner = (raw as Record<string, unknown>).url ?? (raw as Record<string, unknown>).path;
    if (typeof inner === "string") {
      return normalizeDevicePath(inner);
    }
  }
  return null;
};

const extractProcessPid = (record: Record<string, unknown>): number | undefined => {
  const raw = record.processIdentifier ?? record.pid ?? record.processID;
  if (typeof raw === "number" && Number.isInteger(raw)) {
    return raw;
  }
  // devicectl JSON is unverified; tolerate a stringified integer PID too.
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    return Number(raw.trim());
  }
  return undefined;
};

/** Basename of a path (last `/`-separated segment), ignoring any trailing slash. */
const pathBasename = (path: string): string => {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
};

/**
 * Find the PID of the app's **own** main process from a devicectl
 * `device info processes --json-output` payload, given its installed
 * `bundlePath`.
 *
 * The exact envelope is not formally documented by Apple (see simctl.md caveat),
 * so we deep-walk and accept several field-name spellings: the executable may be
 * a string or an object carrying `url`/`path`, and the PID may be spelled
 * `processIdentifier`, `pid`, or `processID`.
 *
 * Matching is deliberately scoped to the **main app binary**, which is a *direct
 * child* of the `.app` directory (`MyApp.app/MyApp` — CFBundleExecutable, whose
 * name may differ from the bundle name, but always one level down). App
 * extensions live *inside* the same bundle at `MyApp.app/PlugIns/Foo.appex/Foo`
 * and their executables also start with `"<bundle>/"`, so a naive prefix match
 * would SIGKILL an extension and falsely report the app terminated. We therefore
 * require the path segment after `"<bundle>/"` to contain no further `/`. This
 * also excludes a sibling like `MyApp.app.extension/...` (different prefix).
 *
 * Two-pass, per issue #2882: the strict inside-bundle match is preferred, but if
 * it finds nothing we fall back to matching a process whose executable
 * **basename** equals the bundle name (minus `.app`). The fallback guards the
 * real-device risk that `info processes` executable paths don't nest under the
 * `info apps` bundle URL (e.g. `/private` vs `/var` symlink, differing container
 * roots) — without it a mismatch would silently report the app as not running.
 * The basename fallback naturally still excludes extensions (a `Foo.appex`
 * binary's basename won't equal the app name).
 */
export const findRunningProcessPid = (data: unknown, bundlePath: string): number | null => {
  const normalizedBundle = normalizeDevicePath(bundlePath).replace(/\/+$/, "");
  if (!normalizedBundle) {
    return null;
  }
  const insidePrefix = `${normalizedBundle}/`;
  const appName = pathBasename(normalizedBundle).replace(/\.app$/i, "");

  const isMainBinaryOfBundle = (exe: string): boolean => {
    if (!exe.startsWith(insidePrefix)) {
      return false;
    }
    // Direct child only: no further path separator → the app's own binary,
    // not a nested PlugIns/*.appex/* extension executable.
    return !exe.slice(insidePrefix.length).includes("/");
  };

  const walk = (node: unknown, matches: (exe: string) => boolean): number | null => {
    if (!node || typeof node !== "object") {
      return null;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item, matches);
        if (found !== null) {
          return found;
        }
      }
      return null;
    }
    const record = node as Record<string, unknown>;
    const exe = extractExecutablePath(record);
    const pid = extractProcessPid(record);
    if (exe !== null && pid !== undefined && matches(exe)) {
      return pid;
    }
    for (const value of Object.values(record)) {
      const found = walk(value, matches);
      if (found !== null) {
        return found;
      }
    }
    return null;
  };

  const primary = walk(data, isMainBinaryOfBundle);
  if (primary !== null) {
    return primary;
  }
  if (!appName) {
    return null;
  }
  return walk(data, (exe) => pathBasename(exe) === appName);
};
