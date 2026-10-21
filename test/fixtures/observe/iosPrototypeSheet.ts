import rawCapture from "../observe-output/ios-prototype-sheet/ios-sheet-prototype-over-playground.raw-xcuitest.json";
import optimizedCapture from "../observe-output/ios-prototype-sheet/ios-sheet-prototype-over-playground.runner-optimized.json";
import type { XCTestHierarchy } from "../../../src/features/observe/ios/types";

/** Captured sheet over Playground; return a fresh parse for derived test variants. */
export function iosPrototypeSheetRaw(): XCTestHierarchy {
  return JSON.parse(JSON.stringify(rawCapture)) as XCTestHierarchy;
}

/** Runner-optimized wire tree with every capture metadata field retained from the raw capture. */
export function iosPrototypeSheetWire(): XCTestHierarchy {
  return {
    ...iosPrototypeSheetRaw(),
    hierarchy: JSON.parse(JSON.stringify(optimizedCapture.hierarchy)),
  };
}
