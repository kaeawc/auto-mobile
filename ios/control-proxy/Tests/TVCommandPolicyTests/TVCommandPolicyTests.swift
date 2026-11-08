import CtrlProxy
import Foundation
@testable import TVCommandPolicy
import XCTest

final class TVCommandPolicyTests: XCTestCase {
    func testTextInputEmitsValueWhenLabelIsEmpty() {
        XCTAssertEqual(TVElementText.text(label: "", value: "hello", isTextInput: true, isSecure: false), "hello")
    }

    func testTextInputDoesNotDuplicateMatchingLabelAndValue() {
        XCTAssertEqual(TVElementText.text(label: "hello", value: "hello", isTextInput: true, isSecure: false), "hello")
    }

    func testTextInputFallsBackToLabelForEmptyOrMissingValue() {
        for value in ["", nil] as [String?] {
            XCTAssertEqual(TVElementText.text(label: "Name", value: value, isTextInput: true, isSecure: false), "Name")
        }
    }

    func testSecureInputNeverEmitsValue() {
        for label in ["Password", ""] {
            for value in ["secret", "", nil] as [String?] {
                for isTextInput in [true, false] {
                    XCTAssertEqual(
                        TVElementText.text(label: label, value: value, isTextInput: isTextInput, isSecure: true),
                        label
                    )
                }
            }
        }
    }

    func testNonTextInputIgnoresValue() {
        XCTAssertEqual(TVElementText.text(label: "Volume", value: "50%", isTextInput: false, isSecure: false), "Volume")
    }

    func testTextInputJoinsDistinctLabelAndValueWithSingleSpace() {
        XCTAssertEqual(TVElementText.text(label: "Name", value: "hello", isTextInput: true, isSecure: false), "Name hello")
    }

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

    func testHostStaysTargetWhileFrontmost() {
        XCTAssertEqual(
            TVTargetResolver.resolve(hostState: 4, candidates: [("com.apple.TVSettings", 4)]), .host
        )
    }

    func testForegroundCandidateIsTargetedWhenHostIsBackgrounded() {
        let candidates = [("com.apple.TVMusic", 2), ("com.apple.TVSettings", 4)]
        XCTAssertEqual(
            TVTargetResolver.resolve(hostState: 3, candidates: candidates),
            .app(bundleId: "com.apple.TVSettings")
        )
    }

    func testHomeScreenIsTargetedWhenNothingKnownIsForeground() {
        XCTAssertEqual(
            TVTargetResolver.resolve(hostState: 3, candidates: [("com.apple.TVSettings", 2)]), .home
        )
        XCTAssertEqual(TVTargetResolver.resolve(hostState: 1, candidates: []), .home)
    }

    func testRequestedBundleIdIsProbedFirstWithoutDuplicates() {
        XCTAssertEqual(
            TVTargetResolver.candidateBundleIds(requested: " com.example.app ").first, "com.example.app"
        )
        let ids = TVTargetResolver.candidateBundleIds(requested: "com.apple.TVSettings")
        XCTAssertEqual(ids.first, "com.apple.TVSettings")
        XCTAssertEqual(ids.filter { $0 == "com.apple.TVSettings" }.count, 1)
        XCTAssertEqual(TVTargetResolver.candidateBundleIds(requested: nil), TVTargetResolver.systemAppBundleIds)
    }
}
