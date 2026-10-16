import * as nodePath from "node:path";

/** The subset of `node:path` containment needs; pass `path.win32`/`path.posix` to pin a flavour. */
export type PathContainmentApi = Pick<
  typeof nodePath.posix,
  "resolve" | "relative" | "isAbsolute" | "sep"
>;

export interface PathContainmentOptions {
  /** Path flavour; defaults to the host's `node:path`. */
  paths?: PathContainmentApi;
  /** Whether `target === root` counts as inside. Defaults to true. */
  allowEqual?: boolean;
}

/**
 * True when `target` (resolved against `root` when relative) is `root` or lies below it.
 *
 * Purely lexical: `..` segments and separators are normalised through `path.relative`, which
 * also applies the flavour's case rules (case-insensitive on win32) and rejects other drives.
 * It does NOT resolve symlinks, so callers that act on the filesystem must still guard those.
 * A sibling that merely shares a name prefix (`/a/b-evil` vs `/a/b`) is outside.
 */
export function isPathInside(
  root: string,
  target: string,
  options: PathContainmentOptions = {},
): boolean {
  const paths = options.paths ?? nodePath;
  const resolvedRoot = paths.resolve(root);
  const resolved = paths.resolve(resolvedRoot, target);
  const relative = paths.relative(resolvedRoot, resolved);
  if (relative === "") {
    return options.allowEqual ?? true;
  }
  return !(
    relative === ".." ||
    relative.startsWith(`..${paths.sep}`) ||
    paths.isAbsolute(relative)
  );
}

/**
 * Resolve `target` against `root` and return the absolute path, or throw `onEscape()`'s error when
 * it falls outside. Callers supply the error so each boundary keeps its own message and type.
 */
export function assertPathInside(
  root: string,
  target: string,
  onEscape: () => Error,
  options: PathContainmentOptions = {},
): string {
  if (!isPathInside(root, target, options)) {
    throw onEscape();
  }
  const paths = options.paths ?? nodePath;
  return paths.resolve(paths.resolve(root), target);
}
