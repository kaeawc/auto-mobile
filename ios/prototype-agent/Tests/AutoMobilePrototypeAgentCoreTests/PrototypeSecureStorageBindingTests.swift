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
            ? #"{"type":"setStack","stack":"nav","path":[{"screen":"home"},{"screen":"detail","params":{"t":\#(binding)}}]}"#
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
}
