import SwiftUI
import XCTest

@testable import Playground

final class CrayonGrainTests: XCTestCase {
    func testDefaultsMatchAndroid() {
        let defaults = CrayonGrainDefaults()
        XCTAssertEqual(defaults.cellSize, 1.5)
        XCTAssertEqual(defaults.maxAlpha, 0.06)
        XCTAssertEqual(defaults.seed, 0)
        XCTAssertEqual(defaults.hashX, 12.9898)
        XCTAssertEqual(defaults.hashY, 78.233)
        XCTAssertEqual(defaults.hashScale, 43758.5453)
    }

    func testMappingMatchesMetalArgumentOrder() {
        XCTAssertEqual(
            CrayonGrainDefaults().shaderArgumentValues(),
            [1.5, 0.06, 0, 12.9898, 78.233, 43758.5453]
        )
    }

    func testModifierIsConstructibleWithoutRendering() {
        let modifier = CrayonGrainModifier(cornerRadius: 8)
        XCTAssertEqual(modifier.cornerRadius, 8)
        _ = Color.white.crayonGrain(cornerRadius: 8)
    }
}
