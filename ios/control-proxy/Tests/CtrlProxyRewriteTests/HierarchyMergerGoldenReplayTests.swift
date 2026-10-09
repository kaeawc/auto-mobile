@testable import CtrlProxyRewrite
import XCTest

/// Golden replay of real `(xcuitest, sdk)` merger input pairs (#5837).
///
/// The pairs in `test/fixtures/ios/merger-pairs/` were recorded by a simulator runner
/// with `CTRL_PROXY_IOS_HIERARCHY_PAIR_DIR` set (see
/// `docs/design-docs/plat/ios/ctrlproxy-rewrite/golden-replay.md`). Each pair is merged
/// with the production nearest-match tie-break and with the pre-#8662 delta-loop
/// tie-break; every output node that differs is a frame the reviewed behavior change
/// affects. The expected differences are the documented, accepted ones.
final class HierarchyMergerGoldenReplayTests: XCTestCase {
    /// Output-node paths whose merged JSON differs between the two tie-breaks, per fixture.
    /// Empty: no captured pair changes (see the golden-replay design doc).
    private static let acceptedDifferences: [String: [String]] = [:]

    /// Per fixture: XCUITest nodes whose nearest SDK bounds are within ±2 but not exact
    /// (the only queries the tie-break can affect), and how many of those see candidates
    /// at two or more distinct bounds (the only ones where the two orders can disagree).
    private static let toleranceCoverage: [String: ToleranceCoverage] = [
        "playground-demo-animations.json": ToleranceCoverage(toleranceOnly: 4, distinctBounds: 0),
        "playground-demo-scroll-performance.json": ToleranceCoverage(toleranceOnly: 3, distinctBounds: 1),
        "playground-demo-sdk-status.json": ToleranceCoverage(toleranceOnly: 5, distinctBounds: 0),
        "playground-tab-demos.json": ToleranceCoverage(toleranceOnly: 14, distinctBounds: 0),
        "playground-tab-discover.json": ToleranceCoverage(toleranceOnly: 10, distinctBounds: 0),
        "playground-tab-files.json": ToleranceCoverage(toleranceOnly: 3, distinctBounds: 0),
        "playground-tab-settings.json": ToleranceCoverage(toleranceOnly: 11, distinctBounds: 0),
    ]

    private struct ToleranceCoverage: Equatable {
        let toleranceOnly: Int
        let distinctBounds: Int
    }

    func testRealPairsDifferOnlyWhereDocumented() throws {
        let pairs = try loadPairs()
        XCTAssertFalse(pairs.isEmpty, "no golden merger pairs found")
        var observed: [String: [String]] = [:]
        for (name, pair) in pairs {
            let current = HierarchyMerger.merge(
                xcuitest: pair.xcuitest, sdk: pair.sdk, matchCounter: nil, tieBreak: .nearestThenDocumentOrder
            )
            let legacy = HierarchyMerger.merge(
                xcuitest: pair.xcuitest, sdk: pair.sdk, matchCounter: nil, tieBreak: .legacyDeltaLoopOrder
            )
            let differing = try differingPaths(current.hierarchy, legacy.hierarchy)
            if !differing.isEmpty {
                observed[name] = differing
            }
        }
        XCTAssertEqual(observed, Self.acceptedDifferences)
    }

    func testRealPairsMergeDeterministically() throws {
        let encoder = sortedEncoder()
        for (name, pair) in try loadPairs() {
            let first = try encoder.encode(HierarchyMerger.merge(xcuitest: pair.xcuitest, sdk: pair.sdk))
            let second = try encoder.encode(HierarchyMerger.merge(xcuitest: pair.xcuitest, sdk: pair.sdk))
            XCTAssertEqual(first, second, name)
        }
    }

    /// Pins what the corpus exercises, so "no differences" is not vacuous and a
    /// refreshed corpus has to restate its coverage in the doc and here.
    func testCorpusToleranceCoverageIsAsDocumented() throws {
        var observed: [String: ToleranceCoverage] = [:]
        for (name, pair) in try loadPairs() {
            let sdkBounds = flattenSdk(pair.sdk.root).map(\.bounds)
            var toleranceOnly = 0
            var distinctBounds = 0
            for element in flattenElements(pair.xcuitest.hierarchy) {
                guard let bounds = element.bounds else { continue }
                let near = sdkBounds.filter { HierarchyMerger.boundsDistance($0, bounds) <= 2 }
                guard !near.isEmpty, !near.contains(where: { HierarchyMerger.boundsDistance($0, bounds) == 0 })
                else { continue }
                toleranceOnly += 1
                if Set(near.map { [$0.left, $0.top, $0.right, $0.bottom] }).count > 1 {
                    distinctBounds += 1
                }
            }
            observed[name] = ToleranceCoverage(toleranceOnly: toleranceOnly, distinctBounds: distinctBounds)
        }
        XCTAssertEqual(observed, Self.toleranceCoverage)
    }

    // MARK: - Helpers

    private func flattenSdk(_ node: SdkViewNode?) -> [SdkViewNode] {
        guard let node else { return [] }
        return [node] + (node.children ?? []).flatMap { flattenSdk($0) }
    }

    private func flattenElements(_ node: UIElementInfo?) -> [UIElementInfo] {
        guard let node else { return [] }
        return [node] + (node.node ?? []).flatMap { flattenElements($0) }
    }

    private func loadPairs() throws -> [(String, HierarchyPair)] {
        let repoRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let directory = repoRoot.appendingPathComponent("test/fixtures/ios/merger-pairs")
        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path)
            .filter { $0.hasSuffix(".json") }
            .sorted()
        return try names.map { name in
            let data = try Data(contentsOf: directory.appendingPathComponent(name))
            return try (name, JSONDecoder().decode(HierarchyPair.self, from: data))
        }
    }

    private func sortedEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }

    /// Paths (`className[index]/...`) of nodes whose own fields differ, ignoring children.
    private func differingPaths(_ lhs: UIElementInfo?, _ rhs: UIElementInfo?) throws -> [String] {
        let left = try flatten(lhs, path: "")
        let right = try flatten(rhs, path: "")
        let keys = Set(left.keys).union(right.keys)
        return keys.filter { left[$0] != right[$0] }.sorted()
    }

    private func flatten(_ node: UIElementInfo?, path: String) throws -> [String: Data] {
        guard let node else { return [:] }
        let here = path + "/" + (node.className ?? "?")
        // Compare every field of the node itself; children are compared at their own paths.
        var object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: sortedEncoder().encode(node)) as? [String: Any]
        )
        object.removeValue(forKey: "node")
        var result = try [here: JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])]
        for (index, child) in (node.node ?? []).enumerated() {
            try result.merge(flatten(child, path: here + "[\(index)]")) { first, _ in first }
        }
        return result
    }
}
