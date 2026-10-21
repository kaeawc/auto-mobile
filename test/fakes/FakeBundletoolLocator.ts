import type {
  BundletoolLocator,
  BundletoolLookup,
} from "../../src/utils/android-cmdline-tools/BundletoolLocator";

/** Fake {@link BundletoolLocator}: found on PATH at `/usr/local/bin/bundletool` by default. */
export class FakeBundletoolLocator implements BundletoolLocator {
  lookup: BundletoolLookup = {
    found: true,
    command: {
      file: "/usr/local/bin/bundletool",
      args: [],
      location: "/usr/local/bin/bundletool",
      source: "path",
    },
  };
  locateCalls = 0;

  setMissing(reason = "bundletool is not on PATH"): void {
    this.lookup = { found: false, reason };
  }

  async locate(): Promise<BundletoolLookup> {
    this.locateCalls += 1;
    return this.lookup;
  }
}
