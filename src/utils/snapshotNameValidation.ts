import * as path from "path";
import { ActionableError } from "../models";

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
  const reject = (reason: string): never => {
    throw new ActionableError(
      `Invalid snapshot name '${snapshotName}': ${reason}. Use a single name segment ` +
        "without path separators, '.'/'..', or an absolute path.",
    );
  };

  if (typeof snapshotName !== "string" || snapshotName.trim().length === 0) {
    reject("name must be a non-empty string");
    return;
  }

  // NUL can truncate a path in native syscalls, hiding the real target.
  if (snapshotName.includes("\0")) {
    reject("name contains a NUL byte");
    return;
  }

  // Any separator (POSIX '/' or Windows '\\') makes the name more than one path
  // segment — this catches 'a/b' and the leading separator of most absolute
  // paths — so joining it can descend into or escape the snapshots directory.
  if (snapshotName.includes("/") || snapshotName.includes("\\")) {
    reject("name contains a path separator");
    return;
  }

  // '.' and '..' as the whole name are the traversal primitives that have no
  // separator of their own; '..' escapes the snapshots directory outright.
  if (snapshotName === "." || snapshotName === "..") {
    reject("name is a path traversal segment");
    return;
  }

  // Absolute paths (including Windows drive-letter forms like 'C:\\x' that
  // survive the separator check on POSIX) must never be joined onto basePath.
  if (path.isAbsolute(snapshotName) || path.win32.isAbsolute(snapshotName)) {
    reject("name is an absolute path");
    return;
  }
}
