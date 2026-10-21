import type { EnvironmentReader } from "./deviceCreationGate";
import { readProcessEnvByName } from "../config/processEnvironment";

export class ProcessEnvironmentReader implements EnvironmentReader {
  get(name: string): string | undefined {
    return readProcessEnvByName(name);
  }
}
