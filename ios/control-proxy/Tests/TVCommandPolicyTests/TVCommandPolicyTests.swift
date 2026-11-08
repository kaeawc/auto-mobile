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

    func testCapturedClosedFieldText() {
        XCTAssertEqual(TVElementText.text(
            label: "", value: nil, placeholder: "Text", isTextInput: true, isSecure: false
        ), "")
        XCTAssertEqual(TVElementText.text(
            label: "Label", value: nil, placeholder: "Placeholder", isTextInput: true, isSecure: false
        ), "Label")
        XCTAssertEqual(TVElementText.text(
            label: "Label", value: "hello", placeholder: "Placeholder", isTextInput: true, isSecure: false
        ), "Label hello")
        XCTAssertEqual(TVElementText.text(
            label: "", value: "••••••", placeholder: "Secret", isTextInput: true, isSecure: true
        ), "")
    }

    func testIOSStylePlaceholderValueIsEmpty() {
        // Synthetic iOS-style variant; no tvOS capture produced value == placeholderValue.
        XCTAssertEqual(TVElementText.text(
            label: "Label", value: "Placeholder", placeholder: "Placeholder", isTextInput: true, isSecure: false
        ), "Label")
    }

    func testSecureMetadataDetection() {
        XCTAssertTrue(TVSecureField.isSecure(elementType: 50, identifier: "", label: "", placeholder: nil))
        for type in [45, 49, 52] {
            for keyword in ["PASSWORD", "Passcode", "passwd", "Secret", "Enter PIN", "pin-code"] {
                let cases: [(String, String, String?)] = [(keyword, "", nil), ("", keyword, nil), ("", "", keyword)]
                for metadata in cases {
                    XCTAssertTrue(TVSecureField.isSecure(
                        elementType: type, identifier: metadata.0, label: metadata.1, placeholder: metadata.2
                    ), keyword)
                }
            }
            for label in ["Pinned items", "spinning", "Label"] {
                XCTAssertFalse(TVSecureField.isSecure(
                    elementType: type, identifier: "", label: label, placeholder: nil
                ))
            }
        }
        XCTAssertFalse(TVSecureField.isSecure(
            elementType: 48, identifier: "password", label: "Secret", placeholder: "PIN"
        ))
    }

    private var labeledField: TVFocusedField {
        TVFocusedField(identifier: "am-labeled-field", label: "Label", placeholder: "Placeholder", isSecure: false)
    }

    /// Captured tvOS tree, omitting the 40 key nodes and retaining the entry container and prompt.
    private func keyboardTree(value: String, prompt: String = "Placeholder", button: String = "next") -> TVNodeSketch {
        let entryChildren = value.isEmpty ? [TVNodeSketch(elementType: 48, label: prompt)] : []
        return TVNodeSketch(elementType: 2, label: "AutoMobileTVTest", children: [
            TVNodeSketch(elementType: 4, children: [
                TVNodeSketch(elementType: 1, children: [
                    TVNodeSketch(elementType: 1, children: [
                        TVNodeSketch(elementType: 48, label: prompt),
                        TVNodeSketch(elementType: 1, children: [
                            TVNodeSketch(elementType: 1, children: [
                                TVNodeSketch(elementType: 52, label: "", value: value),
                            ] + entryChildren),
                        ]),
                        TVNodeSketch(elementType: 19, label: "Keyboard", hasFocus: true, children: [
                            TVNodeSketch(elementType: 1, children: [
                                TVNodeSketch(elementType: 1, identifier: "UIKeyboardLayoutStar Preview"),
                            ]),
                        ]),
                        TVNodeSketch(elementType: 9, label: button, children: [
                            TVNodeSketch(elementType: 48, label: button),
                        ]),
                    ]),
                ]),
            ]),
        ])
    }

    func testCapturedKeyboardEntryReportsRememberedLabeledField() throws {
        for (value, expected) in [("hello", "Label hello"), ("", "Label")] {
            let root = keyboardTree(value: value)
            let entry = try XCTUnwrap(TVTextEntryPolicy.resolve(
                root: root, hasFocusedKeyboard: TVTextEntryPolicy.hasFocusedKeyboard(root), lastFocusedField: labeledField
            ))
            XCTAssertEqual(entry.path, [0, 0, 0, 1, 0, 0])
            XCTAssertEqual(entry.className, "49")
            XCTAssertTrue(entry.focused)
            XCTAssertEqual(entry.resourceId, "am-labeled-field")
            XCTAssertEqual(entry.text, expected)
        }
    }

    func testCapturedSecureKeyboardEntryNeverEmitsPlaintext() throws {
        let root = keyboardTree(value: "s3cret", prompt: "Secret", button: "done")
        let field = TVFocusedField(identifier: "am-secure-field", label: "", placeholder: "Secret", isSecure: true)
        let entry = try XCTUnwrap(TVTextEntryPolicy.resolve(
            root: root, hasFocusedKeyboard: true, lastFocusedField: field
        ))
        XCTAssertEqual(entry.text, "")
        XCTAssertEqual(entry.resourceId, "am-secure-field")
        // A label is still allowed for a secure field; its value is never used.
        let labeledSecure = TVFocusedField(
            identifier: field.identifier, label: "Secret", placeholder: "Secret", isSecure: true
        )
        XCTAssertEqual(TVTextEntryPolicy.resolve(
            root: root, hasFocusedKeyboard: true, lastFocusedField: labeledSecure
        )?.text, "Secret")
    }

    func testUnknownKeyboardEntryWithholdsValue() throws {
        let root = keyboardTree(value: "s3cret", prompt: "Secret", button: "done")
        let entry = try XCTUnwrap(TVTextEntryPolicy.resolve(
            root: root, hasFocusedKeyboard: true, lastFocusedField: nil
        ))
        XCTAssertEqual(entry.text, "")
        XCTAssertNil(entry.resourceId)
    }

    func testNormalFocusedFieldIsNotOverridden() {
        let root = TVNodeSketch(
            elementType: 49, identifier: "am-labeled-field", label: "Label", value: "hello",
            placeholder: "Placeholder", hasFocus: true
        )
        XCTAssertFalse(TVTextEntryPolicy.hasFocusedKeyboard(root))
        XCTAssertNil(TVTextEntryPolicy.resolve(
            root: root, hasFocusedKeyboard: TVTextEntryPolicy.hasFocusedKeyboard(root), lastFocusedField: labeledField
        ))
        XCTAssertEqual(TVTextEntryPolicy.rememberedField(in: root, previous: nil), labeledField)
    }

    func testKeyboardSubtreeIsExcludedFromEntryLookup() throws {
        // Synthetic placement checks subtree exclusion and first depth-first match.
        var root = keyboardTree(value: "hello")
        root.children.insert(TVNodeSketch(elementType: 19, hasFocus: true, children: [
            TVNodeSketch(elementType: 52, value: "inside keyboard"),
        ]), at: 0)
        root.children.append(TVNodeSketch(elementType: 49, value: "later field"))
        let entry = try XCTUnwrap(TVTextEntryPolicy.resolve(
            root: root, hasFocusedKeyboard: true, lastFocusedField: labeledField
        ))
        XCTAssertEqual(entry.path, [1, 0, 0, 1, 0, 0])
        XCTAssertEqual(entry.text, "Label hello")
    }

    func testRemembersCapturedFocusedFieldsAndRetainsThemAcrossKeyboardClose() {
        let closed = TVNodeSketch(elementType: 2, children: [
            TVNodeSketch(elementType: 49, identifier: "am-text-field", placeholder: "Text", hasFocus: true),
            TVNodeSketch(elementType: 49, identifier: "am-labeled-field", label: "Label", placeholder: "Placeholder"),
            TVNodeSketch(elementType: 50, identifier: "am-secure-field", placeholder: "Secret"),
        ])
        let field = TVTextEntryPolicy.rememberedField(in: closed, previous: nil)
        XCTAssertEqual(field, TVFocusedField(
            identifier: "am-text-field", label: "", placeholder: "Text", isSecure: false
        ))
        XCTAssertEqual(TVTextEntryPolicy.rememberedField(in: keyboardTree(value: "hello"), previous: field), field)
        var unfocused = closed
        unfocused.children[0].hasFocus = false
        XCTAssertEqual(TVTextEntryPolicy.rememberedField(in: unfocused, previous: field), field)
        unfocused.children[2].hasFocus = true
        XCTAssertEqual(TVTextEntryPolicy.rememberedField(in: unfocused, previous: field), TVFocusedField(
            identifier: "am-secure-field", label: "", placeholder: "Secret", isSecure: true
        ))
    }

    func testFocusedFieldLookupExcludesUnfocusedKeyboardSubtree() {
        let root = TVNodeSketch(elementType: 19, children: [
            TVNodeSketch(elementType: 52, hasFocus: true),
        ])
        XCTAssertNil(TVTextEntryPolicy.rememberedField(in: root, previous: nil))
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
