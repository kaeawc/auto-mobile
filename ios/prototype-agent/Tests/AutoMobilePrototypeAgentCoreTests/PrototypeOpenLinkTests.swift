@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeOpenLinkTests: XCTestCase {
    func testExplicitCapabilitiesAreCombinedWithInferredCapabilities() {
        let required = PrototypeStrictCapabilities.required([
            "requires": .array([.string("prototype_future_v1")]),
            "links": .array([]),
        ])
        XCTAssertEqual(required, ["prototype_future_v1", "prototype_links_v1"])
    }

    func testExplicitUnsupportedCapabilityRejectsEmbeddingAndStrictValidation() throws {
        let data = Data(#"""
        {"id":"future","window":{"placement":{"type":"fullscreen"}},
        "requires":["prototype_future_v1"],"root":{"type":"text","text":"Hello"}}
        """#.utf8)
        XCTAssertThrowsError(try PrototypeEmbeddedSpec.load(data: data)) { error in
            XCTAssertEqual(error as? PrototypeLoadError, .unsupportedCapabilities(["prototype_future_v1"]))
        }
        XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(data: data, supportedCapabilities: []))
        XCTAssertNoThrow(try PrototypeEmbeddedSpec.load(data: data, supported: ["prototype_future_v1"]))
    }

    private func spec(
        optional: Bool = false, dismiss: Bool = false, enabled: Bool = true
    )
        throws -> PrototypeSpec
    {
        let query = optional ? #""string?""# : #"{"type":"string","secret":true}"#
        let written = optional ? "ref" : "postId"
        let end = dismiss ? #",{"type":"dismiss"}"# : ""
        let capability = enabled ? #""prototype_links_v1""# : ""
        let text = #"""
        {"id":"links","window":{"placement":{"type":"fullscreen"}},
        "requires":[\#(capability)],"state":{"title":""},
        "root":{"type":"stack","id":"main","start":"feed",
        "screens":{"feed":{"type":"text","text":"Feed"},"post":{"type":"text","text":"Post {route.postId}"}},
        "routes":{"feed":{},"post":{"params":{"postId":"string","ref":"string"}}}},
        "links":[{"path":"/post/{postId}","query":{"ref":\#(query)},"actions":[
        {"type":"setState","key":"title","value":{"link":"\#(written)"}},
        {"type":"setStack","stack":"main","path":[{"screen":"feed"},
        {"screen":"post","params":{"postId":{"link":"postId"},"ref":{"link":"ref"}}}]}\#(end)]}]}
        """#
        return try JSONDecoder().decode(PrototypeSpec.self, from: Data(text.utf8))
    }

    private func shown(optional: Bool = false, dismiss: Bool = false, enabled: Bool = true) throws -> PrototypeSession {
        var session = PrototypeSession(clock: PrototypeLibraryFakeClock())
        try session.show(spec(optional: optional, dismiss: dismiss, enabled: enabled))
        return session
    }

    func testMatchBindsCaptureAndSecretQueryWithoutPlatformAndBackReturnsBelow() throws {
        var session = try shown()
        let events = session.openLink(
            "amp-demo://post/41?ref=private&%72ef=also-private&visible=yes#fragment",
            registeredSchemes: ["amp-demo"]
        )
        XCTAssertEqual(events.first?.wireKind, "link_opened")
        XCTAssertNil(events.first?.name)
        XCTAssertEqual(events.first?.payload, .object([
            "url": .string("amp-demo://post/41?visible=yes#fragment"), "entry": .string("/post/{postId}"),
        ]))
        XCTAssertEqual(session.state["title"], .string("41"))
        XCTAssertEqual(session.stacks["main"]?.path, ["feed", "post"])
        XCTAssertEqual(session.stacks["main"]?.entries.last?.params, [
            "postId": .string("41"), "ref": .string("private"),
        ])
        XCTAssertEqual(session.spec?.root.screens?["post"]?.text, "Post 41")
        XCTAssertEqual(events.first?.stacks["main"]?.path, ["feed"])
        _ = session.popTopmostStack()
        XCTAssertEqual(session.stacks["main"]?.path, ["feed"])
    }

    func testUnmatchedAndWrongSchemesDoNotExecuteAndAlwaysRedactSecrets() throws {
        var session = try shown()
        for url in ["amp-demo://missing", "amp-other://post/41", "https://evil.test/post/41"] {
            let events = session.openLink(url + "?ref=secret&%72ef=again", registeredSchemes: ["amp-demo"])
            XCTAssertEqual(events.count, 1)
            XCTAssertEqual(events.first?.wireKind, "link_unmatched")
            XCTAssertNil(events.first?.name)
            XCTAssertEqual(events.first?.payload, .object(["url": .string(url)]))
            XCTAssertEqual(session.state["title"], .string(""))
            XCTAssertEqual(session.stacks["main"]?.path, ["feed"])
        }
    }

    func testAcceptancePrecedesActionsAndDismissalIsFinal() throws {
        var session = try shown(dismiss: true)
        let events = session.openLink("amp-demo://post/41?ref=private", registeredSchemes: ["amp-demo"])
        XCTAssertEqual(events.first?.wireKind, "link_opened")
        XCTAssertNil(events.first?.name)
        XCTAssertEqual(events.first?.state["title"], .string(""))
        XCTAssertTrue(events.contains { $0.wireKind == "screen_changed" })
        XCTAssertEqual(events.last?.wireKind, "dismissed")
        XCTAssertEqual(events.map(\.sequence), Array(1 ... events.count))
        XCTAssertFalse(session.isShown)
    }

    func testAbsentOptionalBindingRefusesTheWholeActionListAfterAcceptance() throws {
        var session = try shown(optional: true)
        let events = session.openLink("amp-demo://post/41", registeredSchemes: ["amp-demo"])
        XCTAssertEqual(events.map(\.wireKind), ["link_opened"])
        XCTAssertNil(events.first?.name)
        XCTAssertEqual(session.state["title"], .string(""))
        XCTAssertEqual(session.stacks["main"]?.path, ["feed"])
    }

    func testMissingCapabilityOrSessionIgnoresURL() throws {
        var session = try shown(enabled: false)
        XCTAssertTrue(session.openLink("amp-demo://post/41?ref=private", registeredSchemes: ["amp-demo"]).isEmpty)
        session = PrototypeSession(clock: PrototypeLibraryFakeClock())
        XCTAssertTrue(session.openLink("amp-demo://post/41?ref=private", registeredSchemes: ["amp-demo"]).isEmpty)
    }

    func testRegistrationIsRequiredEvenWhenThePathMatches() throws {
        var session = try shown()
        let events = session.openLink("amp-demo://post/41?ref=private", registeredSchemes: [])
        XCTAssertEqual(events.map(\.wireKind), ["link_unmatched"])
        XCTAssertNil(events.first?.name)
        XCTAssertEqual(session.stacks["main"]?.path, ["feed"])
    }

    func testTypedQueryBindingsAndLiteralPayloads() throws {
        let decoder = JSONDecoder()
        let entries = try decoder.decode([JSONValue].self, from: Data(#"""
        [{"path":"/post/{postId}","query":{"page":"int","preview":"boolean"},"actions":[
        {"type":"emit","name":"opened","context":{"page":{"link":"page"},"preview":{"link":"preview"}},
        "payload":{"link":"literal"}}]}]
        """#.utf8))
        let routing = PrototypeInboundRouting(entries: entries)
        let match = try XCTUnwrap(routing.resolve("amp-demo://post/41?page=2&preview=true", schemes: ["amp-demo"]))
        let action = try XCTUnwrap(routing.actions(match).first)
        XCTAssertEqual(match.query, ["page": .number(2), "preview": .bool(true)])
        XCTAssertEqual(action.context?.bindings, [
            "page": .object(["value": .number(2)]), "preview": .object(["value": .bool(true)]),
        ])
        XCTAssertEqual(action.payload, .object(["link": .string("literal")]))
    }
}

@MainActor
final class PrototypeInboundLinkInboxTests: XCTestCase {
    private final class Target: PrototypeInboundLinkTarget {
        var isReadyForInboundLinks = false
        var urls: [String] = []
        func receiveInboundLink(_ url: String) { urls.append(url) }
    }

    func testColdDeliveryWaitsForShowAndWarmDeliveryIsSynchronous() {
        let inbox = PrototypeInboundLinkInbox()
        let target = Target()
        inbox.receive("amp-demo://post/41")
        inbox.attach(target)
        XCTAssertTrue(target.urls.isEmpty)
        target.isReadyForInboundLinks = true
        inbox.flush(target)
        XCTAssertEqual(target.urls, ["amp-demo://post/41"])
        inbox.receive("amp-demo://post/42")
        XCTAssertEqual(target.urls, ["amp-demo://post/41", "amp-demo://post/42"])
        inbox.flush(target)
        XCTAssertEqual(target.urls.count, 2)
    }

    func testOldControllerCannotDetachOrFlushTheNewController() {
        let inbox = PrototypeInboundLinkInbox()
        let old = Target()
        let current = Target()
        inbox.attach(old)
        inbox.attach(current)
        inbox.receive("amp-demo://post/41")
        old.isReadyForInboundLinks = true
        inbox.flush(old)
        inbox.detach(old)
        XCTAssertTrue(old.urls.isEmpty)
        current.isReadyForInboundLinks = true
        inbox.flush(current)
        XCTAssertEqual(current.urls, ["amp-demo://post/41"])
    }
}
