@testable import AutoMobilePrototypeAgentCore
import XCTest

/// Hunt: the `page_changed` event an iOS pager settle emits must match what Android's
/// `PrototypeRuntime.setPage` emits for the same spec and interaction (`emit(PAGE_CHANGED)` with no
/// name and no payload), because hosts match `awaitEvent` filters on `name`/`payload`.
final class HuntPageChangedParityTests: XCTestCase {
    private func pagerSession() throws -> PrototypeSession {
        var session = PrototypeSession()
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
        {"id":"a","window":{"placement":{"type":"fullscreen"}},
         "root":{"type":"pager","id":"p","children":[{"type":"spacer"},{"type":"spacer"}]}}
        """.utf8))
        session.show(spec)
        return session
    }

    func testPageChangedCarriesNoNameLikeAndroid() throws {
        var session = try pagerSession()
        let events = session.setPage("p", 1)
        XCTAssertEqual(events.map(\.kind), ["page_changed"])
        XCTAssertNil(events.first?.name, "Android emits page_changed with name == null")
    }

    func testPageChangedCarriesNullPayloadLikeAndroid() throws {
        var session = try pagerSession()
        let events = session.setPage("p", 1)
        XCTAssertEqual(events.first?.payload, .null, "Android emits page_changed with payload == null")
    }
}
