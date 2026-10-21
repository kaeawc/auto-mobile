import { registerAppTools, type AppToolsDependencies } from "../../src/server/appTools";
import { ToolRegistry } from "../../src/server/toolRegistry";

type Family = keyof AppToolsDependencies;

/**
 * Registers the app tools with accumulating per-family dependency overrides, so a test can
 * configure one family at a time (as the old module-level setters allowed) while every
 * registration starts from real defaults and nothing leaks into the next test.
 */
export function createAppToolsHarness() {
  let dependencies: AppToolsDependencies = {};

  // Re-registering overwrites the app tools by name and leaves every other tool in place.
  const register = (): void => {
    registerAppTools(dependencies);
  };

  return {
    /** Drop every override and register with the defaults. */
    reset(): void {
      dependencies = {};
      ToolRegistry.clearTools();
      register();
    },
    /** Merge `overrides` into one family's dependencies and re-register the tools. */
    configure<K extends Family>(family: K, overrides: NonNullable<AppToolsDependencies[K]>): void {
      // A factory is a function, not a bag of overrides: spreading it into `{}` would lose it.
      const merged =
        typeof overrides === "function"
          ? overrides
          : { ...(dependencies[family] as object | undefined), ...(overrides as object) };
      dependencies = { ...dependencies, [family]: merged };
      register();
    },
    /** Forget overrides without re-registering (afterEach). */
    clear(): void {
      dependencies = {};
      ToolRegistry.clearTools();
    },
  };
}
