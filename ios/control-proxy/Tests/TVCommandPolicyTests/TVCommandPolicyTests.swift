import CtrlProxy
import Foundation
@testable import TVCommandPolicy
import XCTest

final class TVCommandPolicyTests: XCTestCase {
    func testOnlyHierarchyRemotePressAppendTextAndScreenshotAreSupported() {
        XCTAssertEqual(TVCommandPolicy.supportedCommands, [
            "request_hierarchy", "request_press_button", "request_append_text", "request_screenshot",
        ])
        for command in ["", "unknown", "connected", "REQUEST_HIERARCHY", "request_focus"] {
            XCTAssertFalse(TVCommandPolicy.supports(command))
        }
    }

    func testAppendTextAndScreenshotAreSupportedAndOtherRequestTypesStayRejected() {
        XCTAssertTrue(TVCommandPolicy.supports(RequestType.requestAppendText.rawValue))
        XCTAssertTrue(TVCommandPolicy.supports(RequestType.requestScreenshot.rawValue))
        for command in RequestType.allCases {
            let supported: Bool
            switch command {
            case .requestHierarchy, .requestPressButton, .requestAppendText, .requestScreenshot:
                supported = true
            default:
                supported = false
            }
            XCTAssertEqual(
                TVCommandPolicy.supports(command.rawValue),
                supported,
                command.rawValue
            )
        }
    }

    func testSetTextClearTextAndPressKeyStayUnsupported() {
        XCTAssertFalse(TVCommandPolicy.supports("request_set_text"))
        XCTAssertFalse(TVCommandPolicy.supports("request_clear_text"))
        XCTAssertFalse(TVCommandPolicy.supports("request_press_key"))
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
        XCTAssertEqual(event["supportedCommands"] as? [String], [
            "request_hierarchy", "request_press_button", "request_append_text", "request_screenshot",
        ])
        XCTAssertEqual(event["supportedFeatures"] as? [String], [])
    }
}
