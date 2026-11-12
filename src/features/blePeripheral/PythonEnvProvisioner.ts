import { join } from "node:path";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { type HostCommandExecutor } from "../../utils/HostCommandExecutor";
import type { FileSystem } from "../../utils/filesystem/DefaultFileSystem";
import { getTempDir } from "../../utils/tempDir";
import { type DirectoryLock, FileDirectoryLock } from "../../utils/directoryLock";
import { shellQuote } from "../../utils/shellQuote";

export const BLE_PYTHON_PINS = ["bumble==0.0.236", "grpcio==1.85.1", "protobuf==7.36.2"] as const;
export const PYTHON_INSTALL_FIX =
  "Install Python 3.11 with venv support, ensure python3 is on the daemon's PATH, then retry blePeripheral start.";

export const MIN_PYTHON = [3, 11] as const;

/** Parses `Python X.Y.Z` from `python3 --version` (stdout on 3.4+, stderr on older interpreters). */
export function parsePythonVersion(output: string): [number, number] | undefined {
  const match = /Python (\d+)\.(\d+)/.exec(output);
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

function supported([major, minor]: [number, number]): boolean {
  return major > MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor >= MIN_PYTHON[1]);
}

export interface PythonEnvProvisioner {
  ensure(): Promise<string>;
}

/** Covers `venv --clear` plus the pinned pip install, whose own timeouts total 240 s. */
const PROVISION_LOCK_TIMEOUT_MS = 300_000;

function defaultProvisionLock(): DirectoryLock {
  return new FileDirectoryLock({
    fileName: "provision.lock",
    description: "the BLE Python environment lock",
    holderActivity: "Another AutoMobile process is installing the BLE Python environment",
    timeoutMs: PROVISION_LOCK_TIMEOUT_MS,
    pollMs: 250,
  });
}

/**
 * One managed environment; simultaneous starts share provisioning and failed installs never mark it ready.
 * A file lock on the environment directory serializes provisioning across daemon processes.
 */
export class ManagedPythonEnvProvisioner implements PythonEnvProvisioner {
  private pending?: Promise<string>;
  private readonly lock: DirectoryLock;

  constructor(
    private readonly deps: {
      commands: HostCommandExecutor;
      files: Pick<FileSystem, "existsSync" | "readFile" | "writeFile" | "ensureDir">;
      directory?: () => string;
      platform?: NodeJS.Platform;
      lock?: DirectoryLock;
    },
  ) {
    this.lock = deps.lock ?? defaultProvisionLock();
  }

  ensure(): Promise<string> {
    this.pending ??= this.provision().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async provision(): Promise<string> {
    const { files } = this.deps;
    const root = (this.deps.directory ?? (() => getTempDir("ble-peripheral")))();
    const venv = join(root, "venv");
    const python = join(
      venv,
      (this.deps.platform ?? process.platform) === "win32" ? "Scripts/python.exe" : "bin/python3",
    );
    const marker = join(root, "pins.json");
    const pins = JSON.stringify(BLE_PYTHON_PINS);
    const ready = async () =>
      files.existsSync(python) &&
      files.existsSync(marker) &&
      (await files.readFile(marker)) === pins;
    try {
      if (await ready()) {
        return python;
      }
      await this.assertSupportedPython();
      await files.ensureDir(root);
      return await this.lock.withLock(root, async () => {
        // Another process may have finished provisioning while this one waited for the lock.
        if (await ready()) {
          return python;
        }
        await this.install(venv, python);
        await files.writeFile(marker, pins);
        return python;
      });
    } catch (error) {
      throw toActionableError(
        error,
        `Could not prepare BLE Python environment at ${venv}. ${PYTHON_INSTALL_FIX}`,
      );
    }
  }

  private async install(venv: string, python: string): Promise<void> {
    const { commands } = this.deps;
    // Without a matching marker the venv may be half-built (no pip, interrupted install); rebuild it.
    await commands.executeCommand("python3", ["-m", "venv", "--clear", venv], {
      timeoutMs: 60_000,
    });
    try {
      await commands.executeCommand(python, ["-I", "-m", "pip", "install", ...BLE_PYTHON_PINS], {
        timeoutMs: 180_000,
      });
    } catch (error) {
      throw new ActionableError(
        `BLE dependency installation failed. Check network access to PyPI and run ${shellQuote(python)} -I -m pip install ${BLE_PYTHON_PINS.join(" ")}, then retry start.`,
        { cause: error },
      );
    }
  }

  private async assertSupportedPython(): Promise<void> {
    let output: string;
    try {
      const result = await this.deps.commands.executeCommand("python3", ["--version"], {
        timeoutMs: 10_000,
      });
      output = `${result.stdout}\n${result.stderr}`;
    } catch (error) {
      throw new ActionableError(`python3 is unavailable. ${PYTHON_INSTALL_FIX}`, {
        cause: error,
      });
    }
    const version = parsePythonVersion(output);
    if (!version || !supported(version)) {
      throw new ActionableError(
        `python3 reports ${version ? version.join(".") : "an unrecognized version"}; Bumble needs Python ${MIN_PYTHON.join(".")}+. ${PYTHON_INSTALL_FIX}`,
      );
    }
  }
}
