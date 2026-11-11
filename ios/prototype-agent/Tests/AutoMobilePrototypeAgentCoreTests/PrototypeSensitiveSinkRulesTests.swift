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
        message: String = "Sensitive value cannot be bound into a request",
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
                    .invalidSpec(path: path, message: message),
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

    func testNestedDataTokenConsumesTheWholePlaceholder() throws {
        try validate(spec(#"{"query":{"q":"{data:/other{data:/code}}"}}"#), path: nil)
        try validate(
            spec(#"{"query":{"q":"{data:/other{data:/code}}{data:/code}"}}"#),
            path: "\(requestPath).query.q"
        )
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

    private func copySpec(first: String, second: String, source: String = "platform", from: String = "/auth/userId")
        throws -> [String: JSONValue]
    {
        func copy(_ destination: String, source: String, from: String) -> JSONValue {
            .object([
                "type": .string("setData"), "path": .string("/data\(destination)"),
                "value": .object([source: .string(from)]),
            ])
        }
        return try [
            "id": .string("copy-utf16"),
            "window": json(#"{"placement":{"type":"fullscreen"}}"#),
            "requires": json(#"{"platform":["auth"]}"#),
            "root": .object(["type": .string("column"), "children": .array([
                .object([
                    "type": .string("button"), "label": .string("Unused copy"),
                    "onTap": .array([copy(first, source: "platform", from: "/auth/userId")]),
                ]),
                .object([
                    "type": .string("button"), "label": .string("Send"),
                    "onTap": .array([
                        copy(second, source: source, from: from),
                        .object([
                            "type": .string("request"), "url": .string("https://example.com/submit"),
                            "via": .string("device"), "method": .string("POST"),
                            "body": .object(["data": .string(second)]),
                        ]),
                    ]),
                ]),
            ])]),
        ]
    }

    func testCanonicalEquivalentCopyDestinationsStayDistinct() throws {
        let value = try copySpec(first: "/\u{00E9}", second: "/e\u{0301}")
        try validate(value, path: "root.children[1].onTap[1].body")
    }

    func testCombiningAccentAfterSlashRetainsParentCopyTaint() throws {
        let value = try copySpec(first: "/foo/\u{0301}bar", second: "/out", source: "data", from: "/foo")
        try validate(value, path: "root.children[1].onTap[1].body")
    }

    func testPlainSlashRetainsParentCopyTaint() throws {
        let value = try copySpec(first: "/foo/bar", second: "/out", source: "data", from: "/foo")
        try validate(value, path: "root.children[1].onTap[1].body")
    }

    func testManyTaintsAndUnrelatedBindingsCostBoundedOverlapChecks() throws {
        let taints = 3000
        let unrelated = 5000
        let copiesPerButton = 30
        let queriesPerRequest = 15
        let requestsPerButton = 30
        let copyButtons = taints / copiesPerButton
        let copies: [JSONValue] = (0 ..< copyButtons).map { button in
            .object([
                "type": .string("button"), "label": .string("Copy \(button)"),
                "onTap": .array((0 ..< copiesPerButton).map { offset in
                    .object([
                        "type": .string("setData"),
                        "path": .string("/data/copy\(button * copiesPerButton + offset)"),
                        "value": .object(["platform": .string("/auth/userId")]),
                    ])
                }),
            ])
        }
        let requestCount = (unrelated + queriesPerRequest - 1) / queriesPerRequest
        let requests: [JSONValue] = (0 ..< requestCount).map { request in
            var query: [String: JSONValue] = [:]
            for offset in 0 ..< min(queriesPerRequest, unrelated - request * queriesPerRequest) {
                let index = request * queriesPerRequest + offset
                query["q\(index)"] = .object(["data": .string("/unrelated\(index)")])
            }
            if request == 0 { query["secret"] = .object(["data": .string("/copy\(taints - 1)")]) }
            return .object([
                "type": .string("request"), "url": .string("https://example.com/submit"),
                "via": .string("device"), "query": .object(query),
            ])
        }
        let sends: [JSONValue] = stride(from: 0, to: requestCount, by: requestsPerButton).map { start in
            .object([
                "type": .string("button"), "label": .string("Send \(start)"),
                "onTap": .array(Array(requests[start ..< min(start + requestsPerButton, requestCount)])),
            ])
        }
        let value: [String: JSONValue] = try [
            "id": .string("sensitive-sink-scan"),
            "window": json(#"{"placement":{"type":"fullscreen"}}"#),
            "requires": json(#"{"platform":["auth"]}"#),
            "root": .object(["type": .string("column"), "children": .array(copies + sends)]),
        ]
        let context = try PrototypeContractValidator.inspect(.object(value))
        let result = PrototypeSensitiveSinkRules.scan(
            value, nodes: context.locatedNodes, actions: context.actions,
            repeats: PrototypeStrictRepeats(data: nil)
        )
        XCTAssertEqual(result.errors, [.invalidSpec(
            path: "root.children[\(copyButtons)].onTap[0].query.secret", message: message
        )])
        XCTAssertLessThanOrEqual(result.checks, 8 * (unrelated + 1) + taints)
    }

    private func stateCopySpec(_ copies: String, sink: String = #"{"query":{"q":{"data":"/leak"}}}"#)
        throws -> [String: JSONValue]
    {
        var value = try spec(sink)
        value["requires"] = try json(#"{"platform":["auth","clipboard"]}"#)
        value["state"] = try json(#"{"u":"","v":"","sel_3":"","other":""}"#)
        var root = try XCTUnwrap(value["root"]?.objectFields)
        var children = PrototypeStrictBindings.array(root["children"])
        var button = try XCTUnwrap(children[1].objectFields)
        button["onTap"] = try .array(PrototypeStrictBindings.array(json(copies)) +
            PrototypeStrictBindings.array(button["onTap"]))
        children[1] = .object(button)
        root["children"] = .array(children)
        value["root"] = .object(root)
        return value
    }

    func testStateRequestAndStorageSinks() throws {
        let copies = #"[{"type":"setState","key":"u","value":{"platform":"/auth/userId"}}]"#
        for (sink, suffix) in [
            (#"{"query":{"q":{"state":"u"}}}"#, "query.q.state"),
            (#"{"query":{"q":"{u}"}}"#, "query.q"),
            (#"{"url":"https://example.com/{u}"}"#, "url"),
            (#"{"headers":{"Authorization":{"state":"u"}}}"#, "headers.Authorization.state"),
            (#"{"method":"POST","body":{"state":"u"}}"#, "body.state"),
            (#"{"method":"POST","body":{"form":{"q":{"state":"u"}}}}"#, "body.form.q.state"),
            (
                #"{"method":"POST","body":{"multipart":[{"name":"q","value":{"state":"u"}}]}}"#,
                "body.multipart[0].value.state"
            ),
        ] {
            try validate(stateCopySpec(copies, sink: sink), path: "root.children[1].onTap[1].\(suffix)")
        }
        var stored = try stateCopySpec(copies)
        stored["storage"] = try json(#"{"version":1,"keys":["state:u"]}"#)
        XCTAssertEqual(try errors(stored), [.invalidSpec(
            path: "storage.keys[0]", message: "Sensitive value cannot be persisted"
        )])
        var channel = try stateCopySpec(copies)
        channel["channels"] = try json(#"{"live":{"kind":"sse","via":"device","url":"https://example.com/{u}"}}"#)
        XCTAssertEqual(try errors(channel), [.invalidSpec(path: "channels.live.url", message: message)])
    }

    func testStateTextSourcesAndCleanWrites() throws {
        for source in [#"{"platform":"/auth/userId"}"#, #""{platform:/auth/userId}""#, #""{data:/code}""#] {
            let copies =
                #"[{"type":"setState","key":"u","value":\#(source)},{"type":"setState","key":"u","value":"guest"},{"type":"setData","path":"/data/leak","value":{"state":"u"}}]"#
            try validate(stateCopySpec(copies), path: "root.children[1].onTap[3].query.q")
        }
        for source in [#""guest""#, #""""#, #""{data:/other}""#, #"{"platform":"/auth/signedIn"}"#] {
            let copies =
                #"[{"type":"setState","key":"u","value":\#(source)},{"type":"setData","path":"/data/leak","value":{"state":"u"}}]"#
            try validate(stateCopySpec(copies), path: nil)
        }
        let copies = #"[{"type":"setState","key":"u","value":{"platform":"/auth/userId"}}]"#
        try validate(stateCopySpec(copies, sink: #"{"query":{"q":{"value":"{u}"}}}"#), path: nil)
        try validate(stateCopySpec(copies, sink: #"{"query":{"q":{"state":"v"}}}"#), path: nil)
    }

    func testTemplatedStateKeysMatchLiteralPrefixes() throws {
        for (taint, read, refused) in [
            ("sel_{index}", "sel_3", true), ("sel_3", "sel_{index}", true),
            ("sel_{index}", "other", false), ("sel_{index}", "pick_{row.id}", false),
            ("s{index}", "sel_{row.id}", true), ("{row.key}", "anything", true),
            ("u", "user", false), ("user", "u", false),
        ] {
            // Scan authored keys directly: they may be bound from live rows after validation.
            let copies =
                #"[{"type":"setState","key":"\#(taint)","value":{"platform":"/auth/userId"}},{"type":"setData","path":"/data/leak","value":{"state":"\#(read)"}}]"#
            XCTAssertEqual(try errors(stateCopySpec(copies)), refused ? [.invalidSpec(
                path: "root.children[1].onTap[2].query.q", message: message
            )] : [], "\(taint) -> \(read)")
            let sink = #"{"query":{"q":{"state":"\#(read)"}}}"#
            let direct = #"[{"type":"setState","key":"\#(taint)","value":{"platform":"/auth/userId"}}]"#
            XCTAssertEqual(try errors(stateCopySpec(direct, sink: sink)), refused ? [.invalidSpec(
                path: "root.children[1].onTap[1].query.q.state", message: message
            )] : [])
        }
        let copies = #"[{"type":"setState","key":"sel_{index}","value":{"platform":"/auth/userId"}}]"#
        XCTAssertEqual(try errors(stateCopySpec(copies, sink: #"{"query":{"q":"{sel_9}"}}"#)), [.invalidSpec(
            path: "root.children[1].onTap[1].query.q", message: message
        )])
    }

    func testStateWorkSpendsCopyAndSinkCheckBudgets() throws {
        let copies =
            #"[{"type":"setState","key":"u","value":{"platform":"/auth/userId"}},{"type":"setData","path":"/data/leak","value":{"state":"u"}}]"#
        let value = try stateCopySpec(copies)
        let context = try PrototypeContractValidator.inspect(.object(value))
        let platformTaints = 1 // auth.userId; clipboard has no sensitive platform state
        let result = PrototypeSensitiveSinkRules.scan(
            value, nodes: context.locatedNodes, actions: context.actions,
            repeats: PrototypeStrictRepeats(data: nil), maxChecks: platformTaints
        )
        XCTAssertEqual(result.errors, [.invalidSpec(
            path: "$", message: "Secure copy taint analysis exceeds 4000000 overlap checks"
        )])
        XCTAssertEqual(result.checks, 0) // Propagation, rather than the sink scan, exhausted the cap.

        let direct = try stateCopySpec(
            #"[{"type":"setState","key":"u","value":{"platform":"/auth/userId"}}]"#,
            sink: #"{"query":{"q":"{v}{u}"}}"#
        )
        let directContext = try PrototypeContractValidator.inspect(.object(direct))
        let scanned = PrototypeSensitiveSinkRules.scan(
            direct, nodes: directContext.locatedNodes, actions: directContext.actions,
            repeats: PrototypeStrictRepeats(data: nil), maxChecks: platformTaints
        )
        XCTAssertEqual(scanned.errors, [.invalidSpec(path: "root.children[1].onTap[1].query.q", message: message)])
        XCTAssertEqual(scanned.checks, 1) // One tainted state key was compared in the text sink.

        for sink in [
            #"{"query":{"a":"{u}","z":"{u}"}}"#,
            #"{"query":{"q":{"state":"u{index}"}}}"#,
        ] {
            let exhausted = try stateCopySpec(
                #"[{"type":"setState","key":"u","value":{"platform":"/auth/userId"}}]"#,
                sink: sink
            )
            let inspected = try PrototypeContractValidator.inspect(.object(exhausted))
            let result = PrototypeSensitiveSinkRules.scan(
                exhausted, nodes: inspected.locatedNodes, actions: inspected.actions,
                repeats: PrototypeStrictRepeats(data: nil), maxChecks: platformTaints
            )
            XCTAssertEqual(result.errors, [.invalidSpec(
                path: "$", message: "Secure copy taint analysis exceeds 4000000 overlap checks"
            )])
            XCTAssertEqual(result.checks, 2)
        }
    }

    func testSharedLibraryFixtures() throws {
        let directory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec/library-sensitive")
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
        XCTAssertFalse(files.isEmpty)
        XCTAssertTrue(files.contains { $0.lastPathComponent == "repeat-item-copy.json" })
        XCTAssertEqual(Set(files.map(\.lastPathComponent).filter { $0.hasPrefix("state-") }), [
            "state-copy-to-data.json", "state-repeat-index.json", "state-taint-without-sink.json",
            "state-two-key-chain.json", "state-untainted-copy.json",
        ])
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
                try validate(value, path: path, message: XCTUnwrap(fixture["expectedMessage"]?.stringValue))
            } else if file.lastPathComponent.hasPrefix("platform-") {
                try validate(value, path: nil)
            }
            if file.lastPathComponent == "repeat-item-copy.json" {
                var clean = value
                var root = try XCTUnwrap(clean["root"]?.objectFields)
                var children = PrototypeStrictBindings.array(root["children"])
                var source = try XCTUnwrap(children[0].objectFields)
                source["into"] = .string("/data/other")
                children[0] = .object(source)
                root["children"] = .array(children)
                clean["root"] = .object(root)
                try validate(clean, path: nil)
            }
        }
    }
}
