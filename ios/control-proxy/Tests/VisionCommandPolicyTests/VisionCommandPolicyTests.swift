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

    func testOnlyWindowHierarchyElementTapAndAppendTextAreSupported() {
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

    func testTapSelectorRequiresIdentifierOrNonEmptyLabelAndTypeWithoutFrameContext() {
        XCTAssertEqual(
            VisionCommandPolicy.tapSelector(identifier: "row", label: nil, elementType: nil, frameContext: nil),
            .identifier("row")
        )
        XCTAssertEqual(
            VisionCommandPolicy.tapSelector(identifier: "", label: "Item 3", elementType: 9, frameContext: nil),
            .label("Item 3", 9)
        )
        let labels: [String?] = [nil, "", "Item 3"]
        for label in labels {
            XCTAssertNil(VisionCommandPolicy.tapSelector(
                identifier: "", label: label, elementType: nil, frameContext: nil
            ))
        }
        XCTAssertNil(VisionCommandPolicy.tapSelector(
            identifier: "", label: "", elementType: 9, frameContext: nil
        ))
        XCTAssertNil(VisionCommandPolicy.tapSelector(
            identifier: "", label: nil, elementType: 9, frameContext: nil
        ))
        for identifier in ["", "row"] {
            for frameContext in ["", "window"] {
                XCTAssertNil(VisionCommandPolicy.tapSelector(
                    identifier: identifier, label: "Item 3", elementType: 9, frameContext: frameContext
                ))
            }
        }
    }

    func testLabelSelectorMatchesOnlyExactUnidentifiedTypeAndLabel() {
        let selector = VisionCommandPolicy.TapSelector.label("Item 3", 9)
        XCTAssertTrue(selector.matches(identifier: "", label: "Item 3", elementType: 9))
        XCTAssertFalse(selector.matches(identifier: "row", label: "Item 3", elementType: 9))
        XCTAssertFalse(selector.matches(identifier: "Item 3", label: "Item 3", elementType: 9))
        XCTAssertFalse(selector.matches(identifier: "", label: "Item 3", elementType: 48))
        for label in ["item 3", "Item 30", " Item 3", "Item 3 ", ""] {
            XCTAssertFalse(selector.matches(identifier: "", label: label, elementType: 9), label)
        }
        let identified = VisionCommandPolicy.TapSelector.identifier("row")
        XCTAssertTrue(identified.matches(identifier: "row", label: "Other", elementType: 48))
        XCTAssertFalse(identified.matches(identifier: "", label: "row", elementType: 9))
    }

    func testLabelOnlyButtonsSwitchesAndTogglesUseTheSameTapResolution() {
        let elementTypes: [UInt] = [9, 40, 41]
        for elementType in elementTypes {
            let selector = VisionCommandPolicy.TapSelector.label("Control", elementType)
            let snapshots = [
                (identifier: "identified", candidate: VisionCommandPolicy.TapCandidate(
                    elementType: elementType, label: "Control", isEnabled: true
                )),
                (identifier: "", candidate: VisionCommandPolicy.TapCandidate(
                    elementType: 48, label: "Control", isEnabled: true
                )),
                (identifier: "", candidate: VisionCommandPolicy.TapCandidate(
                    elementType: elementType, label: "Control", isEnabled: false
                )),
                (identifier: "", candidate: VisionCommandPolicy.TapCandidate(
                    elementType: elementType, label: "Control", isEnabled: true
                )),
            ]
            let candidates = snapshots.filter {
                selector.matches(
                    identifier: $0.identifier, label: $0.candidate.label, elementType: $0.candidate.elementType
                )
            }.map(\.candidate)
            XCTAssertEqual(VisionCommandPolicy.tapResolution(candidates: candidates), .match(1))
            XCTAssertEqual(VisionCommandPolicy.tapResolution(candidates: Array(candidates.prefix(1))), .disabled)
            XCTAssertEqual(VisionCommandPolicy.tapResolution(candidates: []), .missing)
            XCTAssertEqual(
                VisionCommandPolicy.tapResolution(candidates: candidates + [candidates[1]]), .ambiguous(2)
            )
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

    func testToggleSnapshotValuesIncludeOffAndDisabledStates() {
        for enabled in [true, false] {
            let traits = VisionElementTraits.traits(for: .button, isEnabled: enabled)
            XCTAssertEqual(traits.snapshotValue("1", placeholder: "1", isToggle: true), "1")
            XCTAssertEqual(traits.snapshotValue("0", placeholder: nil, isToggle: true), "0")
            XCTAssertEqual(traits.snapshotValue(NSNumber(value: true), placeholder: nil, isToggle: true), "1")
            XCTAssertEqual(traits.snapshotValue(NSNumber(value: false), placeholder: nil, isToggle: true), "0")
            XCTAssertNil(traits.snapshotValue(nil, placeholder: nil, isToggle: true))
            XCTAssertNil(traits.snapshotValue("1", placeholder: nil, isToggle: false))
        }
        let field = VisionElementTraits.traits(for: .textInput, isEnabled: true)
        XCTAssertEqual(field.snapshotValue("hello", placeholder: "Name", isToggle: false), "hello")
        XCTAssertNil(field.snapshotValue("Name", placeholder: "Name", isToggle: false))
        let secure = VisionElementTraits.traits(for: .secureTextInput, isEnabled: true)
        XCTAssertNil(secure.snapshotValue("secret", placeholder: nil, isToggle: false))
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

    func testLabelOnlyTapOnAnUnfocusedTextInputKeepsTheTypingFallback() throws {
        // A label-only tap on an anonymous text field (elementType 49), then typing while no
        // input reports hasFocus (#18079).
        let selector = try XCTUnwrap(VisionCommandPolicy.tapSelector(
            identifier: "", label: "Name", elementType: 49, frameContext: nil
        ))
        let inputs = [
            VisionCommandPolicy.TextInputCandidate(identifier: "email", label: "Email", elementType: 49),
            VisionCommandPolicy.TextInputCandidate(identifier: "", label: "Name", elementType: 49),
            VisionCommandPolicy.TextInputCandidate(identifier: "", label: "Name", elementType: 50),
        ]
        let tapped = VisionCommandPolicy.lastTappedTextInputIndices(candidates: inputs, lastTapped: selector)
        XCTAssertEqual(tapped, [1])
        XCTAssertEqual(
            VisionCommandPolicy.typingTarget(focusedCount: 0, lastTappedTextInputCount: tapped.count),
            .lastTapped
        )
        XCTAssertEqual(
            VisionCommandPolicy.lastTappedTextInputIndices(candidates: inputs, lastTapped: .identifier("email")),
            [0]
        )
        XCTAssertEqual(VisionCommandPolicy.lastTappedTextInputIndices(candidates: inputs, lastTapped: nil), [])
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
