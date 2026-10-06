import type { AdbExecutor } from "../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { PhysicalDisplayIdResolver } from "../../src/features/observe/android/AndroidPhysicalDisplayId";

/**
 * Resolver that answers from a fixed logical-to-physical table and never reads
 * the device. A logical id missing from the table resolves to null, like an
 * unreadable display list, so the capture keeps the logical-id argument.
 */
export class FakeAndroidPhysicalDisplayIdResolver implements PhysicalDisplayIdResolver {
  constructor(private readonly physicalByLogical: ReadonlyMap<number, string> = new Map()) {}

  async resolve(): Promise<string | null> {
    return null;
  }

  async resolveLogical(
    _adb: AdbExecutor,
    _deviceId: string,
    logicalId: number,
  ): Promise<string | null> {
    return this.physicalByLogical.get(logicalId) ?? null;
  }
}
