import type { EnvironmentReader } from "./deviceCreationGate";

export class ProcessEnvironmentReader implements EnvironmentReader {
  get(name: string): string | undefined {
    return process.env[name];
  }
}
