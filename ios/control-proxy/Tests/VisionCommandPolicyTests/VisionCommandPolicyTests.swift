import Foundation
@testable import VisionCommandPolicy
import XCTest

final class VisionCommandPolicyTests: XCTestCase {
    func testHierarchyRelaunchRequiresTheAXDisabledMarker() {
        for description in [
            "Error getting main window kAXErrorAPIDisabled",
            #"Error Domain=com.apple.dt.xctest.automation-support.error Code=8 "Error getting main window kAXErrorAPIDisabled""#,
        ] {
            XCTAssertTrue(VisionCommandPolicy.shouldRelaunchForSnapshotError(description), description)
        }
        for description in [
            "",
            "element not found",
            "Error getting main window kAXErrorCannotComplete",
            #"Error Domain=com.apple.dt.xctest.automation-support.error Code=8 "Other failure""#,
        ] {
            XCTAssertFalse(VisionCommandPolicy.shouldRelaunchForSnapshotError(description), description)
        }
    }

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

    func testTapResolutionNarrowsIdentifierSharersByTypeAndLabel() {
        let candidates = [
            VisionCommandPolicy.TapCandidate(elementType: 21, label: "", isEnabled: true),
            VisionCommandPolicy.TapCandidate(elementType: 9, label: "General", isEnabled: true),
            VisionCommandPolicy.TapCandidate(elementType: 9, label: "Other", isEnabled: true),
        ]
        XCTAssertEqual(VisionCommandPolicy.tapResolution(candidates: candidates), .ambiguous(3))
        XCTAssertEqual(VisionCommandPolicy.tapResolution(candidates: candidates, label: "General"), .match(1))
        XCTAssertEqual(VisionCommandPolicy.tapResolution(candidates: candidates, elementType: 21), .match(0))
        XCTAssertEqual(
            VisionCommandPolicy.tapResolution(candidates: candidates, label: "General", elementType: 9), .match(1)
        )
        XCTAssertEqual(
            VisionCommandPolicy.tapResolution(candidates: candidates, label: "General", elementType: 21), .missing
        )
        XCTAssertEqual(VisionCommandPolicy.tapResolution(candidates: candidates, label: ""), .match(0))
    }

    func testTapResolutionRequiresExactlyOneEnabledMatch() {
        let enabled = VisionCommandPolicy.TapCandidate(elementType: 9, label: "General", isEnabled: true)
        let disabled = VisionCommandPolicy.TapCandidate(elementType: 9, label: "General", isEnabled: false)
        XCTAssertEqual(VisionCommandPolicy.tapResolution(candidates: []), .missing)
        XCTAssertEqual(VisionCommandPolicy.tapResolution(candidates: [disabled]), .disabled)
        XCTAssertEqual(VisionCommandPolicy.tapResolution(candidates: [disabled, enabled]), .match(1))
        XCTAssertEqual(
            VisionCommandPolicy.tapResolution(candidates: [enabled, enabled], label: "General", elementType: 9),
            .ambiguous(2)
        )
        XCTAssertEqual(VisionCommandPolicy.tapResolution(candidates: [enabled]), .match(0))
        XCTAssertEqual(
            VisionCommandPolicy.tapResolution(candidates: [disabled, enabled], label: "General", elementType: 9),
            .match(1)
        )
        XCTAssertEqual(
            VisionCommandPolicy.tapResolution(candidates: [disabled, enabled], label: "Other"), .missing
        )
        XCTAssertEqual(
            VisionCommandPolicy.tapResolution(candidates: [disabled], label: "General", elementType: 9), .disabled
        )
    }

    func testTargetBundleIdComesFromEnvironment() {
        XCTAssertNil(VisionCommandPolicy.targetBundleId(environment: [:]))
        XCTAssertNil(VisionCommandPolicy.targetBundleId(environment: ["AM_BUNDLE_ID": "  "]))
        XCTAssertEqual(
            VisionCommandPolicy.targetBundleId(environment: ["AM_BUNDLE_ID": " com.example.app\n"]),
            "com.example.app"
        )
    }

    func testButtonsAndTextInputsCarryInteractionMetadata() {
        let button = VisionElementTraits.traits(for: .button, isEnabled: true)
        XCTAssertEqual(button.clickable, "true")
        XCTAssertNil(button.focusable)
        XCTAssertNil(button.actions)
        let field = VisionElementTraits.traits(for: .textInput, isEnabled: true)
        XCTAssertEqual(field.clickable, "true")
        XCTAssertEqual(field.focusable, "true")
        XCTAssertEqual(field.actions, ["set_text", "clear_text"])
        let disabled = VisionElementTraits.traits(for: .textInput, isEnabled: false)
        XCTAssertNil(disabled.clickable)
        XCTAssertNil(disabled.actions)
        let label = VisionElementTraits.traits(for: .other, isEnabled: true)
        XCTAssertNil(label.clickable)
        XCTAssertNil(label.focusable)
    }

    func testEnteredValueIsReportedExceptForSecureFieldsAndPlaceholders() {
        let field = VisionElementTraits.traits(for: .textInput, isEnabled: true)
        XCTAssertEqual(field.enteredValue("hello", placeholder: "Name"), "hello")
        XCTAssertNil(field.enteredValue("Name", placeholder: "Name"))
        XCTAssertNil(field.enteredValue("", placeholder: "Name"))
        XCTAssertNil(field.enteredValue(nil, placeholder: "Name"))
        // Text equal to the accessibility label, but not the placeholder, is still typed content.
        XCTAssertEqual(field.enteredValue("Name", placeholder: nil), "Name")
        let secure = VisionElementTraits.traits(for: .secureTextInput, isEnabled: true)
        XCTAssertEqual(secure.focusable, "true")
        XCTAssertNil(secure.enteredValue("hunter2", placeholder: nil))
    }

    func testAppendTextRejectsDeleteKeySequences() {
        XCTAssertTrue(VisionCommandPolicy.containsDeleteKey("ab\u{8}"))
        XCTAssertTrue(VisionCommandPolicy.containsDeleteKey("\u{7F}"))
        XCTAssertTrue(VisionCommandPolicy.containsDeleteKey("x\u{F728}"))
        XCTAssertFalse(VisionCommandPolicy.containsDeleteKey("hello world\n"))
    }

    func testTypingTargetPrefersFocusAndFallsBackToTheLastTappedField() {
        XCTAssertEqual(VisionCommandPolicy.typingTarget(focusedCount: 1, lastTappedTextInputCount: 0), .focused)
        XCTAssertEqual(VisionCommandPolicy.typingTarget(focusedCount: 1, lastTappedTextInputCount: 1), .focused)
        XCTAssertEqual(VisionCommandPolicy.typingTarget(focusedCount: 0, lastTappedTextInputCount: 1), .lastTapped)
        XCTAssertEqual(VisionCommandPolicy.typingTarget(focusedCount: 0, lastTappedTextInputCount: 0), .none)
        XCTAssertEqual(VisionCommandPolicy.typingTarget(focusedCount: 0, lastTappedTextInputCount: 2), .none)
        // Several focused fields are ambiguous: never guess.
        XCTAssertEqual(VisionCommandPolicy.typingTarget(focusedCount: 2, lastTappedTextInputCount: 1), .none)
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
