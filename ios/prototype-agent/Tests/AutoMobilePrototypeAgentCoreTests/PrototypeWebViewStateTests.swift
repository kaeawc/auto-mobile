@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeWebViewStateTests: XCTestCase {
    private func webView() throws -> PrototypeSpec {
        try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
        {"id":"w","window":{"placement":{"type":"fullscreen"}},"requires":{"platform":["webview"]},
         "state":{"nav":"","title":"","back":false},
         "root":{"type":"webView","id":"page","url":"https://example.com/","allowedOrigins":["https://example.com"],
                 "navigationStateKey":"nav","titleKey":"title","canGoBackKey":"back"}}
        """.utf8))
    }

    func testStateWriteRechecksWebViewKeyTypes() throws {
        let root = try webView().root
        let valid: [String: JSONValue] = ["nav": .string(""), "title": .string(""), "back": .bool(false)]
        XCTAssertNil(PrototypeStateValidator.rejection(root: root, state: valid))
        var back = valid
        back["back"] = .string("yes")
        XCTAssertEqual(
            PrototypeStateValidator.rejection(root: root, state: back),
            "canGoBackKey must name a declared boolean state key"
        )
        var title = valid
        title["title"] = .bool(true)
        XCTAssertEqual(
            PrototypeStateValidator.rejection(root: root, state: title),
            "titleKey must name a declared string state key"
        )
    }
}
