@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

final class PrototypeChatScrollTests: XCTestCase {
    // Initialize the shared contract once outside per-test timing, as in a beforeAll fixture.
    override class func setUp() {
        super.setUp()
        do {
            _ = try JSONDecoder().decode(PrototypeSpec.self, from: Data(
                contentsOf:
                PrototypeSpecFixtures.directory.appendingPathComponent("valid/chat-scroll.json")
            ))
        } catch {
            XCTFail("Chat fixture setup failed: \(error)")
        }
    }

    private func spec() throws -> PrototypeSpec {
        try JSONDecoder().decode(PrototypeSpec.self, from: Data(
            contentsOf:
            PrototypeSpecFixtures.directory.appendingPathComponent("valid/chat-scroll.json")
        ))
    }

    private func action(_ json: String) throws -> PrototypeAction {
        try JSONDecoder().decode(PrototypeAction.self, from: Data(json.utf8))
    }

    func testEdgesOnlyFireOnEntryAndShortContentNeverLoadsOlder() {
        var edges = PrototypeChatScroll()
        XCTAssertEqual(
            edges.update(start: 0, end: 50, viewport: 100, stickToEnd: false),
            .init(atEnd: true, reachedStart: false, followEnd: false)
        )
        XCTAssertEqual(
            edges.update(start: 0, end: 50, viewport: 100, stickToEnd: false),
            .init(atEnd: nil, reachedStart: false, followEnd: false)
        )
        XCTAssertEqual(
            edges.update(start: 0, end: 200, viewport: 100, stickToEnd: false),
            .init(atEnd: false, reachedStart: true, followEnd: false)
        )
        XCTAssertFalse(edges.update(start: 0, end: 200, viewport: 100, stickToEnd: false).reachedStart)
        XCTAssertEqual(edges.update(start: -100, end: 100, viewport: 100, stickToEnd: false).atEnd, true)
        XCTAssertTrue(edges.update(start: 0, end: 200, viewport: 100, stickToEnd: false).reachedStart)
    }

    func testGrowthFollowsOnlyWhileAtEndAndDoesNotPublishATransientFalse() {
        var edges = PrototypeChatScroll()
        _ = edges.update(start: -100, end: 100, viewport: 100, stickToEnd: true)
        XCTAssertEqual(
            edges.update(start: -100, end: 150, viewport: 100, stickToEnd: true),
            .init(atEnd: nil, reachedStart: false, followEnd: true)
        )
        XCTAssertEqual(edges.atEnd, true)
        _ = edges.update(start: -150, end: 100, viewport: 100, stickToEnd: true)
        XCTAssertEqual(edges.update(start: -50, end: 200, viewport: 100, stickToEnd: true).atEnd, false)
        XCTAssertFalse(edges.update(start: -50, end: 250, viewport: 100, stickToEnd: true).followEnd)
        _ = edges.update(start: -200, end: 100, viewport: 100, stickToEnd: true)
        XCTAssertFalse(edges.update(start: -200, end: 150, viewport: 100, stickToEnd: false).followEnd)
    }

    func testScrollRequestsSequenceEvenForRepeatedTargetsWithoutStateOrEvents() throws {
        var session = PrototypeSession()
        try session.show(spec())
        let state = session.state
        let end = try action(#"{"type":"scrollTo","scroll":"chat","to":"end"}"#)
        XCTAssertTrue(session.run([end]).isEmpty)
        XCTAssertEqual(session.scrollRequests["chat"], .init(target: .end, animated: true, sequence: 1))
        XCTAssertTrue(session.run([end]).isEmpty)
        XCTAssertEqual(session.scrollRequests["chat"]?.sequence, 2)
        let key = try action(#"{"type":"scrollTo","scroll":"chat","to":{"key":"m1"},"animated":false}"#)
        _ = session.run([key])
        XCTAssertEqual(session.scrollRequests["chat"], .init(target: .key("m1"), animated: false, sequence: 3))
        XCTAssertEqual(session.state, state)
        try session.show(spec())
        XCTAssertTrue(session.scrollRequests.isEmpty)
        _ = session.run([end])
        XCTAssertEqual(session.scrollRequests["chat"]?.sequence, 4)
    }

    func testRequestsAreIndependentPerScrollAndTargetsPreserveScalarIdentity() throws {
        var session = PrototypeSession()
        try session.show(spec())
        _ = try session.run([
            action(#"{"type":"scrollTo","scroll":"chat","to":"start"}"#),
            action(#"{"type":"scrollTo","scroll":"other","to":{"key":42}}"#),
        ])
        XCTAssertEqual(session.scrollRequests["chat"]?.target, .start)
        XCTAssertEqual(session.scrollRequests["other"]?.target, .key("42"))
        XCTAssertEqual(PrototypeScrollTarget(.object(["key": .bool(true)])), .key("true"))
        XCTAssertNotEqual(PrototypeScrollTarget(.object(["key": .string("end")])), .end)
        XCTAssertNil(PrototypeScrollTarget(.string("missing")))
    }

    func testFixtureDecodesChatOptionsActionsAndStampedRepeatKeys() throws {
        let root = try spec().root
        let scroll = try XCTUnwrap(root.children?.first)
        XCTAssertEqual(scroll.reverse, true)
        XCTAssertEqual(scroll.stickToEnd, true)
        XCTAssertEqual(scroll.atEndKey, "atEnd")
        XCTAssertEqual(scroll.onStartReached?.first?.name, "load_older")
        XCTAssertEqual(scroll.child?.children?.compactMap(\.repeatKey), ["m1", "m2"])
        XCTAssertEqual(root.children?[1].onTap?.first?.scroll, "chat")
    }

    func testRepeatStampsOnlyFirstChildAndBindsStartActions() throws {
        let json =
            #"{"type":"column","repeat":{"as":"item","key":"id","items":[{"id":1},{"id":true}]},"children":[{"type":"scroll","onStartReached":[{"type":"emit","name":"older_{item.id}"}],"child":{"type":"text","text":"x"}},{"type":"text","text":"tail"}]}"#
        let expanded = try PrototypeRepeat.expand(JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)))
        let root = try JSONDecoder().decode(PrototypeNode.self, from: JSONEncoder().encode(expanded))
        XCTAssertEqual(root.children?.compactMap(\.repeatKey), ["1", "true"])
        XCTAssertEqual(root.children?.first?.onStartReached?.first?.name, "older_1")
        XCTAssertNil(root.children?[1].repeatKey)
    }

    func testSharedInvalidChatFixturesRejectAtHostPaths() throws {
        let names = [
            "at-end-key-repeat-undeclared",
            "at-end-key-string",
            "at-end-key-undeclared",
            "horizontal-reverse",
            "to-duplicate-id",
            "to-invalid-target",
            "to-unknown-id",
        ]
        for name in names {
            let fixture = try PrototypeSpecFixtures.invalid("chat-scroll-" + name)
            let data = try JSONEncoder().encode(fixture.spec)
            XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(data: data)) { error in
                guard case let .invalidSpec(path, _) = error as? PrototypeLoadError else {
                    return XCTFail("Unexpected error: \(error)")
                }
                XCTAssertEqual(path, fixture.expectedPath, name)
            }
        }
    }

    func testAppendThenScrollToUsesTheNewlyExpandedRowKey() throws {
        var session = PrototypeSession()
        try session.show(spec())
        let submit = try XCTUnwrap(session.spec?.root.children?[2].children?.first?.onSubmit)
        _ = session.run(submit)
        XCTAssertEqual(session.spec?.root.children?.first?.child?.children?.compactMap(\.repeatKey), ["m1", "m2", "m3"])
        XCTAssertEqual(session.scrollRequests["chat"]?.target, .key("m3"))
    }

    func testRuntimeWritesKeepAtEndBooleanAndValidateStartActions() throws {
        var session = PrototypeSession()
        try session.show(spec())
        _ = session.setStates([("atEnd", .string("bad"))])
        XCTAssertEqual(session.state["atEnd"], .bool(true))
        let json =
            #"{"id":"p","window":{"placement":{"type":"fullscreen"}},"state":{"atEnd":true,"count":"bad"},"root":{"type":"scroll","atEndKey":"atEnd","onStartReached":[{"type":"increment","key":"count"}],"child":{"type":"text","text":"x"}}}"#
        let decoded = try JSONDecoder().decode(PrototypeSpec.self, from: Data(json.utf8))
        XCTAssertNotNil(PrototypeStateValidator.rejection(root: decoded.root, state: decoded.state ?? [:]))
    }

    func testCapabilityIsAdvertisedAndInferredForBundles() throws {
        XCTAssertTrue(PrototypeAgentProtocol.capabilities.contains("prototype_chat_scroll_v1"))
        let data = try Data(
            contentsOf:
            PrototypeSpecFixtures.directory.appendingPathComponent("valid/chat-scroll.json")
        )
        XCTAssertTrue(try PrototypeBundleCapabilities.required(data).contains("prototype_chat_scroll_v1"))
    }
}
