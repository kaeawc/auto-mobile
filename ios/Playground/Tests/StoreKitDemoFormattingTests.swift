import XCTest

@testable import Playground

final class StoreKitDemoFormattingTests: XCTestCase {
    func testEmptyEntitlementsShowNone() {
        XCTAssertEqual(StoreKitDemoFormatting.entitlementsText([]), "none")
    }

    func testEntitlementsListProductIDsInSortedOrder() {
        let pro = "dev.jasonpearson.automobile.playground.pro"
        let plus = "dev.jasonpearson.automobile.playground.plus"

        XCTAssertEqual(StoreKitDemoFormatting.entitlementsText([pro, plus]), "\(plus), \(pro)")
    }
}
