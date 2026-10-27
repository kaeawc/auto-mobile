import type { SimulatorProfileStore } from "../../src/utils/ios-cmdline-tools/SimulatorProfileStore";

export class FakeSimulatorProfileStore implements SimulatorProfileStore {
  key: string | null = "xcode-1";
  contents: string | null = null;
  readError: Error | undefined;
  writeError: Error | undefined;
  keyError: Error | undefined;
  writes = 0;

  async currentKey(): Promise<string | null> {
    if (this.keyError) {
      throw this.keyError;
    }
    return this.key;
  }

  async read(): Promise<string | null> {
    if (this.readError) {
      throw this.readError;
    }
    return this.contents;
  }

  async write(contents: string): Promise<void> {
    if (this.writeError) {
      throw this.writeError;
    }
    this.writes++;
    this.contents = contents;
  }
}
