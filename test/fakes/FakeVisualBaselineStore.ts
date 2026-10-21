import type {
  VisualBaseline,
  VisualBaselineStore,
} from "../../src/features/visual/VisualBaselineStore";
import { assertBaselineName } from "../../src/features/visual/VisualBaselineStore";
import {
  visualProfileKey,
  type VisualDeviceProfile,
} from "../../src/features/visual/VisualDeviceProfile";

/** In-memory baselines keyed like the file store: `<name>/<profileKey>`. */
export class FakeVisualBaselineStore implements VisualBaselineStore {
  readonly baselines = new Map<string, VisualBaseline>();

  private key(name: string, profile: VisualDeviceProfile): string {
    assertBaselineName(name);
    return `${name}/${visualProfileKey(profile)}`;
  }

  async read(name: string, profile: VisualDeviceProfile): Promise<VisualBaseline | null> {
    return this.baselines.get(this.key(name, profile)) ?? null;
  }

  async otherProfiles(name: string, profile: VisualDeviceProfile): Promise<VisualDeviceProfile[]> {
    const own = this.key(name, profile);
    return [...this.baselines.entries()]
      .filter(([key]) => key.startsWith(`${name}/`) && key !== own)
      .map(([, baseline]) => baseline.profile);
  }

  async write(
    name: string,
    profile: VisualDeviceProfile,
    png: Buffer,
    recordedAt: string,
  ): Promise<VisualBaseline> {
    const key = this.key(name, profile);
    const baseline = { name, profile, png, path: `/baselines/${key}.png`, recordedAt };
    this.baselines.set(key, baseline);
    return baseline;
  }

  diffPath(name: string, profile: VisualDeviceProfile): string {
    return `/baselines/${this.key(name, profile)}.diff.png`;
  }
}
