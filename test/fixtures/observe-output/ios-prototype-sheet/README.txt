iOS hierarchy capture -- SHEET prototype over the Playground app (issue #12215)
Date: 2026-10-13 (manual-test batch 20261013a, main c12ab49c99)

Device: iPhone simulator, iOS 27.0, 390x844 pt, Playground app (dev.jasonpearson.automobile.Playground)
launched with the prototype agent; daemon Build ID ad4a82b5abffb4d6.
Prototype: placement {type: sheet, edge: bottom, height: 300}, a column with a text (s6), a button
(b6, "SheetBtn") and a text field (tf6); the host dismiss control automobile-prototype-dismiss is
drawn in the same UIWindow.

ios-sheet-prototype-over-playground.raw-xcuitest.json
  The runner's unoptimized XCTestHierarchy from
    observe {"raw":true}
  i.e. the JSON document held in the response's rawViewHierarchy.xcuitest string, parsed and
  re-serialized with one-space indentation (python json.dumps(indent=1), value-equal to the
  captured string; nothing else of the 245 kB observe result is kept). No node was added, removed
  or edited. Raw windows under XCUIApplication, back to front:
    0  Playground app window: UINavigationBar "Discover", UICollectionView, UIToolbar, UITabBar
    1  prototype window: sheet container [0,544,390,844] with s6, b6, tf6, and the dismiss control
       [338,47,382,91]

ios-sheet-prototype-over-playground.runner-optimized.json
  NOT a device capture: the raw capture above after the iOS runner's own hierarchy optimization
  (ElementLocator.optimizeHierarchy, the pass every non-raw hierarchy response goes through). It is
  written and asserted byte-for-byte by HierarchyWindowLayerTests (ios/control-proxy); regenerate
  it with AUTOMOBILE_UPDATE_FIXTURES=1 swift test --package-path ios/control-proxy
  --filter HierarchyWindowLayerTests, never by hand. The TypeScript suites read it as the wire
  shape the host receives for this screen. Its eight top-level nodes are the same eight the
  device's own (pre-fix) non-raw observe returned for this screen, now carrying the window stamp.
