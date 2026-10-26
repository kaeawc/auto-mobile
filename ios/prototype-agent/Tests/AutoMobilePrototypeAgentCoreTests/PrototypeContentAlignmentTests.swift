import SwiftUI
import XCTest

@testable import AutoMobilePrototypeAgentCore

final class PrototypeContentAlignmentTests: XCTestCase {
    private func alignment(_ type: String, textAlign: String? = nil) -> Alignment {
        prototypeContentAlignment(nodeType: type, arrangement: nil, boxAlignment: .topLeading, textAlign: textAlign)
    }

    func testTextFollowsTextAlignAndDefaultsToTheLeadingEdge() {
        XCTAssertEqual(alignment("text"), .leading)
        XCTAssertEqual(alignment("text", textAlign: "start"), .leading)
        XCTAssertEqual(alignment("text", textAlign: "center"), .center)
        XCTAssertEqual(alignment("text", textAlign: "end"), .trailing)
    }

    func testCardContentStartsAtTheTopLeadingCorner() {
        XCTAssertEqual(alignment("card"), .topLeading)
    }

    func testOtherLeavesStayCentred() {
        XCTAssertEqual(alignment("image"), .center)
        XCTAssertEqual(alignment("button"), .center)
    }

    func testContainersKeepTheirArrangementAlignment() {
        let row = { (arrangement: String?) in
            prototypeContentAlignment(nodeType: "row", arrangement: arrangement, boxAlignment: .center, textAlign: nil)
        }
        XCTAssertEqual(row(nil), .leading)
        XCTAssertEqual(row("center"), .center)
        XCTAssertEqual(row("end"), .trailing)
        XCTAssertEqual(
            prototypeContentAlignment(nodeType: "column", arrangement: "end", boxAlignment: .center, textAlign: nil),
            .bottomLeading
        )
        XCTAssertEqual(
            prototypeContentAlignment(nodeType: "box", arrangement: nil, boxAlignment: .bottomTrailing, textAlign: nil),
            .bottomTrailing
        )
    }
}
