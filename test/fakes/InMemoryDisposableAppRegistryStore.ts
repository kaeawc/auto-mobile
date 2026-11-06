import type { DisposableAppRegistryStore } from "../../src/features/prototype/disposableApp/DisposableAppRegistry";

/** In-memory registry document; `contents` is public so tests can seed corruption. */
export class InMemoryDisposableAppRegistryStore implements DisposableAppRegistryStore {
  contents: string | undefined;
  writes = 0;

  async read(): Promise<string | undefined> {
    return this.contents;
  }

  async write(contents: string): Promise<void> {
    this.contents = contents;
    this.writes += 1;
  }
}
