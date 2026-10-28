@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypePresenterWindowTests: XCTestCase {
    private typealias Candidate = PrototypePresenterWindow.Candidate

    private let app = Candidate(isPrototypeOverlay: false, isKey: true, isHidden: false)
    private let overlay = Candidate(isPrototypeOverlay: true, isKey: false, isHidden: false)

    func testTheVisiblePrototypeOverlayPresentsOverTheKeyAppWindow() {
        XCTAssertEqual(PrototypePresenterWindow.index(of: [app, overlay]), 1)
    }

    func testAHiddenOverlayLeavesTheKeyWindowToPresent() {
        let hidden = Candidate(isPrototypeOverlay: true, isKey: false, isHidden: true)
        XCTAssertEqual(PrototypePresenterWindow.index(of: [hidden, app]), 1)
    }

    func testWithoutAKeyWindowTheFirstVisibleWindowPresents() {
        let hidden = Candidate(isPrototypeOverlay: false, isKey: false, isHidden: true)
        let other = Candidate(isPrototypeOverlay: false, isKey: false, isHidden: false)
        XCTAssertEqual(PrototypePresenterWindow.index(of: [hidden, other]), 1)
        XCTAssertNil(PrototypePresenterWindow.index(of: [hidden]))
        XCTAssertNil(PrototypePresenterWindow.index(of: []))
    }
}
