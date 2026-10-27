@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeStackPatternsTests: XCTestCase {
    func testSelectionAndProfiles() {
        let patterns: [(PrototypeStackTransition, PrototypeStackAnimation)] = [
            (.sharedAxisX, .sharedAxisX), (.sharedAxisY, .sharedAxisY),
            (.fadeThrough, .fadeThrough), (.zoom, .slide),
        ]
        for (pattern, expected) in patterns {
            for direction in [PrototypeStackChange.Direction.push, .pop, .replace] {
                XCTAssertEqual(
                    PrototypeStackNavigation
                        .animation(
                            declared: pattern,
                            specMotion: "standard",
                            reduceMotion: false,
                            direction: direction
                        ),
                    pattern == .zoom && direction == .replace ? .fade : expected
                )
                XCTAssertEqual(
                    PrototypeStackNavigation
                        .animation(declared: pattern, specMotion: "reduced", reduceMotion: false, direction: direction),
                    .fade
                )
                XCTAssertEqual(
                    PrototypeStackNavigation
                        .animation(declared: pattern, specMotion: "none", reduceMotion: false, direction: direction),
                    .none
                )
                XCTAssertEqual(
                    PrototypeStackNavigation
                        .animation(declared: pattern, specMotion: "standard", reduceMotion: true, direction: direction),
                    .fade
                )
            }
        }
    }

    func testActionOverrideWins() {
        XCTAssertEqual(
            PrototypeStackNavigation
                .animation(
                    declared: .sharedAxisX,
                    perAction: .sharedAxisY,
                    specMotion: "standard",
                    reduceMotion: false
                ),
            .sharedAxisY
        )
    }

    func testSharedFixtures() throws {
        for name in [
            "stack-patterns",
            "stack-patterns-zoom",
            "stack-patterns-zoom-idle",
            "stack-patterns-source-only",
        ] {
            let data = try Data(
                contentsOf: PrototypeSpecFixtures.directory
                    .appendingPathComponent("valid/\(name).json")
            )
            XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(data: data))
            XCTAssertNoThrow(try JSONDecoder().decode(PrototypeSpec.self, from: data))
        }
        for name in ["missing", "unresolved", "ambiguous"] {
            let fixture = try PrototypeSpecFixtures.invalid("stack-patterns-zoom-\(name)")
            XCTAssertThrowsError(
                try PrototypeSpecStrictValidator
                    .validate(data: JSONEncoder().encode(fixture.spec))
            ) { error in
                guard case let PrototypeLoadError.invalidSpec(path, _) = error
                else { return XCTFail("Unexpected error: \(error)") }
                XCTAssertEqual(path, fixture.expectedPath)
            }
        }
    }
}
