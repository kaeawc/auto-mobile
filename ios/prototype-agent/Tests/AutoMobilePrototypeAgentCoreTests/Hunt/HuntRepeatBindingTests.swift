@testable import AutoMobilePrototypeAgentCore
import XCTest

/// Hunt: `repeat` placeholder binding must agree with the shared grammar in
/// `src/features/prototype/prototypeTemplate.ts` (a plain scan for `}` over UTF-16 code units).
final class HuntRepeatBindingTests: XCTestCase {
    private func texts(_ template: String, item: String) throws -> [String?] {
        let json = """
        {"id":"a","window":{"placement":{"type":"fullscreen"}},
         "root":{"type":"column","repeat":{"as":"item","items":[\(item)]},
                 "children":[{"type":"text","text":\(template)}]}}
        """
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data(json.utf8))
        return (spec.root.children ?? []).map(\.text)
    }

    /// TS binds `{item.n}\u{301}` to `x\u{301}`; Swift compares grapheme clusters, so `}` + a
    /// combining mark is one Character that is not `}` and the placeholder is left literal.
    func testPlaceholderFollowedByCombiningMarkIsStillBound() throws {
        let result = try texts(#""{item.n}́""#, item: #"{"n":"x"}"#)
        XCTAssertEqual(result, ["x\u{301}"])
    }
}
