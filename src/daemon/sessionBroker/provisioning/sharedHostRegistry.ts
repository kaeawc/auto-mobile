import type { BindingRegistry } from "../registry/bindingRegistry";

interface HostRegistryEntry {
  promise: Promise<BindingRegistry>;
  handle?: BindingRegistry;
}

/**
 * One lazily opened host registry handle, shared by every exclusion view created over it. A failed
 * open is forgotten so the next refresh retries it.
 */
export class SharedHostRegistry {
  private entry: HostRegistryEntry | undefined;

  isOpen(): boolean {
    return this.entry !== undefined;
  }

  open(openRegistry: () => Promise<BindingRegistry>): Promise<BindingRegistry> {
    if (!this.entry) {
      const entry: HostRegistryEntry = {
        promise: openRegistry().then(
          (registry) => {
            entry.handle = registry;
            return registry;
          },
          (error: unknown) => {
            if (this.entry === entry) {
              this.entry = undefined;
            }
            throw error;
          },
        ),
      };
      this.entry = entry;
    }
    return this.entry.promise;
  }

  /** Drop the cached handle when it is `registry`, without closing it. */
  forget(registry: BindingRegistry): void {
    if (this.entry?.handle === registry) {
      this.entry = undefined;
    }
  }
}
