@testable import CtrlProxyRewrite
import XCTest

final class HierarchyPairFileRecorderTests: XCTestCase {
    func testFromEnvironmentRequiresANonBlankDirectory() {
        XCTAssertNil(HierarchyPairFileRecorder.fromEnvironment([:]))
        XCTAssertNil(HierarchyPairFileRecorder.fromEnvironment([HierarchyPairFileRecorder.environmentKey: "  "]))
        XCTAssertNotNil(HierarchyPairFileRecorder.fromEnvironment([HierarchyPairFileRecorder.environmentKey: "/tmp/x"]))
    }

    func testRecordWritesSequencedPairsThatDecodeBack() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("hierarchy-pairs-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let recorder = HierarchyPairFileRecorder(directory: directory)
        let xcuitest = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: UIElementInfo(className: "UIView", bounds: ElementBounds(left: 0, top: 0, right: 10, bottom: 10))
        )
        let sdk = SdkViewHierarchy(
            timestamp: 1, bundleId: "com.test/app", screenScale: 3, screenWidth: 10, screenHeight: 10,
            root: SdkViewNode(className: "UIView", bounds: SdkBounds(left: 0, top: 0, right: 10, bottom: 10))
        )

        recorder.record(xcuitest: xcuitest, sdk: sdk)
        recorder.record(xcuitest: xcuitest, sdk: sdk)

        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted()
        XCTAssertEqual(names, ["pair-0001-com.test_app.json", "pair-0002-com.test_app.json"])
        let pair = try JSONDecoder().decode(
            HierarchyPair.self, from: Data(contentsOf: directory.appendingPathComponent(names[0]))
        )
        XCTAssertEqual(pair.xcuitest.packageName, "com.test.app")
        XCTAssertEqual(pair.sdk.root?.className, "UIView")
    }
}
