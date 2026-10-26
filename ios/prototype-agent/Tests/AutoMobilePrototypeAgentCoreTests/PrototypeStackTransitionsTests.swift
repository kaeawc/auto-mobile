@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeStackTransitionsTests: XCTestCase {
    private func spec(_ transition: String = "", actions: String = "") -> Data {
        Data("""
        {"id":"a","window":{"placement":{"type":"fullscreen"}},"root":{"type":"stack","id":"nav","start":"home"\(
            transition
        ),"screens":{"home":{"type":"text","text":"x"\(actions)}}}}
        """.utf8)
    }

    func testEnumMatchesSharedContract() throws {
        let (_, validator) = try PrototypeContractValidator.inspect(data: spec())
        let values = validator.definitions["stackTransition"]?.objectFields?["values"]
        XCTAssertEqual(values, .array(PrototypeStackTransition.allCases.map { .string($0.rawValue) }))
    }

    func testValuesDecodeOnStacksAndActions() throws {
        for transition in PrototypeStackTransition.allCases {
            let actions =
                #", "onTap":[{"type":"push","stack":"nav","screen":"home","transition":"\#(transition.rawValue)"},{"type":"replace","stack":"nav","screen":"home","transition":"\#(transition.rawValue)"}]"#
            let data = spec(#", "transition":"\#(transition.rawValue)""#, actions: actions)
            XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(data: data))
            let decoded = try JSONDecoder().decode(PrototypeSpec.self, from: data)
            XCTAssertEqual(decoded.root.transition, transition.rawValue)
            XCTAssertEqual(decoded.root.screens?["home"]?.onTap?.first?.transition, transition)
            XCTAssertEqual(decoded.root.screens?["home"]?.onTap?.last?.transition, transition)
            XCTAssertEqual(
                try PrototypeBundleCapabilities.required(data),
                ["prototype_stack_transitions_v1", "prototype_stack_v1"]
            )
        }
    }

    func testInvalidEnumsObjectsAndPopOverridesAreRejected() {
        for bad in [#""scale""#, #""sharedAxisX""#, #"{"type":"fade"}"#, "null"] {
            XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(data: spec(",\"transition\":\(bad)")))
            for type in ["push", "replace"] {
                let actions = #", "onTap":[{"type":"\#(type)","stack":"nav","screen":"home","transition":\#(bad)}]"#
                XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(data: spec(actions: actions)))
            }
        }
        for type in ["pop", "popToRoot"] {
            let actions = #", "onTap":[{"type":"\#(type)","stack":"nav","transition":"none"}]"#
            XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(data: spec(actions: actions)))
        }
    }

    func testMissingCapabilityFailsClosed() {
        let data = spec(#", "transition":"platform""#)
        XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(
            data: data,
            supportedCapabilities: ["prototype_stack_v1"]
        ))
        XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(
            data: data,
            supportedCapabilities: ["prototype_stack_v1", "prototype_stack_transitions_v1"]
        ))
    }

    func testStrictCapabilitiesAndDefault() throws {
        for data in [
            spec(#", "transition":"platform""#),
            spec(actions: #", "onTap":[{"type":"push","stack":"nav","screen":"home","transition":"fade"}]"#),
        ] {
            let fields = try XCTUnwrap(JSONDecoder().decode(JSONValue.self, from: data).objectFields)
            XCTAssertEqual(
                PrototypeStrictCapabilities.required(fields),
                ["prototype_stack_v1", "prototype_stack_transitions_v1"]
            )
        }
        let fields = try XCTUnwrap(JSONDecoder().decode(JSONValue.self, from: spec()).objectFields)
        XCTAssertEqual(PrototypeStrictCapabilities.required(fields), ["prototype_stack_v1"])
    }
}
