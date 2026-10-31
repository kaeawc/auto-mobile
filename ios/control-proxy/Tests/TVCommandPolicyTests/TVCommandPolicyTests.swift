import CtrlProxy
import Foundation
@testable import TVCommandPolicy
import XCTest

final class TVCommandPolicyTests: XCTestCase {
    func testOnlyHierarchyAndRemotePressAreSupported() {
        XCTAssertEqual(TVCommandPolicy.supportedCommands, ["request_hierarchy", "request_press_button"])
        for command in RequestType.allCases {
            XCTAssertEqual(
                TVCommandPolicy.supports(command.rawValue),
                ["request_hierarchy", "request_press_button"].contains(command.rawValue),
                command.rawValue
            )
        }
        for command in ["", "unknown", "connected", "REQUEST_HIERARCHY", "request_focus"] {
            XCTAssertFalse(TVCommandPolicy.supports(command))
        }
    }

    func testRemoteButtonsAreExactlyTheSpikeSubset() {
        XCTAssertEqual(
            TVRemoteButton.allCases.map(\.rawValue).sorted(),
            ["down", "home", "left", "menu", "playPause", "right", "select", "up"]
        )
        for action in ["tap", "focus", "volume_up", "", "Select"] {
            XCTAssertNil(TVRemoteButton(rawValue: action))
        }
    }

    func testHandshakeAdvertisesOnlyImplementedCommandsAndTVPlatform() throws {
        let data = try JSONEncoder().encode(TVConnectedEvent(id: 42))
        let event = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(event["type"] as? String, "connected")
        XCTAssertEqual(event["id"] as? Int, 42)
        XCTAssertEqual(event["platform"] as? String, "tvos")
        XCTAssertEqual(event["supportedCommands"] as? [String], TVCommandPolicy.supportedCommands)
        XCTAssertEqual(event["supportedFeatures"] as? [String], [])
    }
}
