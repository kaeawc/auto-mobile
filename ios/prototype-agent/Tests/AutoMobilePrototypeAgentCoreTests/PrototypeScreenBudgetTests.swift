@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeScreenBudgetTests: XCTestCase {
    private func budget() -> PrototypeScreenBudget {
        PrototypeScreenBudget(maxNodes: 10, maxImages: 4, maxSpecNodes: 25, maxSpecImages: 8)
    }

    func testSiblingScreensAreBudgetedSeparately() {
        var budget = budget()
        budget.enterStack()
        for _ in 0 ..< 2 {
            budget.enterScreen()
            XCTAssertNil(budget.charge(nodes: 10, images: 4))
            budget.exitScreen()
        }
        budget.exitStack()
    }

    func testContentOutsideTheStackCountsAgainstEveryScreen() {
        var budget = budget()
        budget.enterStack()
        budget.enterScreen()
        XCTAssertNil(budget.charge(nodes: 6, images: 3))
        budget.exitScreen()
        budget.exitStack()
        XCTAssertNil(budget.charge(nodes: 4, images: 0))
        XCTAssertEqual(budget.charge(nodes: 1, images: 0), .nodes)
    }

    func testTheWholeSpecStopsAtItsOwnCeiling() {
        var budget = budget()
        budget.enterStack()
        var results: [PrototypeScreenBudget.Overflow?] = []
        for _ in 0 ..< 3 {
            budget.enterScreen()
            results.append(budget.charge(nodes: 10, images: 0))
            budget.exitScreen()
        }
        XCTAssertEqual(results, [nil, nil, .specNodes])
        XCTAssertEqual(PrototypeScreenBudget.Overflow.specNodes.expandedMessage, "Expanded spec node limit exceeded")
    }
}
