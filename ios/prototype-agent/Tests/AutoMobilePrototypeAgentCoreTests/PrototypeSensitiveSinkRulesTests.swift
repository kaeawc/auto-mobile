@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

final class PrototypeSensitiveSinkRulesTests: XCTestCase {
    private let message = "Sensitive value cannot be bound into a request"
    private let requestPath = "root.children[1].onTap[0]"

    private func json(_ text: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    }

    private func spec(
        _ sink: String = #"{"query":{"q":{"data":"/code"}}}"#,
        into: String = "/data/code"
    )
        throws -> [String: JSONValue]
    {
        var request = try XCTUnwrap(json(sink).objectFields)
        request["type"] = .string("request")
        request["url"] = request["url"] ?? .string("https://example.com/submit")
        request["via"] = .string("device")
        return try [
            "id": .string("sensitive-flow"),
            "window": json(#"{"placement":{"type":"fullscreen"}}"#),
            "requires": json(#"{"platform":["clipboard"]}"#),
            "root": .object(["type": .string("column"), "children": .array([
                .object(["type": .string("pasteButton"), "into": .string(into)]),
                .object(["type": .string("button"), "label": .string("Send"), "onTap": .array([.object(request)])]),
            ])]),
        ]
    }

    private func repeated(
        _ spec: [String: JSONValue],
        items: String,
        derive: String? = nil
    )
        throws -> [String: JSONValue]
    {
        var result = spec
        var root = try XCTUnwrap(result["root"]?.objectFields)
        var repeatFields: [String: JSONValue] = try ["items": json(items), "as": .string("row")]
        if let derive { repeatFields["derive"] = try json(derive) }
        root["repeat"] = .object(repeatFields)
        result["root"] = .object(root)
        return result
    }

    private func nestedRepeated(_ spec: [String: JSONValue], items: String) throws -> [String: JSONValue] {
        var result = spec
        var root = try XCTUnwrap(result["root"]?.objectFields)
        var children = PrototypeStrictBindings.array(root["children"])
        children[1] = try .object([
            "type": .string("column"),
            "repeat": .object(["items": json(items), "as": .string("row")]),
            "children": .array([children[1]]),
        ])
        root["children"] = .array(children)
        result["root"] = .object(root)
        return result
    }

    private func validate(
        _ spec: [String: JSONValue],
        path: String?,
        file: StaticString = #filePath,
        line: UInt = #line
    )
        throws
    {
        let data = try JSONEncoder().encode(JSONValue.object(spec))
        XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(data: data), file: file, line: line)
        if let path {
            XCTAssertThrowsError(
                try PrototypeSpecStrictValidator.validate(data: data, library: true),
                file: file,
                line: line
            ) {
                XCTAssertEqual(
                    $0 as? PrototypeLoadError,
                    .invalidSpec(path: path, message: self.message),
                    file: file,
                    line: line
                )
            }
        } else {
            XCTAssertNoThrow(
                try PrototypeSpecStrictValidator.validate(data: data, library: true),
                file: file,
                line: line
            )
        }
    }

    func testLibrarySinkAndNonLibraryGate() throws {
        try validate(spec(), path: "\(requestPath).query.q")
    }

    func testRequestSinkKindsAndOpaqueBindings() throws {
        for (sink, suffix) in [
            (#"{"query":{"q":{"data":"/code"}}}"#, "query.q"),
            (#"{"headers":{"Authorization":{"data":"/code"}}}"#, "headers.Authorization"),
            (#"{"method":"POST","body":{"data":"/code"}}"#, "body"),
            (#"{"method":"POST","body":{"form":{"q":{"data":"/code"}}}}"#, "body.form.q"),
            (
                #"{"method":"POST","body":{"multipart":[{"name":"q","value":{"data":"/code"}}]}}"#,
                "body.multipart[0].value"
            ),
            (#"{"url":"https://example.com/{data:/code}"}"#, "url"),
            (#"{"headers":{"X-Code":"{data:/code}"}}"#, #"headers["X-Code"]"#),
            (#"{"query":{"q":"{data:/code}"}}"#, "query.q"),
        ] {
            try validate(spec(sink), path: "\(requestPath).\(suffix)")
        }
        try validate(spec(#"{"query":{"q":{"value":"{data:/code}"}}}"#), path: nil)
        try validate(spec(#"{"query":{"q":{"data":"/other"}}}"#), path: nil)
        var handler = try spec()
        handler["requires"] = try json(#"{"platform":["clipboard","battery","realtime"]}"#)
        let request =
            #"[{"type":"request","url":"https://example.com/submit","via":"device","query":{"q":{"data":"/code"}}}]"#
        handler["platform"] = try json(#"{"on":{"battery.changed":\#(request)}}"#)
        try validate(handler, path: #"platform.on["battery.changed"][0].query.q"#)
    }

    func testSegmentOverlapAndLiteralTypedIndex() throws {
        for (into, pointer, refused) in [
            ("/data/user/name", "/user", true), ("/data/user/name", "/user/name/first", true),
            ("/data/user/name", "/user/email", false), ("/data/code", "/codeword", false),
            ("/data/users/0/token", "/users/{index}", false),
            ("/data/users/{index}/token", "/users/0", true),
            ("/data/users/{index}/token", "/other/0", false),
            ("/data/é", "/e\u{301}", false),
            ("/data/\u{301}x", "/\u{301}x", true),
        ] {
            let value = try repeated(
                spec(#"{"query":{"q":{"data":"\#(pointer)"}}}"#, into: into),
                items: #"[{"key":"code"}]"#
            )
            try validate(value, path: refused ? "\(requestPath).query.q" : nil)
        }
    }

    func testRepeatExpansionAndDerivedFallback() throws {
        for key in ["code", "other"] {
            let value = try nestedRepeated(
                spec(#"{"query":{"q":"{data:/{row.key}}"}}"#),
                items: #"[{"key":"\#(key)"}]"#
            )
            try validate(value, path: key == "code" ? "root.children[1].children[0].onTap[0].query.q" : nil)
        }
        for pointer in ["code", "other"] {
            let value = try repeated(
                spec(#"{"query":{"q":"{data:/\#(pointer)}{row.suffix}"}}"#),
                items: #"[{"n":2}]"#,
                derive: #"{"suffix":{"of":{"item":"n"},"format":{"number":{}}}}"#
            )
            try validate(value, path: pointer == "code" ? "\(requestPath).query.q" : nil)
        }
    }

    func testLiveDataBackedRowsAndLiteralRows() throws {
        for binding in [#""{row.code}""#, #"{"item":"code"}"#, #""static""#, #"{"value":"{row.code}"}"#] {
            for rows in [#"[{"code":"authored"}]"#, "[]"] {
                var value = try repeated(
                    spec(#"{"query":{"q":\#(binding)}}"#, into: "/data/rows/0/code"),
                    items: #"{"path":"/rows"}"#
                )
                value["data"] = try json(#"{"rows":\#(rows)}"#)
                let reads = binding == #""{row.code}""# || binding == #"{"item":"code"}"#
                try validate(value, path: reads ? "\(requestPath).query.q" : nil)
            }
            try validate(repeated(
                spec(#"{"query":{"q":\#(binding)}}"#, into: "/data/rows/0/code"),
                items: #"[{"code":"authored"}]"#
            ), path: nil)
        }
    }

    func testSortedFirstPath() throws {
        let value = try nestedRepeated(
            spec(#"{"query":{"z":"{data:/{row.key}}","a":"{data:/{row.key}}"}}"#),
            items: #"[{"key":"other"},{"key":"code"},{"key":"code"}]"#
        )
        try validate(value, path: "root.children[1].children[0].onTap[0].query.a")
        var secure = try spec(#"{"query":{"a":{"data":"/code"},"z":"{token}"}}"#)
        secure["state"] = try json(#"{"token":""}"#)
        var root = try XCTUnwrap(secure["root"]?.objectFields)
        root["children"] = try .array(PrototypeStrictBindings.array(root["children"]) + [
            json(#"{"type":"textField","stateKey":"token","secure":true}"#),
        ])
        secure["root"] = .object(root)
        XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(
            data: JSONEncoder().encode(JSONValue.object(secure)), library: true
        )) {
            XCTAssertEqual($0 as? PrototypeLoadError, .invalidSpec(
                path: "\(self.requestPath).query.z",
                message: "Secure value cannot be bound into a request"
            ))
        }
    }

    private func errors(_ spec: [String: JSONValue]) throws -> [PrototypeLoadError] {
        let context = try PrototypeContractValidator.inspect(JSONValue.object(spec))
        var repeats = PrototypeStrictRepeats(data: spec["data"]?.objectFields)
        var valid = true
        do { try repeats.templates(spec["root"]?.objectFields ?? [:], path: "root") }
        catch { valid = false }
        return PrototypeSensitiveSinkRules.errors(
            spec,
            nodes: context.locatedNodes,
            actions: context.actions,
            repeats: repeats,
            validRepeats: valid
        )
    }

    func testReportsEachAuthoredPathOnce() throws {
        let value = try nestedRepeated(
            spec(#"{"query":{"z":"{data:/{row.key}}","a":"{data:/{row.key}}"}}"#),
            items: #"[{"key":"other"},{"key":"code"},{"key":"code"}]"#
        )
        XCTAssertEqual(try errors(value), ["a", "z"].map {
            .invalidSpec(path: "root.children[1].children[0].onTap[0].query.\($0)", message: message)
        })
    }

    func testBudgetIncludesLiteralUTF8Bytes() throws {
        let text = String(repeating: "é", count: 16385)
        let value = try repeated(
            spec(#"{"query":{"q":"\#(text)"}}"#),
            items: "[" + Array(repeating: #"{"key":"other"}"#, count: 128)
                .joined(separator: ",") + "]"
        )
        // The policy budget also covers strings too large for the earlier contract gate.
        var repeats = PrototypeStrictRepeats(data: nil)
        let root = try XCTUnwrap(value["root"]?.objectFields)
        try repeats.templates(root, path: "root")
        let button = try XCTUnwrap(PrototypeStrictBindings.array(root["children"])[1].objectFields)
        let request = try XCTUnwrap(PrototypeStrictBindings.array(button["onTap"])[0].objectFields)
        XCTAssertEqual(
            PrototypeSensitiveSinkRules.errors(
                value,
                nodes: [],
                actions: [.init(value: request, path: requestPath)],
                repeats: repeats
            ),
            [.invalidSpec(
                path: "\(requestPath).query.q",
                message: "Secure binding scan exceeds 4194304 expanded UTF-8 bytes"
            )]
        )
    }

    func testInvalidRepeatsRetainAuthoredScan() throws {
        let value = try repeated(
            spec(#"{"query":{"q":"{data:/code}","unresolved":"{data:/{row.key}} {row.missing}"}}"#),
            items: #"[{"key":"code"}]"#
        )
        XCTAssertEqual(try errors(value), [.invalidSpec(path: "\(requestPath).query.q", message: message)])
    }

    func testPlatformCallsAndOpaquePayloads() throws {
        var value = try spec()
        var root = try XCTUnwrap(value["root"]?.objectFields)
        var children = PrototypeStrictBindings.array(root["children"])
        children[0] =
            try json(
                #"{"type":"button","label":"Paste","onTap":[{"type":"platform","call":"clipboard.paste","into":"/data/code"}]}"#
            )
        root["children"] = .array(children)
        value["root"] = .object(root)
        try validate(value, path: "\(requestPath).query.q")
        children[0] =
            try json(
                #"{"type":"button","label":"Emit","onTap":[{"type":"emit","name":"literal","payload":{"type":"platform","call":"clipboard.paste","into":"/data/code"}}]}"#
            )
        root["children"] = .array(children)
        value["root"] = .object(root)
        try validate(value, path: nil)
        children[0] =
            try json(
                #"{"type":"button","label":"Play","onTap":[{"type":"platform","call":"sound.play","args":{"sound":{"value":"click"}},"into":"/data/code"}]}"#
            )
        root["children"] = .array(children)
        value["root"] = .object(root)
        value["requires"] = try json(#"{"platform":["sound"]}"#)
        try validate(value, path: nil)
    }

    func testSharedLibraryFixtures() throws {
        let directory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec/library-sensitive")
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
        XCTAssertEqual(files.count, 7)
        for file in files {
            let fixture = try XCTUnwrap(JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: file)).objectFields)
            let value = try XCTUnwrap(fixture["spec"]?.objectFields)
            let path = fixture["expectedPath"]?.stringValue
            let expected: [PrototypeLoadError]
            if let path {
                expected = try [.invalidSpec(path: path, message: XCTUnwrap(fixture["expectedMessage"]?.stringValue))]
                XCTAssertEqual(fixture["options"]?.objectFields?["library"], .bool(true))
                XCTAssertNil(fixture["sinkOnly"])
            } else {
                expected = []
                XCTAssertNil(fixture["expectedMessage"])
                XCTAssertEqual(fixture["options"]?.objectFields?["library"], .bool(false))
                XCTAssertEqual(fixture["sinkOnly"], .bool(true))
            }
            XCTAssertEqual(try errors(value), expected, file.lastPathComponent)
            let data = try JSONEncoder().encode(JSONValue.object(value))
            XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(data: data), file.lastPathComponent)
            if path != nil {
                try validate(value, path: path)
            }
        }
    }
}
