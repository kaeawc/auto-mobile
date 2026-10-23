import { ActionableError, toActionableError } from "../models/ActionableError";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  readdirSync,
  type Stats,
  linkSync,
  mkdtempSync,
  rmdirSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, dirname } from "node:path";
import { ENV, readEnvTrimmed } from "../config/env";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { exponentialBackoff } from "../utils/Backoff";
import { logger } from "../utils/logger";
import { HEARTBEAT_PATH, MCP_STREAMABLE_PATH, resolveDaemonStatePath } from "./constants";
import { readPidFileDataSync } from "./daemonFiles";
import type { PidFileData } from "./types";

const STALE_REMOVAL_CLAIM_MS = 60_000;

export interface DaemonHttpTokenStore {
  write(token: string): void;
  read(): string | undefined;
  remove(): void;
}

/** Tests retain the identifier seam; production uses 256 random bits. */
export function generateDaemonHttpToken(idGen?: IdGenerator): string {
  return idGen ? idGen.next() : randomBytes(32).toString("base64url");
}

export { FakeDaemonHttpTokenStore } from "./FakeDaemonHttpTokenStore";

/** Cleanup operations are injectable; reads retain descriptor validation in production. */
export interface DaemonHttpTokenRemovalFiles {
  createDirectory(prefix: string): string;
  list(path: string): string[];
  inspect(
    path: string,
  ):
    | Pick<Stats, "isFile" | "isDirectory" | "isSymbolicLink" | "uid" | "mode" | "mtimeMs">
    | undefined;
  move(source: string, destination: string): void;
  read(path: string): string | undefined;
  restore(source: string, destination: string): void;
  remove(path: string): void;
  removeDirectory(path: string): void;
}

interface FileDaemonHttpTokenStoreOptions {
  removalFiles?: DaemonHttpTokenRemovalFiles;
  platform?: NodeJS.Platform;
  renameFile?: (source: string, destination: string) => void;
  sleep?: (ms: number) => void;
  now?: () => number;
}

/** Atomic publication; readers validate the opened inode, not a prior path stat. */
export class FileDaemonHttpTokenStore implements DaemonHttpTokenStore {
  private publishedToken: string | undefined;
  private readonly removalFiles: DaemonHttpTokenRemovalFiles;
  private readonly platform: NodeJS.Platform;
  private readonly renameFile: (source: string, destination: string) => void;
  private readonly sleep: (ms: number) => void;
  private readonly now: () => number;

  constructor(
    private readonly path = resolveDaemonStatePath("token"),
    private readonly idGen: IdGenerator = defaultIdGenerator,
    options: FileDaemonHttpTokenStoreOptions = {},
  ) {
    this.removalFiles = options.removalFiles ?? {
      createDirectory: mkdtempSync,
      list: readdirSync,
      inspect: (path) => lstatSync(path, { throwIfNoEntry: false }),
      move: (source, destination) => {
        this.assertTarget(source);
        renameSync(source, destination);
      },
      read: (path) => this.readAt(path),
      restore: linkSync,
      remove: unlinkSync,
      removeDirectory: rmdirSync,
    };
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
    this.renameFile = options.renameFile ?? renameSync;
    this.sleep =
      options.sleep ??
      ((ms) => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      });
  }

  private assertTarget(path = this.path): void {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
      throw new Error("Unsafe daemon HTTP token file");
    }
  }

  /** Identity and content of the public path; compared across the Windows retry backoff. */
  private observeDestination(): string {
    const stat = lstatSync(this.path, { throwIfNoEntry: false });
    if (!stat) {
      return "absent";
    }
    return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, this.readAt(this.path)]);
  }

  private publish(temporaryPath: string): void {
    // Another daemon may publish during a backoff; a rename after that would overwrite
    // its token. Pin what was observed up front and abort rather than replace anything else.
    const observed = this.observeDestination();
    // Brief Windows sharing/antivirus locks can outlive a reader's close. Bound the
    // synchronous wait to five attempts (150 ms total); never write the token in place.
    const backoff = exponentialBackoff({ initialDelayMs: 10, maxDelayMs: 100 });
    for (let attempt = 1; ; attempt++) {
      this.assertTarget();
      if (attempt > 1 && this.observeDestination() !== observed) {
        throw new ActionableError(
          "Daemon HTTP token file changed while publication was retrying; another daemon may own it",
        );
      }
      try {
        this.renameFile(temporaryPath, this.path);
        return;
      } catch (error) {
        const code = error instanceof Error && "code" in error ? error.code : undefined;
        if (
          this.platform !== "win32" ||
          attempt >= 5 ||
          (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")
        ) {
          throw toActionableError(error, "Unable to persist daemon HTTP token");
        }
        // Sharing violations are expected transient contention; the outer write reports failure.
        logger.debug("Retrying daemon HTTP token publication after a sharing violation");
        this.sleep(backoff.delayForAttempt(attempt));
      }
    }
  }

  write(token: string): void {
    const temporaryPath = `${this.path}.${this.idGen.next()}.tmp`;
    let created = false;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      this.assertTarget();
      const fd = openSync(temporaryPath, "wx", 0o600);
      created = true;
      try {
        if (process.platform !== "win32") {
          fchmodSync(fd, 0o600);
        }
        writeFileSync(fd, token, "utf8");
      } finally {
        closeSync(fd);
      }
      this.publish(temporaryPath);
      created = false;
      this.publishedToken = token.trim();
      this.sweepRemovalDirectories();
    } catch (error) {
      logger.warn("Unable to persist daemon HTTP token");
      throw toActionableError(error, "Unable to persist daemon HTTP token");
    } finally {
      if (created) {
        try {
          rmSync(temporaryPath, { force: true });
        } catch {
          // Rename normally consumes the temporary file; cleanup is best effort.
          logger.debug("Daemon HTTP token temporary file cleanup unavailable");
        }
      }
    }
  }

  read(): string | undefined {
    return this.readAt(this.path);
  }

  private readAt(path: string): string | undefined {
    let fd: number | undefined;
    try {
      this.assertTarget(path);
      fd = openSync(
        path,
        constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
      );
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        (process.platform !== "win32" &&
          (stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600))
      ) {
        logger.debug("Daemon HTTP token file permissions unavailable");
        return undefined;
      }
      return readFileSync(fd, "utf8").trim() || undefined;
    } catch {
      // Missing or unsafe runtime files are expected for clients before daemon startup.
      logger.debug("Daemon HTTP token file unavailable");
      return undefined;
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Client discovery is best effort even if closing the runtime file fails.
          logger.debug("Daemon HTTP token file close unavailable");
        }
      }
    }
  }

  private cleanClaim(directory: string): void {
    const files = this.removalFiles;
    try {
      // unlink never follows the claimed entry. Windows open handles may prevent deletion;
      // cleanup is best effort, and a later publication sweeps the private directory again.
      files.remove(`${directory}/token`);
    } catch {
      // Missing claims and Windows sharing locks are expected during cleanup.
      logger.debug("Daemon HTTP token claim cleanup unavailable");
    }
    try {
      files.removeDirectory(directory);
    } catch {
      // Do not recursively remove unrelated entries from a private directory.
      logger.debug("Daemon HTTP token removal directory cleanup unavailable");
    }
  }

  private isStaleRemovalDirectory(
    stat: ReturnType<DaemonHttpTokenRemovalFiles["inspect"]>,
  ): boolean {
    return (
      !!stat?.isDirectory() &&
      !stat.isSymbolicLink() &&
      // A live remove() may be holding the successor's token until it can restore it.
      Number.isFinite(stat.mtimeMs) &&
      stat.mtimeMs < this.now() - STALE_REMOVAL_CLAIM_MS &&
      (this.platform === "win32" ||
        (stat.uid === process.getuid?.() && (stat.mode & 0o7777) === 0o700))
    );
  }

  private sweepRemovalDirectories(): void {
    const files = this.removalFiles;
    try {
      const parent = dirname(this.path);
      const prefix = `${basename(this.path)}.remove-`;
      for (const name of files.list(parent)) {
        if (!name.startsWith(prefix) || !/^[A-Za-z0-9]{6}$/.test(name.slice(prefix.length))) {
          continue;
        }
        const directory = join(parent, name);
        const stat = files.inspect(directory);
        if (this.isStaleRemovalDirectory(stat)) {
          this.cleanClaim(directory);
        }
      }
    } catch {
      // Stale cleanup must not prevent publication; no credential values enter diagnostics.
      logger.debug("Daemon HTTP token stale claim cleanup unavailable");
    }
  }

  remove(): void {
    const token = this.publishedToken;
    this.publishedToken = undefined;
    if (!token) {
      return;
    }
    const files = this.removalFiles;
    let directory: string | undefined;
    try {
      directory = files.createDirectory(`${this.path}.remove-`);
      const moved = `${directory}/token`;
      // Rename claims one directory entry atomically. A later publication stays at the public path.
      files.move(this.path, moved);
      if (!tokensEqual(files.read(moved) ?? "", token)) {
        // Never relink a swapped symlink: macOS link() follows symbolic links.
        const stat = files.inspect(moved);
        if (stat?.isFile() && !stat.isSymbolicLink()) {
          // link is no-replace. A failed restore must still discard the private claim.
          files.restore(moved, this.path);
        }
      }
    } catch {
      // Missing files, sharing locks, and a newer publication are expected during shutdown.
      logger.debug("Daemon HTTP token file removal unavailable");
    } finally {
      if (directory) {
        this.cleanClaim(directory);
      }
    }
  }
}

export function readDaemonHttpToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    return (
      readEnvTrimmed(ENV.DAEMON_HTTP_TOKEN, env) ||
      new FileDaemonHttpTokenStore(resolveDaemonStatePath("token", env)).read()
    );
  } catch {
    // Client discovery must remain best effort, including invalid path overrides.
    logger.debug("Daemon HTTP token unavailable");
    return undefined;
  }
}

const DAEMON_ROUTES: readonly string[] = [MCP_STREAMABLE_PATH, HEARTBEAT_PATH];

/**
 * The daemon HTTP port recorded in its PID file, or null when the file is absent,
 * unreadable, or carries no valid port. Best effort: never throws, never logs token data.
 */
export function readDaemonPidFilePort(
  env: NodeJS.ProcessEnv = process.env,
  readPid: (pidFilePath: string) => PidFileData | null = readPidFileDataSync,
): number | null {
  try {
    const port = readPid(resolveDaemonStatePath("pid", env))?.port;
    return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535
      ? port
      : null;
  } catch (error) {
    // Client discovery is best effort; an unverifiable port is treated as undiscovered.
    logger.debug(`Daemon PID file port unavailable: ${error}`);
    return null;
  }
}

/**
 * The daemon credential scope: an exact loopback host, an explicit port, and one of the
 * daemon's own routes. When the daemon's pid-file port is known (`discoveredPort`) the URL
 * port must equal it; with no discoverable port any explicit port passes. Other 127/8 and
 * IPv4-mapped IPv6 addresses are excluded.
 */
export function isDaemonHttpEndpoint(
  endpoint: string | URL,
  discoveredPort: number | null = null,
): boolean {
  // WHATWG URL objects discard original host spelling (127.1 becomes 127.0.0.1,
  // %6Cocalhost becomes localhost) and drop default ports. Require the original string.
  if (typeof endpoint !== "string") {
    return false;
  }
  const match =
    /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/?#]*@)?(?:localhost|127\.0\.0\.1|\[::1\]):([0-9]{1,5})(\/[^?#]*)?(?:[?#]|$)/i.exec(
      endpoint,
    );
  if (!match) {
    return false;
  }
  const scheme = match[1]!.toLowerCase();
  const port = Number(match[2]);
  return (
    (scheme === "http" || scheme === "https") &&
    port >= 1 &&
    port <= 65535 &&
    DAEMON_ROUTES.includes(match[3] ?? "") &&
    (discoveredPort === null || port === discoveredPort)
  );
}

export function daemonHttpAuthHeaders(
  endpoint: string | URL,
  env: NodeJS.ProcessEnv = process.env,
  headers: Record<string, string> = {},
  discoverPort: (env: NodeJS.ProcessEnv) => number | null = readDaemonPidFilePort,
): Record<string, string> {
  if (
    Object.keys(headers).some((key) => key.toLowerCase() === "authorization") ||
    // Only read the pid file for URLs that already have daemon shape.
    !isDaemonHttpEndpoint(endpoint) ||
    !isDaemonHttpEndpoint(endpoint, discoverPort(env))
  ) {
    return { ...headers };
  }
  const token = readDaemonHttpToken(env);
  return token ? { ...headers, Authorization: `Bearer ${token}` } : { ...headers };
}

export function verifyBearerToken(headerValue: string | undefined, expected: string): boolean {
  const candidate =
    headerValue?.slice(0, 7).toLowerCase() === "bearer " ? headerValue.slice(7) : "";
  return tokensEqual(candidate, expected);
}

function tokensEqual(candidate: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const equal = timingSafeEqual(digest(candidate), digest(expected));
  return equal && candidate.length > 0 && expected.length > 0;
}
