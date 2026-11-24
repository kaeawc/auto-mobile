@testable import AutoMobilePrototypeAgentCore
import XCTest

/// Twin of Kotlin `PrototypeSecureStorageRulesTest` and TypeScript `prototypeSecureStorage.test.ts`: secure
/// `{state}` bindings cannot leave through route params or platform-call args (#14321).
final class PrototypeSecureStorageBindingTests: XCTestCase {
    private func spec(_ action: String) -> Data {
        Data(#"""
        {"id":"secure-routes","window":{"placement":{"type":"fullscreen"}},
         "requires":{"platform":["secureStorage","share"]},
         "state":{"token":"","public":"hello"},
         "storage":{"version":1,"keys":["stack:nav"],"secure":["state:token"]},
         "root":{"type":"stack","id":"nav","start":"home","screens":{
          "home":{"type":"button","label":"Go","onTap":[\#(action)]},
          "detail":{"type":"text","text":"Detail"}},
          "routes":{"detail":{"params":{"t":"string"}}}}}
        """#.utf8)
    }

    private func navigation(_ type: String, _ binding: String) -> String {
        type == "setStack"
            ?
            #"{"type":"setStack","stack":"nav","path":[{"screen":"home"},{"screen":"detail","params":{"t":\#(binding)}}]}"#
            : #"{"type":"\#(type)","stack":"nav","screen":"detail","params":{"t":\#(binding)}}"#
    }

    private func assertRejected(_ action: String, path: String, message: String, line: UInt = #line) {
        XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(data: spec(action)), line: line) { error in
            XCTAssertEqual(error as? PrototypeLoadError, .invalidSpec(path: path, message: message), line: line)
        }
    }

    func testNavigationRefusesSecureStateWithTheKotlinMessage() {
        for type in ["push", "replace", "setStack"] {
            assertRejected(
                navigation(type, #"{"state":"token"}"#),
                path: "root.screens[\"home\"].onTap[0]." + (type == "setStack" ? "path[1].params.t" : "params.t"),
                message: "Secure storage key state:token cannot be sent in route params"
            )
        }
    }

    func testPlatformArgsRefuseSecureState() {
        assertRejected(
            #"{"type":"platform","call":"share.open","args":{"text":{"state":"token"}}}"#,
            path: "root.screens[\"home\"].onTap[0].args.text",
            message: "Secure storage key state:token cannot be sent in platform args"
        )
    }

    func testBindingsAreCheckedInSortedOrderWithQuotedMemberPaths() throws {
        let fields: [String: JSONValue] = [
            "type": .string("platform"),
            "args": .object(["z": .object(["state": .string("token")]),
                             "a-b": .object(["state": .string("tok{item.id}")])]),
        ]
        XCTAssertThrowsError(try PrototypeSecureStorageRules.validateBindings(
            fields, path: "root.onTap[0]", secure: ["state:token"]
        )) { error in
            XCTAssertEqual(error as? PrototypeLoadError, .invalidSpec(
                path: #"root.onTap[0].args["a-b"]"#,
                message: "Secure storage key state:token cannot be sent in platform args"
            ))
        }
    }

    func testPublicBindingsLiteralPlaceholdersAndSpecsWithoutSecureKeysPass() throws {
        for type in ["push", "replace", "setStack"] {
            for binding in [#"{"state":"public"}"#, #""{token}""#] {
                XCTAssertNoThrow(
                    try PrototypeSpecStrictValidator.validate(data: spec(navigation(type, binding))),
                    "\(type) \(binding)"
                )
            }
        }
        for binding in [#"{"state":"public"}"#, #"{"value":"{token}"}"#] {
            XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(data: spec(
                #"{"type":"platform","call":"share.open","args":{"text":\#(binding)}}"#
            )))
        }
        let plain: [String: JSONValue] = [
            "type": .string("push"), "params": .object(["t": .object(["state": .string("token")])]),
        ]
        XCTAssertNoThrow(try PrototypeSecureStorageRules.validateBindings(plain, path: "p", secure: []))
    }

    // MARK: - Derived bindings (#19013)

    private let derive: [String: JSONValue] = [
        "secret": .object(["of": .object(["state": .string("token")]), "format": .object(["number": .object([:])])]),
        "matching": .object([
            "collection": .object([
                "of": .object(["data": .string("/rows")]),
                "where": .array([.object([
                    "field": .string("t"), "op": .string("eq"), "value": .object(["state": .string("token")]),
                ])]),
            ]),
            "reduce": .object(["op": .string("count")]),
        ]),
        "open": .object(["of": .object(["state": .string("public")]), "format": .object(["number": .object([:])])]),
    ]

    private func assertRuleRejects(
        _ fields: [String: JSONValue], path: String, message: String, line: UInt = #line,
        _ check: ([String: JSONValue]) throws -> Void
    ) {
        XCTAssertThrowsError(try check(fields), line: line) { error in
            XCTAssertEqual(error as? PrototypeLoadError, .invalidSpec(path: path, message: message), line: line)
        }
    }

    func testRouteParamsAndPlatformArgsRefuseDerivedSecureState() {
        let route = "Secure storage key state:token cannot be sent in route params"
        for name in ["secret", "matching"] {
            let binding: JSONValue = .object(["derived": .string(name)])
            let cases: [([String: JSONValue], String, String)] = [
                (["type": .string("push"), "params": .object(["t": binding])], "p.params.t", route),
                (["type": .string("replace"), "params": .object(["t": binding])], "p.params.t", route),
                (
                    ["type": .string("setStack"), "path": .array([.object(["params": .object(["t": binding])])])],
                    "p.path[0].params.t", route
                ),
                (
                    ["type": .string("platform"), "args": .object(["text": binding])], "p.args.text",
                    "Secure storage key state:token cannot be sent in platform args"
                ),
            ]
            for (fields, path, message) in cases {
                assertRuleRejects(fields, path: path, message: message) {
                    try PrototypeSecureStorageRules.validateBindings(
                        $0,
                        path: "p",
                        secure: ["state:token"],
                        derive: derive
                    )
                }
            }
        }
        let open: [String: JSONValue] = [
            "type": .string("push"),
            "params": .object(["t": .object(["derived": .string("open")])]),
        ]
        XCTAssertNoThrow(try PrototypeSecureStorageRules.validateBindings(
            open, path: "p", secure: ["state:token"], derive: derive
        ))
    }

    func testEmitRequestAndDataActionsRefuseDerivedSecureState() {
        for name in ["secret", "matching"] {
            let binding: JSONValue = .object(["derived": .string(name)])
            assertRuleRejects(
                ["type": .string("emit"), "name": .string("x"), "context": .object(["t": binding])],
                path: "p.context.t", message: "Secure storage key state:token cannot be sent in an emit context"
            ) { try PrototypeSecureStorageRules.validateEmit($0, path: "p", secure: ["state:token"], derive: derive) }
            assertRuleRejects(
                ["type": .string("request"), "url": .string("https://a.test"), "query": .object(["t": binding])],
                path: "p.query.t",
                message: "Secure storage key state:token cannot be sent in a request without allowSecureInRequest"
            ) { try PrototypeSecureStorageRules.validateRequest($0, path: "p", secure: ["state:token"], derive: derive)
            }
            assertRuleRejects(
                ["type": .string("setData"), "path": .string("/data/copy"), "value": binding],
                path: "p.value", message: "Secure storage key state:token cannot be sent in data actions"
            ) {
                try PrototypeSecureStorageRules.validateDataAction(
                    $0, path: "p", secure: ["state:token"], derive: derive
                )
            }
        }
    }

    func testContractHasNoDerivedFormForRouteParamsOrPlatformArgs() {
        let data = Data(#"""
        {"id":"secure-routes","window":{"placement":{"type":"fullscreen"}},
         "requires":{"platform":["secureStorage","share"]},
         "state":{"token":"","public":"hello"},
         "storage":{"version":1,"keys":[],"secure":["state:token"]},
         "derive":{"secret":{"of":{"state":"token"},"format":{"number":{}}}},
         "root":{"type":"button","label":"Go","onTap":[
          {"type":"platform","call":"share.open","args":{"text":{"derived":"secret"}}}]}}
        """#.utf8)
        XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(data: data))
    }
}
