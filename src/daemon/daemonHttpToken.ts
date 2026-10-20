import { toActionableError } from "../models/ActionableError";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
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
import { dirname } from "node:path";
import { ENV, readEnvTrimmed } from "../config/env";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { exponentialBackoff } from "../utils/Backoff";
import { logger } from "../utils/logger";
import { resolveDaemonStatePath } from "./constants";

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

/** Only removal operations are injectable; reads retain descriptor validation in production. */
export interface DaemonHttpTokenRemovalFiles {
  createDirectory(prefix: string): string;
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
}

/** Atomic publication; readers validate the opened inode, not a prior path stat. */
export class FileDaemonHttpTokenStore implements DaemonHttpTokenStore {
  private publishedToken: string | undefined;
  private readonly removalFiles: DaemonHttpTokenRemovalFiles;
  private readonly platform: NodeJS.Platform;
  private readonly renameFile: (source: string, destination: string) => void;
  private readonly sleep: (ms: number) => void;

  constructor(
    private readonly path = resolveDaemonStatePath("token"),
    private readonly idGen: IdGenerator = defaultIdGenerator,
    options: FileDaemonHttpTokenStoreOptions = {},
  ) {
    this.removalFiles = options.removalFiles ?? {
      createDirectory: mkdtempSync,
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

  private publish(temporaryPath: string): void {
    // Brief Windows sharing/antivirus locks can outlive a reader's close. Bound the
    // synchronous wait to five attempts (150 ms total); never write the token in place.
    const backoff = exponentialBackoff({ initialDelayMs: 10, maxDelayMs: 100 });
    for (let attempt = 1; ; attempt++) {
      this.assertTarget();
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

  remove(): void {
    const token = this.publishedToken;
    this.publishedToken = undefined;
    if (!token) {
      return;
    }
    const files = this.removalFiles;
    let directory: string | undefined;
    let retained = false;
    try {
      directory = files.createDirectory(`${this.path}.remove-`);
      const moved = `${directory}/token`;
      // Rename claims one directory entry atomically. A later publication stays at the public path.
      // Windows sharing violations leave that path untouched; shutdown cleanup is best effort.
      files.move(this.path, moved);
      retained = true;
      if (!tokensEqual(files.read(moved) ?? "", token)) {
        // link is no-replace on POSIX and Windows. If another publication already occupies the
        // path, preserve the claimed file in its private directory rather than replacing either.
        files.restore(moved, this.path);
      }
      files.remove(moved);
      retained = false;
    } catch {
      // Missing files, sharing locks, and a newer publication are expected during shutdown.
      logger.debug("Daemon HTTP token file removal unavailable");
    } finally {
      if (directory && !retained) {
        try {
          files.removeDirectory(directory);
        } catch {
          // A private empty cleanup directory may remain after best-effort shutdown.
          logger.debug("Daemon HTTP token removal directory cleanup unavailable");
        }
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

/** Exact loopback names only; other 127/8 and IPv4-mapped IPv6 addresses are excluded. */
export function isDaemonHttpEndpoint(endpoint: string | URL): boolean {
  const url = URL.parse(String(endpoint));
  // WHATWG normalizes numeric aliases and expanded IPv6. For string inputs also require
  // an explicit allowlisted authority spelling, retaining URL parsing as the validity check.
  const literalHost =
    typeof endpoint !== "string" ||
    /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:[/?#]|$)/i.test(
      endpoint,
    );
  return (
    literalHost &&
    !!url &&
    (url.protocol === "http:" || url.protocol === "https:") &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase())
  );
}

export function daemonHttpAuthHeaders(
  endpoint: string | URL,
  env: NodeJS.ProcessEnv = process.env,
  headers: Record<string, string> = {},
): Record<string, string> {
  if (
    !isDaemonHttpEndpoint(endpoint) ||
    Object.keys(headers).some((key) => key.toLowerCase() === "authorization")
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
