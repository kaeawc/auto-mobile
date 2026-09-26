import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";

export interface InstalledIme {
  id: string;
  enabled: boolean;
  active: boolean;
}

export interface ImeCatalogState {
  activeImeId: string | null;
  installed: InstalledIme[];
}

/** System IMEs are Android components, distinct from CtrlProxy typing profiles. */
export class AndroidImeCatalog {
  constructor(private readonly adb: Pick<AdbExecutor, "execute">) {}

  async list(signal?: AbortSignal): Promise<ImeCatalogState> {
    const [installed, enabled, active] = await Promise.all([
      this.readImeIds(["shell", "ime", "list", "-a", "-s"], signal),
      this.readImeIds(["shell", "ime", "list", "-s"], signal),
      this.readActiveIme(signal),
    ]);
    const enabledIds = new Set(enabled);
    return {
      activeImeId: active,
      installed: installed.map((id) => ({
        id,
        enabled: enabledIds.has(id),
        active: id === active,
      })),
    };
  }

  async select(id: string, signal?: AbortSignal): Promise<ImeCatalogState> {
    const before = await this.list(signal);
    const target = before.installed.find((ime) => ime.id === id);
    if (!target) {
      throw new Error(`IME ${id} is not installed on this Android device.`);
    }
    if (!target.enabled) {
      throw new Error(`IME ${id} is installed but disabled; enable it on the device first.`);
    }
    if (before.activeImeId === id) {
      return before;
    }
    const result = await this.adb.execute(["shell", "ime", "set", id], { signal });
    if (result.stderr.trim()) {
      throw new Error(`Failed to select IME ${id}: ${result.stderr.trim()}`);
    }
    const after = await this.list(signal);
    if (after.activeImeId !== id) {
      throw new Error(
        `IME selection did not take effect: expected ${id}, got ${after.activeImeId ?? "none"}.`,
      );
    }
    return after;
  }

  private async readImeIds(args: string[], signal?: AbortSignal): Promise<string[]> {
    const result = await this.adb.execute(args, { signal });
    if (result.stderr.trim()) {
      throw new Error(`Failed to list Android IMEs: ${result.stderr.trim()}`);
    }
    // `ime list -s` emits one component id per line, according to Android's IME shell command.
    // Ignore whitespace-only rows; reject diagnostics so they cannot become selectable ids.
    const ids = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (ids.some((id) => !/^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/.test(id))) {
      throw new Error("Android returned an invalid IME component list.");
    }
    return [...new Set(ids)];
  }

  private async readActiveIme(signal?: AbortSignal): Promise<string | null> {
    const result = await this.adb.execute(
      ["shell", "settings", "get", "secure", "default_input_method"],
      { signal },
    );
    if (result.stderr.trim()) {
      throw new Error(`Failed to read active IME: ${result.stderr.trim()}`);
    }
    const id = result.stdout.trim();
    return id && id !== "null" ? id : null;
  }
}
