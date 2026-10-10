@testable import AutoMobilePrototypeAgentCore
import XCTest

/// Hunt: cross-platform parity of the prototype spec between the iOS agent and Android's
/// `PrototypeRuntime` / `PrototypeRenderModel`. These fail by design until the iOS agent matches.
final class HuntParityTests: XCTestCase {
    private func spec(_ json: String) throws -> PrototypeSpec {
        try JSONDecoder().decode(PrototypeSpec.self, from: Data(json.utf8))
    }

    private func node(_ json: String) throws -> PrototypeNode {
        try JSONDecoder().decode(PrototypeNode.self, from: Data(json.utf8))
    }

    private func action(_ json: String) throws -> PrototypeAction {
        try JSONDecoder().decode(PrototypeAction.self, from: Data(json.utf8))
    }

    // MARK: State writes that break a bound control

    /// The host accepts this spec (`increment` is only type-checked), and Android's `control` /
    /// `plannedWrites` re-validate the resulting state: a slider at its maximum rejects another
    /// increment, so the tap is dropped with nothing applied and nothing emitted (#11408). iOS
    /// writes 11 into a 0...10 slider's key and reports a `change`.
    func testIncrementPastASliderMaximumIsRejectedLikeAndroid() throws {
        var session = PrototypeSession()
        try session.show(spec("""
        {"id":"p","window":{"placement":{"type":"fullscreen"}},"state":{"v":10},
         "root":{"type":"column","children":[
           {"type":"slider","stateKey":"v","min":0,"max":10},
           {"type":"button","label":"+","onTap":[{"type":"increment","key":"v"}]}]}}
        """))
        let events = try session.run([action(#"{"type":"increment","key":"v"}"#)])
        XCTAssertEqual(session.state["v"], .number(10), "the slider key must stay within min...max")
        XCTAssertTrue(events.isEmpty, "a rejected write emits no change event")
    }

    /// Android's selection rule (`Selection requires a nonnegative integer state key`) rejects a
    /// decrement that takes a tab index below zero; iOS stores -1.
    func testDecrementBelowZeroOnABoundTabBarIsRejectedLikeAndroid() throws {
        var session = PrototypeSession()
        try session.show(spec("""
        {"id":"p","window":{"placement":{"type":"fullscreen"}},"state":{"tab":0},
         "root":{"type":"column","children":[
           {"type":"tabBar","stateKey":"tab","items":[{"label":"A"},{"label":"B"}]},
           {"type":"button","label":"-","onTap":[{"type":"decrement","key":"tab"}]}]}}
        """))
        let events = try session.run([action(#"{"type":"decrement","key":"tab"}"#)])
        XCTAssertEqual(session.state["tab"], .number(0), "a tab index must stay a nonnegative integer")
        XCTAssertTrue(events.isEmpty)
    }

    /// Android drops the WHOLE tap when any write in it is rejected (nothing applied, nothing
    /// emitted); iOS applies the earlier writes and the bad one alike.
    func testATapHoldingARejectedWriteAppliesNothing() throws {
        var session = PrototypeSession()
        try session.show(spec("""
        {"id":"p","window":{"placement":{"type":"fullscreen"}},"state":{"flag":false,"v":10},
         "root":{"type":"column","children":[
           {"type":"slider","stateKey":"v","min":0,"max":10},
           {"type":"switch","stateKey":"flag"}]}}
        """))
        let events = try session.run([
            action(#"{"type":"toggle","key":"flag"}"#),
            action(#"{"type":"increment","key":"v"}"#),
        ])
        XCTAssertEqual(session.state["flag"], .bool(false))
        XCTAssertEqual(session.state["v"], .number(10))
        XCTAssertTrue(events.isEmpty)
    }

    // MARK: Accessibility identifiers

    /// Android tags a node only with its `testTag` (`PrototypeSpecContent.kt` sets
    /// `testTag = node.testTag`); `id` is not an accessibility id there. iOS falls back to `id`,
    /// so `tapOn` by that id resolves on iOS and not on Android, and non-unique ids (the
    /// contract only requires uniqueness among pagers) become ambiguous identifiers.
    func testANodeWithOnlyAnIdHasNoAccessibilityIdentifierLikeAndroid() throws {
        let text = try node(#"{"type":"text","id":"title","text":"Hi"}"#)
        XCTAssertNil(text.identifier)
        let dialog = try node(
            #"{"type":"dialog","id":"d","title":"T","confirm":{"label":"OK"},"openWhen":{"key":"o","equals":true}}"#
        )
        XCTAssertNil(dialog.partIdentifier("confirm"), "Android derives part tags from testTag only")
        let tagged = try node(#"{"type":"text","id":"title","testTag":"hero","text":"Hi"}"#)
        XCTAssertEqual(tagged.identifier, "hero")
    }
}
