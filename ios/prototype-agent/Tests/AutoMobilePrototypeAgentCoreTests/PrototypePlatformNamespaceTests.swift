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
}
