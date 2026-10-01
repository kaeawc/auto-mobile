@testable import CtrlProxyRewrite
import Foundation
import XCTest

final class VoiceOverSwitchStateTests: XCTestCase {
    func testKnownValuesMatchRequestedState() throws {
        let values: [(Any, Bool)] = [
            ("1", true), ("0", false),
            (true, true), (false, false),
            (NSNumber(value: 1), true), (NSNumber(value: 0), false),
        ]

        for (value, isOn) in values {
            XCTAssertEqual(try VoiceOverSwitchState.decision(for: value, enabled: isOn), .alreadyInState)
            XCTAssertEqual(try VoiceOverSwitchState.decision(for: value, enabled: !isOn), .tapNeeded)
        }
    }

    func testUnknownValuesAreUnreadable() {
        let values: [Any?] = [nil, "unknown", "true", NSNumber(value: 2)]
        for value in values {
            for enabled in [true, false] {
                XCTAssertThrowsError(try VoiceOverSwitchState.decision(for: value, enabled: enabled)) { error in
                    XCTAssertEqual(error as? VoiceOverToggleError, .switchStateUnreadable)
                }
            }
        }
    }
}
