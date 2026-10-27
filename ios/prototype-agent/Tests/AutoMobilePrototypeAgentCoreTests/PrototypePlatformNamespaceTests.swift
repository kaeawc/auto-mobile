@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypePlatformNamespaceTests: XCTestCase {
    func testCodableIgnoresNamespaceBlocksWithoutChangingPortableValues() throws {
        let input = #"""
        {"id":"namespaces","window":{"placement":{"type":"fullscreen"},"ios":{"sheet":{"sizing":"form"}},"android":{}},
         "theme":{"ios":{"hover":"lift"},"android":{"indication":"none"}},
         "data":{"ios":{"hover":"lift"}},
         "root":{"type":"column","ios":{},"children":[{"type":"text","text":"Hi","android":{"indication":"ripple"}}]}}
        """#
        let bytes = Data(input.utf8)
        try PrototypeSpecStrictValidator.validate(data: bytes)
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: bytes)
        XCTAssertEqual(spec.id, "namespaces")
        XCTAssertEqual(spec.root.type, "column")
        XCTAssertEqual(spec.root.children?.first?.text, "Hi")
        XCTAssertNotNil(spec.data?["ios"])
    }

    func testAccessoryCapabilitiesAndReferencesAreIgnored() throws {
        let input =
            #"{"id":"ns","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Shown","ios":{"bottomAccessory":{"type":"text","text":"Hidden","android":{"indication":"none"},"onTap":[{"type":"emit","name":"hidden","context":{"hidden":{"data":"/hidden"}}}]}}}}"#
        let data = Data(input.utf8)
        let (value, context) = try PrototypeContractValidator.inspect(data: data)
        XCTAssertEqual(context.locatedNodes.count, 1)
        XCTAssertTrue(context.actions.isEmpty)
        XCTAssertEqual(
            try PrototypeStrictCapabilities.required(XCTUnwrap(value.objectFields)),
            ["prototype_platform_namespace_v1"]
        )
    }
}
