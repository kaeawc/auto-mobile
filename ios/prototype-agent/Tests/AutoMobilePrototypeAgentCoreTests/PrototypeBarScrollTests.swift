@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeBarScrollTests: XCTestCase {
    func testExitUntilCollapsedAndPinned() {
        var state = PrototypeBarScrollState()
        state.update(offset: 200)
        XCTAssertEqual(state.collapse("exitUntilCollapsed", extent: 88, reduced: false), 1)
        XCTAssertEqual(state.collapse("pinned", extent: 88, reduced: false), 0)
        state.update(offset: 44)
        XCTAssertEqual(state.collapse("exitUntilCollapsed", extent: 88, reduced: false), 0.5)
    }

    func testDirectionalHideAndEnterAlways() {
        var state = PrototypeBarScrollState()
        state.update(offset: 200)
        XCTAssertEqual(state.collapse("hide", extent: 64, reduced: false), 1)
        state.update(offset: 168)
        XCTAssertEqual(state.collapse("enterAlways", extent: 64, reduced: false), 0.5)
        state.update(offset: 120)
        XCTAssertEqual(state.collapse("hide", extent: 64, reduced: false), 0)
        state.update(offset: -20)
        XCTAssertEqual(state.offset, 0)
        XCTAssertEqual(state.collapse("none", extent: 64, reduced: false), 0)
    }

    func testLargeEnterAlwaysTracksItsFullHeight() {
        let extent = PrototypeBarScrollState.extent(variant: "large", behavior: "enterAlways")
        XCTAssertEqual(extent, 152)
        var state = PrototypeBarScrollState()
        state.update(offset: 200, extent: extent)
        state.update(offset: 124, extent: extent)
        XCTAssertEqual(state.collapse("enterAlways", extent: extent, reduced: false), 0.5)
    }

    func testReducedProfileSnapsAndMinimizeUsesDirectionalTravel() {
        var state = PrototypeBarScrollState()
        state.update(offset: 1)
        XCTAssertEqual(state.collapse("minimize", extent: 64, reduced: true), 1)
        XCTAssertEqual(state.collapse("exitUntilCollapsed", extent: 88, reduced: true), 1)
        state.update(offset: 200)
        state.update(offset: 199)
        XCTAssertEqual(state.collapse("hide", extent: 64, reduced: true), 0)
        state.update(offset: 0)
        XCTAssertEqual(state.collapse("hide", extent: 64, reduced: true), 0)
    }
}
