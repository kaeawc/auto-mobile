@testable import AutoMobilePrototypeAgentCore
import XCTest

@MainActor
final class PrototypeClipboardTests: XCTestCase {
    private func call(_ op: String, args: [String: JSONValue] = [:]) -> PlatformCall {
        PlatformCall(callId: "clipboard", call: "clipboard." + op, args: args)
    }

    func testCopySensitiveAndHasText() async {
        let clipboard = FakePrototypeClipboard()
        let module = PrototypeClipboardModule(clipboard: clipboard)
        let result = await module.call(call(
            "copy",
            args: ["text": .string("secret"), "sensitive": .bool(true), "label": .string("Code")]
        ))
        XCTAssertEqual(result, .success(.object(["op": .string("copy"), "bytes": .number(6)])))
        XCTAssertEqual(clipboard.text, "secret")
        XCTAssertTrue(clipboard.sensitive)
        XCTAssertEqual(clipboard.label, "Code")
        XCTAssertEqual(clipboard.platformCalls, [.object(["op": .string("copy"), "bytes": .number(6)])])
        let hasText = await module.call(call("hasText"))
        XCTAssertEqual(hasText, .success(.bool(true)))
    }

    func testEmptyAndDenied() async {
        let clipboard = FakePrototypeClipboard()
        let module = PrototypeClipboardModule(clipboard: clipboard)
        let empty = await module.call(call("paste"))
        XCTAssertEqual(empty, .success(.object(["text": .string(""), "truncated": .bool(false)])))
        clipboard.denied = true
        let denied = await module.call(call("paste"))
        XCTAssertEqual(denied, .failure(.permissionDenied, "Clipboard permission denied"))
    }

    func testTruncationAtUTF8ScalarBoundary() {
        let text = String(repeating: "a", count: 65535) + "🧑"
        XCTAssertEqual(
            PrototypeClipboardModule.pasteValue(text),
            .object(["text": .string(String(repeating: "a", count: 65535)), "truncated": .bool(true)])
        )
        XCTAssertEqual(
            PrototypeClipboardModule.pasteValue(String(repeating: "é", count: 32768)).objectFields?["truncated"],
            .bool(false)
        )
    }

    func testRejectsOverLimitCopy() async {
        let clipboard = FakePrototypeClipboard()
        let result = await PrototypeClipboardModule(clipboard: clipboard).call(call(
            "copy",
            args: ["text": .string(String(repeating: "é", count: 32769))]
        ))
        XCTAssertEqual(result, .failure(.invalidArgs, "Invalid clipboard text"))
        XCTAssertEqual(clipboard.text, "")
    }

    func testPasteWritesDataStatusAndSafeCompletion() async throws {
        let raw =
            #"{"id":"clipboard","window":{"placement":{"type":"fullscreen"}},"requires":{"platform":["clipboard"]},"data":{},"state":{"status":"idle"},"root":{"type":"spacer"}}"#
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data(raw.utf8))
        let action = try JSONDecoder().decode(
            PrototypeAction.self,
            from: Data(#"{"type":"platform","call":"clipboard.paste","into":"/data/code","statusKey":"status"}"#.utf8)
        )
        var session = PrototypeSession()
        session.show(spec)
        _ = session.run([action])
        let commands = session.takePlatformCommands()
        guard case let .start(job)? = commands.first else { return XCTFail("Missing clipboard job") }
        let module = PrototypeClipboardModule(clipboard: FakePrototypeClipboard(text: "invite"))
        let result = await module.call(job.call)
        let events = session.completePlatformCall(job.call.callId, result, durationMs: 0)
        XCTAssertEqual(session.data?["code"], .object(["text": .string("invite"), "truncated": .bool(false)]))
        XCTAssertEqual(session.state["status"], .string("success"))
        let payload = events.last?.payload.objectFields
        XCTAssertEqual(payload?["op"], .string("paste"))
        XCTAssertEqual(payload?["bytes"], .number(6))
        XCTAssertNil(payload?["text"])
    }

    func testSystemPasteButtonUsesProvidedPayloadWithoutARead() throws {
        let raw =
            #"{"id":"clipboard","window":{"placement":{"type":"fullscreen"}},"requires":{"platform":["clipboard"]},"data":{},"root":{"type":"pasteButton","into":"/data/code"}}"#
        var session = PrototypeSession()
        try session.show(JSONDecoder().decode(PrototypeSpec.self, from: Data(raw.utf8)))
        let events = session.pasteClipboard("invite", into: "/data/code")
        XCTAssertTrue(session.takePlatformCommands().isEmpty)
        XCTAssertEqual(session.data?["code"], PrototypeClipboardModule.pasteValue("invite"))
        XCTAssertEqual(events.last?.name, "prototype_platform")
        XCTAssertEqual(events.last?.payload.objectFields?["bytes"], .number(6))
    }
}
