import * as path from "path";
import { ActionableError } from "../models";

/**
 * Reject a path segment that could escape its intended parent directory once
 * joined onto it with `path.join`. Shared by {@link assertSafeSnapshotName}
 * (the snapshot name itself) and any other single path segment that is joined
 * onto `DeviceSnapshotStore`'s base directory without going through name
 * validation — e.g. the Android AVD name / iOS device UDID segments
 * `getSnapshotPathWithOptions` scopes snapshots by, which come from external
 * tool output (`adb emu avd name`, simctl) rather than a validated
 * caller-supplied name (issue #6493).
 *
 * `kind` is a human-readable label (e.g. "snapshot name", "Android AVD name")
 * used only in the thrown message, so one canonical check backs every path
 * segment this codebase joins onto a base directory rather than a second copy
 * per call site.
 *
 * The segment must be a single, non-empty path segment made of ordinary
 * characters — no separators, no `.`/`..`, no NUL, no absolute path.
 */
export function assertSafePathSegment(kind: string, value: string): void {
  const reject = (reason: string): never => {
    throw new ActionableError(
      `Invalid ${kind} '${value}': ${reason}. Use a single path segment ` +
        "without path separators, '.'/'..', or an absolute path.",
    );
  };

  if (typeof value !== "string" || value.trim().length === 0) {
    reject(`${kind} must be a non-empty string`);
    return;
  }

  // NUL can truncate a path in native syscalls, hiding the real target.
  if (value.includes("\0")) {
    reject(`${kind} contains a NUL byte`);
    return;
  }

  // Any separator (POSIX '/' or Windows '\\') makes the value more than one
  // path segment — this catches 'a/b' and the leading separator of most
  // absolute paths — so joining it can descend into or escape the base
  // directory.
  if (value.includes("/") || value.includes("\\")) {
    reject(`${kind} contains a path separator`);
    return;
  }

  // '.' and '..' as the whole value are the traversal primitives that have no
  // separator of their own; '..' escapes the base directory outright.
  if (value === "." || value === "..") {
    reject(`${kind} is a path traversal segment`);
    return;
  }

  // Absolute paths (including Windows drive-letter forms like 'C:\\x' that
  // survive the separator check on POSIX) must never be joined onto a base
  // directory.
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    reject(`${kind} is an absolute path`);
    return;
  }
}

/**
 * Reject a `snapshotName` that could escape the snapshots directory before it
 * reaches any filesystem path or emulator/simulator command.
 *
 * `DeviceSnapshotStore` builds every on-disk path with `path.join(basePath,
 * snapshotName, …)`, and the Android VM path forwards the raw name to
 * `adb emu avd snapshot save <name>`. A name containing a path separator, a `.`
 * or `..` segment, or an absolute path therefore writes (or saves a VM snapshot)
 * outside the intended directory (issue #5705). We reject rather than silently
 * slugify: a silent rename would hide the caller's mistake and could still
 * collide with an existing snapshot.
 *
 * The snapshot name must be a single, non-empty path segment made of ordinary
 * characters — no separators, no `.`/`..`, no NUL, no absolute path.
 */
export function assertSafeSnapshotName(snapshotName: string): void {
  assertSafePathSegment("snapshot name", snapshotName);
}
