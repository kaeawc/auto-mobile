@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeNativePresentationHitRegionTests: XCTestCase {
    private let window = CGRect(x: 0, y: 0, width: 400, height: 800)
    private let sheet = CGRect(x: 0, y: 500, width: 400, height: 300)

    func testModalPresentationClaimsTheWholeWindow() {
        XCTAssertEqual(
            PrototypeNativePresentationHitRegion.region(
                interaction: .modal,
                presentedFrame: sheet,
                windowBounds: window
            ),
            window
        )
    }

    func testBackgroundInteractivePresentationClaimsOnlyItsFrame() {
        let region = PrototypeNativePresentationHitRegion.region(
            interaction: .backgroundInteractive, presentedFrame: sheet, windowBounds: window
        )
        XCTAssertEqual(region, sheet)
        XCTAssertFalse(region?.contains(CGPoint(x: 200, y: 100)) ?? true, "touches above the sheet reach the app")
    }

    func testFrameIsClippedToTheWindow() {
        let overhang = CGRect(x: 0, y: 700, width: 400, height: 300)
        XCTAssertEqual(
            PrototypeNativePresentationHitRegion.region(
                interaction: .backgroundInteractive, presentedFrame: overhang, windowBounds: window
            ),
            CGRect(x: 0, y: 700, width: 400, height: 100)
        )
    }

    func testEmptyOrOffWindowFramesClaimNothing() {
        let off = CGRect(x: 0, y: 900, width: 400, height: 100)
        XCTAssertNil(PrototypeNativePresentationHitRegion.region(
            interaction: .backgroundInteractive, presentedFrame: off, windowBounds: window
        ))
        XCTAssertNil(PrototypeNativePresentationHitRegion.region(
            interaction: .backgroundInteractive, presentedFrame: .zero, windowBounds: window
        ))
        XCTAssertNil(PrototypeNativePresentationHitRegion.region(
            interaction: .modal, presentedFrame: sheet, windowBounds: .zero
        ))
    }

    func testDetentIndexesDecideInteraction() {
        typealias Region = PrototypeNativePresentationHitRegion
        XCTAssertEqual(
            Region.interaction(selectedDetentIndex: 0, largestUndimmedDetentIndex: 0),
            .backgroundInteractive
        )
        XCTAssertEqual(
            Region.interaction(selectedDetentIndex: 0, largestUndimmedDetentIndex: 1),
            .backgroundInteractive
        )
        XCTAssertEqual(Region.interaction(selectedDetentIndex: 2, largestUndimmedDetentIndex: 1), .modal)
        XCTAssertEqual(Region.interaction(selectedDetentIndex: 1, largestUndimmedDetentIndex: nil), .modal)
        XCTAssertEqual(Region.interaction(selectedDetentIndex: nil, largestUndimmedDetentIndex: 1), .modal)
    }
}
