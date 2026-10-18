import type { XCTestHierarchy } from "../../../../src/features/observe/ios/types";

/**
 * A complete runner payload with only the fields a stream test cares about
 * overridden (mostly screen metadata); the required fields get inert defaults.
 */
export function createIosScreenSourceForTest(
  fields: Partial<XCTestHierarchy> = {},
): XCTestHierarchy {
  return { updatedAt: 0, packageName: "com.example.ios", hierarchy: {}, ...fields };
}
