import { join } from "node:path";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { type HostCommandExecutor } from "../../utils/HostCommandExecutor";
import type { FileSystem } from "../../utils/filesystem/DefaultFileSystem";
import { getTempDir } from "../../utils/tempDir";
import { shellQuote } from "../../utils/shellQuote";

export const BLE_PYTHON_PINS = ["bumble==0.0.236", "grpcio==1.85.1", "protobuf==7.36.2"] as const;
export const PYTHON_INSTALL_FIX =
  "Install Python 3.11 with venv support, ensure python3 is on the daemon's PATH, then retry blePeripheral start.";

export interface PythonEnvProvisioner {
  ensure(): Promise<string>;
}

/** One managed environment; simultaneous starts share provisioning and failed installs never mark it ready. */
export class ManagedPythonEnvProvisioner implements PythonEnvProvisioner {
  private pending?: Promise<string>;

  constructor(
    private readonly deps: {
      commands: HostCommandExecutor;
      files: Pick<FileSystem, "existsSync" | "readFile" | "writeFile" | "ensureDir">;
      directory?: () => string;
      platform?: NodeJS.Platform;
    },
  ) {}

  ensure(): Promise<string> {
    this.pending ??= this.provision().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async provision(): Promise<string> {
    const { commands, files } = this.deps;
    const root = (this.deps.directory ?? (() => getTempDir("ble-peripheral")))();
    const venv = join(root, "venv");
    const python = join(
      venv,
      (this.deps.platform ?? process.platform) === "win32" ? "Scripts/python.exe" : "bin/python3",
    );
    const marker = join(root, "pins.json");
    const pins = JSON.stringify(BLE_PYTHON_PINS);
    try {
      if (
        files.existsSync(python) &&
        files.existsSync(marker) &&
        (await files.readFile(marker)) === pins
      ) {
        return python;
      }
      try {
        await commands.executeCommand("python3", ["--version"], { timeoutMs: 10_000 });
      } catch (error) {
        throw new ActionableError(`python3 is unavailable. ${PYTHON_INSTALL_FIX}`, {
          cause: error,
        });
      }
      await files.ensureDir(root);
      if (!files.existsSync(python)) {
        await commands.executeCommand("python3", ["-m", "venv", venv], { timeoutMs: 60_000 });
      }
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
      await files.writeFile(marker, pins);
      return python;
    } catch (error) {
      throw toActionableError(
        error,
        `Could not prepare BLE Python environment at ${venv}. ${PYTHON_INSTALL_FIX}`,
      );
    }
  }
}
