@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeSharedElementTests: XCTestCase {
    func testCapabilitiesCoverBundleComponentsAndIgnoreOpaqueData() throws {
        let data = Data("""
        {"id":"shared","window":{"placement":{"type":"fullscreen"}},"motion":"reduced",
         "data":{"literal":{"sharedKey":"opaque"}},
         "root":{"type":"text","text":"plain"},
         "components":{"Card":{"root":{"type":"box","sharedKey":"hero"}}}}
        """.utf8)
        XCTAssertEqual(try PrototypeBundleCapabilities.required(data), [
            "prototype_data_model_v1", "prototype_reduced_motion_v1", "prototype_shared_element_v1",
        ])
        let fields = try XCTUnwrap(JSONDecoder().decode(JSONValue.self, from: data).objectFields)
        XCTAssertEqual(PrototypeStrictCapabilities.required(fields), [
            "prototype_data_model_v1", "prototype_reduced_motion_v1",
        ])
    }

    func testPlansFollowTheProfileAndSkipKeysShownTwice() throws {
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
        {"id":"shared","window":{"placement":{"type":"fullscreen"}},"state":{"open":false},
         "root":{"type":"column","children":[
           {"type":"text","text":"a","sharedKey":"hero","visibleWhen":{"key":"open","equals":false}},
           {"type":"box","visibleWhen":{"key":"open","equals":true},"sharedKey":"hero",
            "children":[{"type":"text","text":"b"}]}]}}
        """.utf8))
        let first = try XCTUnwrap(spec.root.children?.first)
        for profile in [PrototypeMotionProfile.full, .reduced, .off] {
            let plan = PrototypeSharedElementPlan(node: first, profile: profile)
            XCTAssertEqual(plan.key, "hero")
            XCTAssertEqual(plan.apply, profile == .full)
            XCTAssertFalse(PrototypeSharedElementPlan(node: spec.root, profile: profile).apply)
        }
    }

    func testSharedNodeWithNoneTransitionStillCrossfades() {
        for (specMotion, reduce, expected) in [
            (String?.none, false, PrototypeVisibilityTransition.fade),
            ("reduced", false, .fade),
            (String?.none, true, .fade),
            ("none", false, .instant),
        ] {
            let motion = PrototypeMotion(specMotion: specMotion, reduceMotion: reduce)
            XCTAssertEqual(motion.visibility(transition: "none", shared: true), expected)
        }
        XCTAssertEqual(
            PrototypeMotion(specMotion: nil, reduceMotion: false).visibility(transition: "none"), .instant
        )
    }

    func testConflictingKeysAreThoseShownTogether() throws {
        let both = try JSONDecoder().decode(PrototypeNode.self, from: Data("""
        {"type":"column","children":[
          {"type":"text","text":"a","sharedKey":"hero","visibleWhen":{"key":"open","equals":true}},
          {"type":"text","text":"b","sharedKey":"hero","visibleWhen":{"key":"open","equals":true}},
          {"type":"text","text":"c","sharedKey":"solo","visibleWhen":{"key":"open","equals":false}}]}
        """.utf8))
        XCTAssertEqual(
            PrototypeSharedElementPlan.conflictingKeys(in: both) { $0.holds(["open": .bool(true)]) }, ["hero"]
        )
        XCTAssertEqual(
            PrototypeSharedElementPlan.conflictingKeys(in: both) { $0.holds(["open": .bool(false)]) }, []
        )
        let first = try XCTUnwrap(both.children?.first)
        XCTAssertFalse(PrototypeSharedElementPlan(node: first, profile: .full, conflictingKeys: ["hero"]).apply)
        XCTAssertTrue(PrototypeSharedElementPlan(node: first, profile: .full, conflictingKeys: []).apply)
    }
    func testElementAndBoundsDecisionsForEveryProfile() throws {
        for kind in ["element", "bounds"] {
            let node = try JSONDecoder().decode(PrototypeNode.self, from: Data("""
            {"type":"card","shared":{"key":"story-one","as":"\(kind)"},
             "visibleWhen":{"key":"open","equals":true},"children":[]}
            """.utf8))
            for profile in [PrototypeMotionProfile.full, .reduced, .off] {
                let plan = PrototypeSharedElementPlan(node: node, profile: profile)
                XCTAssertEqual(plan.key, "story-one")
                XCTAssertEqual(plan.apply, profile == .full)
                XCTAssertEqual(plan.crossfade, profile == .reduced || (profile == .full && kind == "bounds"))
            }
        }
    }

    func testRepeatKeysResolveBeforePlanningFeedToDetail() throws {
        let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
        let data = try Data(contentsOf: directory.appendingPathComponent("test/fixtures/prototype-spec/valid/shared-v2-repeat.json"))
        try PrototypeSpecStrictValidator.validate(data: data)
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: data)
        let feed = try XCTUnwrap(spec.root.children?.first?.children)
        XCTAssertEqual(feed.map(\.resolvedSharedKey), ["story-one", "story-two"])
        let detail = try XCTUnwrap(spec.root.children?.last)
        XCTAssertEqual(detail.resolvedSharedKey, "story-one")
        XCTAssertEqual(PrototypeSharedElementPlan(node: detail, profile: .full).crossfade, true)
    }

}
