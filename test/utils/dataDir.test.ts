import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ActionableError } from "../../src/models/ActionableError";
import {
  resolveAutoMobileBaseDir,
  resolveAutoMobileLogsDir,
  getTempDir,
  ensureSecureLogsDirSync,
  ensureSecureTempDirSync,
  TEMP_SUBDIRS,
} from "../../src/utils/tempDir";

describe("resolveAutoMobileBaseDir", () => {
  const home = "/home/tester";

  test("prefers AUTOMOBILE_DATA_DIR override, resolved to absolute", () => {
    expect(resolveAutoMobileBaseDir({ AUTOMOBILE_DATA_DIR: "/srv/automobile" }, home)).toBe(
      path.resolve("/srv/automobile"),
    );
  });

  test("honors AUTO_MOBILE_DATA_DIR alias", () => {
    expect(resolveAutoMobileBaseDir({ AUTO_MOBILE_DATA_DIR: "/srv/alias" }, home)).toBe(
      path.resolve("/srv/alias"),
    );
  });

  test("AUTOMOBILE_DATA_DIR wins over the alias", () => {
    expect(
      resolveAutoMobileBaseDir(
        { AUTOMOBILE_DATA_DIR: "/primary", AUTO_MOBILE_DATA_DIR: "/alias" },
        home,
      ),
    ).toBe(path.resolve("/primary"));
  });

  test("resolves a relative override against the daemon launch directory", () => {
    expect(
      resolveAutoMobileBaseDir(
        {
          AUTOMOBILE_DATA_DIR: "rel/data",
          AUTOMOBILE_DAEMON_LAUNCH_CWD: "/injected-launch",
        },
        home,
      ),
    ).toBe(path.resolve("/injected-launch", "rel/data"));
  });

  test("ignores a blank override and uses the stable home default", () => {
    expect(resolveAutoMobileBaseDir({ AUTOMOBILE_DATA_DIR: "   " }, home)).toBe(
      path.join(home, ".auto-mobile"),
    );
  });

  test("defaults to ~/.auto-mobile, never under os.tmpdir()", () => {
    const base = resolveAutoMobileBaseDir({}, home);
    expect(base).toBe(path.join(home, ".auto-mobile"));
    expect(base.startsWith(os.tmpdir())).toBe(false);
  });

  test("anchors a relative home directory to the daemon launch directory", () => {
    expect(resolveAutoMobileBaseDir({}, "relative-home", "/launch")).toBe(
      path.resolve("/launch", "relative-home", ".auto-mobile"),
    );
  });

  test("falls back to os.tmpdir()/auto-mobile only when no home dir is available", () => {
    expect(resolveAutoMobileBaseDir({}, "")).toBe(path.join(os.tmpdir(), "auto-mobile"));
  });

  test("does not derive the base from TMPDIR/TMP/TEMP env vars", () => {
    const base = resolveAutoMobileBaseDir(
      { TMPDIR: "/ephemeral/bunx-123", TMP: "/ephemeral/bunx-123", TEMP: "/ephemeral/bunx-123" },
      home,
    );
    expect(base).toBe(path.join(home, ".auto-mobile"));
  });
});

describe("resolveAutoMobileLogsDir", () => {
  const home = "/home/tester";

  test("prefers the log override over data-dir and legacy log overrides", () => {
    expect(
      resolveAutoMobileLogsDir(
        {
          AUTOMOBILE_LOG_DIR: "/srv/logs",
          AUTO_MOBILE_LOG_DIR: "/srv/legacy-logs",
          AUTOMOBILE_DATA_DIR: "/srv/data",
        },
        home,
        "/launch",
      ),
    ).toBe(path.resolve("/srv/logs"));
  });

  test("honors the legacy log-dir alias", () => {
    expect(
      resolveAutoMobileLogsDir({ AUTO_MOBILE_LOG_DIR: "/srv/legacy-logs" }, home, "/launch"),
    ).toBe(path.resolve("/srv/legacy-logs"));
  });

  test("resolves relative log overrides from the daemon launch directory", () => {
    expect(resolveAutoMobileLogsDir({ AUTOMOBILE_LOG_DIR: "logs" }, home, "/launch")).toBe(
      path.resolve("/launch", "logs"),
    );
  });

  test("uses the injected launch directory for a relative log override", () => {
    expect(
      resolveAutoMobileLogsDir(
        {
          AUTOMOBILE_LOG_DIR: "logs",
          AUTOMOBILE_DAEMON_LAUNCH_CWD: "/injected-launch",
        },
        home,
      ),
    ).toBe(path.resolve("/injected-launch", "logs"));
  });

  test("falls back to the data-dir logs child for an unset or blank override", () => {
    expect(resolveAutoMobileLogsDir({ AUTOMOBILE_DATA_DIR: "/srv/data" }, home, "/launch")).toBe(
      path.join(path.resolve("/srv/data"), "logs"),
    );
    expect(
      resolveAutoMobileLogsDir(
        { AUTOMOBILE_LOG_DIR: "   ", AUTOMOBILE_DATA_DIR: "/srv/data" },
        home,
        "/launch",
      ),
    ).toBe(path.join(path.resolve("/srv/data"), "logs"));
  });

  test("resolves a relative data-dir fallback from the daemon launch directory", () => {
    expect(resolveAutoMobileLogsDir({ AUTOMOBILE_DATA_DIR: "data" }, home, "/launch")).toBe(
      path.resolve("/launch", "data", "logs"),
    );
  });
});

describe("getTempDir", () => {
  test("derives every subdirectory from the resolved stable base", () => {
    const logs = getTempDir(TEMP_SUBDIRS.LOGS);
    const base = resolveAutoMobileBaseDir();
    expect(logs).toBe(path.join(base, TEMP_SUBDIRS.LOGS));
  });

  test("keeps non-log paths under AUTOMOBILE_DATA_DIR when logs are overridden", () => {
    const previousDataDir = process.env.AUTOMOBILE_DATA_DIR;
    const previousLogDir = process.env.AUTOMOBILE_LOG_DIR;
    process.env.AUTOMOBILE_DATA_DIR = "/srv/data";
    process.env.AUTOMOBILE_LOG_DIR = "/srv/logs";
    try {
      expect(getTempDir(TEMP_SUBDIRS.SCREENSHOTS)).toBe(
        path.join(path.resolve("/srv/data"), "screenshots"),
      );
      expect(getTempDir(TEMP_SUBDIRS.TOOL_LOGS)).toBe(
        path.join(path.resolve("/srv/data"), "tool_logs"),
      );
    } finally {
      if (previousDataDir === undefined) {
        delete process.env.AUTOMOBILE_DATA_DIR;
      } else {
        process.env.AUTOMOBILE_DATA_DIR = previousDataDir;
      }
      if (previousLogDir === undefined) {
        delete process.env.AUTOMOBILE_LOG_DIR;
      } else {
        process.env.AUTOMOBILE_LOG_DIR = previousLogDir;
      }
    }
  });
});

describe("ensureSecureTempDirSync", () => {
  // POSIX-only: Windows does not honor Unix permission bits, so mkdir's `mode`
  // is ignored and `fs.statSync().mode` does not report 0o700 there.
  test.skipIf(process.platform === "win32")(
    "creates the directory with restrictive 0o700 permissions",
    () => {
      // The single-user isolation guarantee in the multi-agent filesystem contract
      // rests on the base dir being mode 0o700; pin it.
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "am-mode-test-"));
      const prev = process.env.AUTOMOBILE_DATA_DIR;
      process.env.AUTOMOBILE_DATA_DIR = tmpBase;
      try {
        const dir = ensureSecureTempDirSync("mode-check");
        // On POSIX, 0o700 survives a typical umask (022) because it sets no
        // group/other bits; assert the created dir's permission bits are exactly 0o700.
        const mode = fs.statSync(dir).mode & 0o777;
        expect(mode).toBe(0o700);
      } finally {
        if (prev === undefined) {
          delete process.env.AUTOMOBILE_DATA_DIR;
        } else {
          process.env.AUTOMOBILE_DATA_DIR = prev;
        }
        fs.rmSync(tmpBase, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "creates an overridden logs directory with restrictive 0o700 permissions",
    () => {
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "am-log-mode-test-"));
      const logDir = path.join(tmpBase, "logs");
      const previousLogDir = process.env.AUTOMOBILE_LOG_DIR;
      process.env.AUTOMOBILE_LOG_DIR = logDir;
      try {
        const dir = ensureSecureLogsDirSync();
        const mode = fs.statSync(dir).mode & 0o777;
        expect(dir).toBe(logDir);
        expect(mode).toBe(0o700);
      } finally {
        if (previousLogDir === undefined) {
          delete process.env.AUTOMOBILE_LOG_DIR;
        } else {
          process.env.AUTOMOBILE_LOG_DIR = previousLogDir;
        }
        fs.rmSync(tmpBase, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "repairs an existing overridden logs directory to 0o700",
    () => {
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "am-log-mode-repair-"));
      const logDir = path.join(tmpBase, "logs");
      const previousLogDir = process.env.AUTOMOBILE_LOG_DIR;
      fs.mkdirSync(logDir, { mode: 0o755 });
      fs.chmodSync(logDir, 0o755);
      process.env.AUTOMOBILE_LOG_DIR = logDir;
      try {
        ensureSecureLogsDirSync();
        expect(fs.statSync(logDir).mode & 0o777).toBe(0o700);
      } finally {
        if (previousLogDir === undefined) {
          delete process.env.AUTOMOBILE_LOG_DIR;
        } else {
          process.env.AUTOMOBILE_LOG_DIR = previousLogDir;
        }
        fs.rmSync(tmpBase, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")("rejects a symbolic-link log directory", () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "am-log-link-"));
    const targetDir = path.join(tmpBase, "target");
    const linkDir = path.join(tmpBase, "logs");
    const previousLogDir = process.env.AUTOMOBILE_LOG_DIR;
    fs.mkdirSync(targetDir);
    fs.symlinkSync(targetDir, linkDir, "dir");
    process.env.AUTOMOBILE_LOG_DIR = linkDir;
    try {
      expect(() => ensureSecureLogsDirSync()).toThrow("symbolic-link directory");
    } finally {
      if (previousLogDir === undefined) {
        delete process.env.AUTOMOBILE_LOG_DIR;
      } else {
        process.env.AUTOMOBILE_LOG_DIR = previousLogDir;
      }
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  test("wraps an unusable log directory with actionable context", () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "am-log-error-test-"));
    const blockingFile = path.join(tmpBase, "not-a-directory");
    fs.writeFileSync(blockingFile, "blocked");

    try {
      ensureSecureLogsDirSync(
        { AUTOMOBILE_LOG_DIR: path.join(blockingFile, "logs") },
        "/home/tester",
      );
      throw new Error("Expected ensureSecureLogsDirSync to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ActionableError);
      expect((error as Error).message).toContain("Set AUTOMOBILE_LOG_DIR to a writable directory");
      expect((error as Error).message).toContain(blockingFile);
      expect((error as Error).cause).toBeInstanceOf(Error);
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});
