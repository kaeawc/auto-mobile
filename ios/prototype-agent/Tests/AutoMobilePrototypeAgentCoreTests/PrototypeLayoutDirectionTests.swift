@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

final class PrototypeLayoutDirectionTests: XCTestCase {
    func testExplicitDirectionOverridesEitherHost() {
        for host in [PrototypeLayoutDirection.ltr, .rtl] {
            XCTAssertEqual(PrototypeLayoutDirection.resolve(.rtl, host: host), .rtl)
            XCTAssertEqual(PrototypeLayoutDirection.resolve(.ltr, host: host), .ltr)
            XCTAssertEqual(PrototypeLayoutDirection.resolve(nil, host: host), host)
        }
    }

    func testWindowDecodingReachesRendererAndRejectsAuto() throws {
        for direction in ["ltr", "rtl"] {
            let data = Data("{\"placement\":{\"type\":\"fullscreen\"},\"layoutDirection\":\"\(direction)\"}".utf8)
            let window = try JSONDecoder().decode(WindowSpec.self, from: data)
            XCTAssertEqual(window.layoutDirection?.rawValue, direction)
        }
        let inherited = try JSONDecoder().decode(
            WindowSpec.self,
            from: Data(#"{"placement":{"type":"fullscreen"}}"#.utf8)
        )
        XCTAssertNil(inherited.layoutDirection)
        XCTAssertThrowsError(try JSONDecoder().decode(
            WindowSpec.self,
            from: Data(#"{"placement":{"type":"fullscreen"},"layoutDirection":"auto"}"#.utf8)
        ))
    }
}
