import path from "node:path";
import type {
  CodeSignVerifier,
  NetworkFilterSignatureInspection,
} from "../../src/features/networkFilter/NetworkFilterCodeSignVerifier";
import type { FileInstaller } from "../../src/features/networkFilter/NetworkFilterFileInstaller";
import type {
  NetworkFilterCommandOutcome,
  NetworkFilterCommandRunner,
  NetworkFilterFileSystem,
} from "../../src/features/networkFilter/networkFilterHost";
import {
  NETWORK_FILTER_APP_IDENTIFIER,
  NETWORK_FILTER_PROVIDER_IDENTIFIER,
  controllerPath,
} from "../../src/features/networkFilter/networkFilterApp";

/** In-memory filesystem: directories are a set, files a map of text. */
export class FakeNetworkFilterFileSystem implements NetworkFilterFileSystem {
  readonly directories = new Set<string>();
  readonly files = new Map<string, string>();
  readonly writes: string[] = [];

  addApp(appPath: string): void {
    this.ensureDirSync(appPath);
    this.addFile(controllerPath(appPath), "controller");
  }

  addFile(filePath: string, content: string): void {
    this.ensureDirSync(path.dirname(filePath));
    this.files.set(filePath, content);
  }

  private ensureDirSync(dir: string): void {
    let current = dir;
    while (current !== path.dirname(current)) {
      this.directories.add(current);
      current = path.dirname(current);
    }
  }

  async isDirectory(target: string): Promise<boolean> {
    return this.directories.has(target);
  }

  async isFile(target: string): Promise<boolean> {
    return this.files.has(target);
  }

  async readText(target: string): Promise<string | null> {
    return this.files.get(target) ?? null;
  }

  async writeText(target: string, content: string): Promise<void> {
    this.writes.push(target);
    this.addFile(target, content);
  }

  async ensureDir(target: string): Promise<void> {
    this.ensureDirSync(target);
  }

  async remove(target: string): Promise<void> {
    const prefix = `${target}${path.sep}`;
    for (const dir of [...this.directories]) {
      if (dir === target || dir.startsWith(prefix)) {
        this.directories.delete(dir);
      }
    }
    for (const file of [...this.files.keys()]) {
      if (file === target || file.startsWith(prefix)) {
        this.files.delete(file);
      }
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const move = (value: string): string => to + value.slice(from.length);
    const prefix = `${from}${path.sep}`;
    for (const dir of [...this.directories]) {
      if (dir === from || dir.startsWith(prefix)) {
        this.directories.delete(dir);
        this.directories.add(move(dir));
      }
    }
    for (const [file, content] of [...this.files]) {
      if (file === from || file.startsWith(prefix)) {
        this.files.delete(file);
        this.files.set(move(file), content);
      }
    }
  }
}

export interface RecordedCommand {
  file: string;
  args: readonly string[];
  timeoutMs?: number;
}

/** Records argv and answers with a scripted handler; never spawns a process. */
export class FakeNetworkFilterCommandRunner implements NetworkFilterCommandRunner {
  readonly calls: RecordedCommand[] = [];
  handler: (
    file: string,
    args: readonly string[],
  ) => Partial<NetworkFilterCommandOutcome> | Promise<Partial<NetworkFilterCommandOutcome>> =
    () => ({});

  async run(
    file: string,
    args: readonly string[],
    options: { timeoutMs?: number } = {},
  ): Promise<NetworkFilterCommandOutcome> {
    this.calls.push({ file, args, timeoutMs: options.timeoutMs });
    const outcome = await this.handler(file, args);
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...outcome };
  }

  commandsFor(file: string): RecordedCommand[] {
    return this.calls.filter((call) => call.file === file || call.file.endsWith(`/${file}`));
  }
}

export const VALID_TEAM = "ABCDE12345";

export function signedInspection(
  overrides: {
    verified?: boolean;
    team?: string | null;
    providerTeam?: string | null;
    cdhash?: string;
    appIdentifier?: string | null;
    providerIdentifier?: string | null;
  } = {},
): NetworkFilterSignatureInspection {
  const team = overrides.team === undefined ? VALID_TEAM : overrides.team;
  return {
    verified: overrides.verified ?? true,
    verifyDetail: overrides.verified === false ? "a sealed resource is missing or invalid" : "",
    app: {
      identifier:
        overrides.appIdentifier === undefined
          ? NETWORK_FILTER_APP_IDENTIFIER
          : overrides.appIdentifier,
      teamIdentifier: team,
      cdhash: overrides.cdhash ?? "cdhash-candidate",
    },
    provider: {
      identifier:
        overrides.providerIdentifier === undefined
          ? NETWORK_FILTER_PROVIDER_IDENTIFIER
          : overrides.providerIdentifier,
      teamIdentifier: overrides.providerTeam === undefined ? team : overrides.providerTeam,
      cdhash: "cdhash-provider",
    },
  };
}

/** Returns a scripted inspection per bundle path. */
export class FakeCodeSignVerifier implements CodeSignVerifier {
  readonly inspected: string[] = [];
  readonly byPath = new Map<string, NetworkFilterSignatureInspection>();
  fallback: NetworkFilterSignatureInspection = signedInspection();

  async inspect(appPath: string): Promise<NetworkFilterSignatureInspection> {
    this.inspected.push(appPath);
    return this.byPath.get(appPath) ?? this.fallback;
  }
}

export class FakeFileInstaller implements FileInstaller {
  readonly existing = new Set<string>();
  readonly installs: Array<{ source: string; destination: string; replace: boolean }> = [];
  failWith: Error | null = null;

  async exists(destination: string): Promise<boolean> {
    return this.existing.has(destination);
  }

  async install(source: string, destination: string, options: { replace: boolean }): Promise<void> {
    if (this.failWith) {
      throw this.failWith;
    }
    this.installs.push({ source, destination, replace: options.replace });
    this.existing.add(destination);
  }
}
