import Foundation
@testable import VisionCommandPolicy
import XCTest

final class VisionCommandPolicyTests: XCTestCase {
    func testOnlyWindowHierarchyIdentifierTapAndAppendTextAreSupported() {
        XCTAssertEqual(VisionCommandPolicy.supportedCommands, [
            "request_hierarchy", "request_tap_element", "request_append_text",
        ])
        for command in VisionCommandPolicy.supportedCommands {
            XCTAssertTrue(VisionCommandPolicy.supports(command))
        }
        for command in [
            "",
            "request_screenshot",
            "request_press_button",
            "request_tap_coordinates",
            "request_set_text",
            "request_focus",
            "request_open_immersive_space",
            "request_move_window",
            "request_pinch",
        ] {
            XCTAssertFalse(VisionCommandPolicy.supports(command), command)
        }
    }

    func testHandshakeAdvertisesOnlyTheVisionWindowSubset() throws {
        struct Event: Decodable {
            let type: String
            let id: Int
            let platform: String
            let supportedCommands: [String]
            let supportedFeatures: [String]
        }
        let event = try JSONDecoder().decode(Event.self, from: JSONEncoder().encode(VisionConnectedEvent(id: 42)))
        XCTAssertEqual(event.type, "connected")
        XCTAssertEqual(event.id, 42)
        XCTAssertEqual(event.platform, "visionos")
        XCTAssertEqual(event.supportedCommands, VisionCommandPolicy.supportedCommands)
        XCTAssertEqual(event.supportedFeatures, [])
    }
}
