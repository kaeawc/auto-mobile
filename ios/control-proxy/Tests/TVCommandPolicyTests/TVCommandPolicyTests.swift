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
        XCTAssertEqual(
            TVElementText.text(label: "Name", value: "hello", isTextInput: true, isSecure: false),
            "Name hello"
        )
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

    func testPINMetadataTokensIncludeCamelCaseButExcludeWordFragments() {
        let secure = [
            "pinCode", "pin_field", "userPIN", "PIN", "Enter your PIN", "accountPin", "PINCode", "user-pin",
            "pin2Code", "user2PIN", "2pin", "pin2",
        ]
        let plain = ["spinner", "pinned", "shipping", "mapping", "opinion", "pinterest", "pinnacle"]
        for (values, expected) in [(secure, true), (plain, false)] {
            for value in values {
                let metadata: [(String, String, String?)] = [(value, "", nil), ("", value, nil), ("", "", value)]
                for (identifier, label, placeholder) in metadata {
                    XCTAssertEqual(TVSecureField.isSecure(
                        elementType: 49, identifier: identifier, label: label, placeholder: placeholder
                    ), expected, value)
                }
            }
        }
    }

    /// Walk every emitted text using the same resolution as the router, including fallback nodes.
    private func emittedTexts(in root: TVNodeSketch) -> [String] {
        let resolution = TVTextEntryPolicy.resolve(root: root)
        func walk(_ node: TVNodeSketch) -> [String] {
            [resolution.text(for: node)] + node.children.flatMap { walk($0) }
        }
        return walk(root)
    }

    /// Captured tvOS tree, omitting the 40 key nodes and retaining the entry container and prompt.
    /// Parameters also cover missing prompts and alternate input metadata without changing the layout.
    private func keyboardTree(
        value: String, prompt: String? = "Placeholder", button: String = "next", keyboardFocused: Bool = true,
        entryType: Int = 52, entryLabel: String = ""
    )
        -> TVNodeSketch
    {
        let promptNodes = prompt.map { [TVNodeSketch(elementType: 48, label: $0)] } ?? []
        let entryChildren = value.isEmpty ? promptNodes : []
        return TVNodeSketch(elementType: 2, label: "AutoMobileTVTest", children: [
            TVNodeSketch(elementType: 4, children: [
                TVNodeSketch(elementType: 1, children: [
                    TVNodeSketch(elementType: 1, children: promptNodes + [
                        TVNodeSketch(elementType: 1, children: [
                            TVNodeSketch(elementType: 1, children: [
                                TVNodeSketch(elementType: entryType, label: entryLabel, value: value),
                            ] + entryChildren),
                        ]),
                        TVNodeSketch(elementType: 19, label: "Keyboard", hasFocus: keyboardFocused, children: [
                            TVNodeSketch(elementType: 1, children: [
                                TVNodeSketch(elementType: 1, identifier: "UIKeyboardLayoutStar Preview"),
                            ]),
                        ]),
                        TVNodeSketch(elementType: 9, label: button, hasFocus: !keyboardFocused, children: [
                            TVNodeSketch(elementType: 48, label: button),
                        ]),
                    ]),
                ]),
            ]),
        ])
    }

    func testSecurePINNeverAppearsInAnyEmittedTextWhileKeyboardIsOpen() {
        for secret in ["s3cret", "1234"] {
            let plainCode = TVNodeSketch(
                elementType: 49, label: "Code", value: "hello", placeholder: "Code", hasFocus: true
            )
            let plainBeforeRelaunch = TVNodeSketch(
                elementType: 49, identifier: "am-labeled-field", label: "Label", value: "hello",
                placeholder: "Placeholder", hasFocus: true
            )
            let whitespacePromptPlain = TVNodeSketch(elementType: 49, placeholder: " ", hasFocus: true)
            let emptyLabelPlain = TVNodeSketch(elementType: 49, placeholder: "", hasFocus: true)
            XCTAssertEqual(emittedTexts(in: plainCode), ["Code hello"])
            XCTAssertEqual(emittedTexts(in: plainBeforeRelaunch), ["Label hello"])
            var emptyLabelPair = keyboardTree(value: secret, prompt: "")
            emptyLabelPair.children.append(TVNodeSketch(elementType: 49, value: "hello"))
            let scenarios: [(name: String, roots: [TVNodeSketch])] = [
                ("F1 whitespace-only secure prompt", [
                    whitespacePromptPlain, keyboardTree(value: secret, prompt: " ", button: "done"),
                ]),
                // An app can move from a plain field to a same-prompt secure field without a select command.
                ("F3 same prompt without select", [plainCode, keyboardTree(value: secret, prompt: "Code")]),
                // Commands on either side of a relaunch resolve independently; no identity is carried over.
                ("F2 relaunch between commands", [plainBeforeRelaunch, keyboardTree(value: secret)]),
                ("next button focused", [keyboardTree(value: secret, prompt: "Secret", keyboardFocused: false)]),
                ("done button focused", [
                    keyboardTree(value: secret, prompt: "Secret", button: "done", keyboardFocused: false),
                ]),
                ("empty-label pair", [emptyLabelPlain, emptyLabelPair]),
                ("empty prompt", [keyboardTree(value: secret, prompt: "")]),
                ("missing prompt", [keyboardTree(value: secret, prompt: nil)]),
                ("type-50 field", [keyboardTree(value: secret, entryType: 50)]),
            ]
            for (name, roots) in scenarios {
                for (index, root) in roots.enumerated() {
                    XCTAssertFalse(
                        emittedTexts(in: root).contains { $0.contains(secret) },
                        "\(name), hierarchy \(index)"
                    )
                }
            }
        }
    }

    func testCapturedKeyboardTextViewEmitsOnlyItsOwnLabel() {
        for value in ["hello", ""] {
            let root = keyboardTree(value: value, entryLabel: "Entry label")
            let texts = emittedTexts(in: root)
            XCTAssertTrue(TVTextEntryPolicy.resolve(root: root).keyboardPresent)
            XCTAssertTrue(texts.contains("Entry label"))
            XCTAssertTrue(texts.contains("Placeholder"))
            XCTAssertFalse(texts.contains { $0.contains("hello") })
        }
    }

    func testKeyboardPresenceWithholdsAllTextInputTypes() {
        for keyboardFocused in [false, true] {
            for type in [45, 49, 50, 52] {
                let root = TVNodeSketch(elementType: 2, children: [
                    TVNodeSketch(elementType: type, label: "Label", value: "s3cret"),
                    TVNodeSketch(elementType: 19, hasFocus: keyboardFocused, children: [
                        TVNodeSketch(elementType: type, label: "Label", value: "s3cret"),
                    ]),
                    TVNodeSketch(elementType: type, label: "Label", value: "s3cret"),
                ])
                let texts = emittedTexts(in: root)
                XCTAssertFalse(texts.contains { $0.contains("s3cret") })
                XCTAssertEqual(texts.filter { $0 == "Label" }.count, 3)
            }
        }
    }

    func testKeyboardSubtreeAndMultipleEntriesWithholdValues() {
        var root = keyboardTree(value: "hello")
        root.children.insert(TVNodeSketch(elementType: 19, hasFocus: true, children: [
            TVNodeSketch(elementType: 52, value: "inside keyboard"),
        ]), at: 0)
        root.children.append(TVNodeSketch(elementType: 49, value: "later field"))
        XCTAssertTrue(TVTextEntryPolicy.resolve(root: root).keyboardPresent)
        let texts = emittedTexts(in: root)
        for value in ["hello", "inside keyboard", "later field"] {
            XCTAssertFalse(texts.contains { $0.contains(value) })
        }
    }

    func testPlainLabeledFieldEmitsOnlyLabelUntilKeyboardCloses() {
        let field = TVNodeSketch(
            elementType: 49, identifier: "am-labeled-field", label: "Label", value: "hello",
            placeholder: "Placeholder", hasFocus: true
        )
        var open = keyboardTree(value: "hello")
        open.children.append(field)
        XCTAssertTrue(emittedTexts(in: open).contains("Label"))
        XCTAssertFalse(emittedTexts(in: open).contains { $0.contains("hello") })
        XCTAssertFalse(TVTextEntryPolicy.resolve(root: field).keyboardPresent)
        XCTAssertEqual(emittedTexts(in: field), ["Label hello"])
    }

    func testAppendTextRequiresKeyboardFocus() {
        let field = TVNodeSketch(elementType: 49, hasFocus: true)
        XCTAssertFalse(TVTextEntryPolicy.hasKeyboard(field))
        XCTAssertFalse(TVTextEntryPolicy.hasFocusedKeyboard(field))
        for focused in [false, true] {
            let root = keyboardTree(value: "", keyboardFocused: focused)
            XCTAssertTrue(TVTextEntryPolicy.hasKeyboard(root))
            XCTAssertEqual(TVTextEntryPolicy.hasFocusedKeyboard(root), focused)
        }
    }

    func testWithoutKeyboardPlainFieldsStillEmitLabelAndValue() {
        for type in [45, 49, 52] {
            let root = TVNodeSketch(elementType: type, label: "Label", value: "hello", placeholder: "Placeholder")
            XCTAssertEqual(emittedTexts(in: root), ["Label hello"])
        }
        let placeholder = TVNodeSketch(
            elementType: 49,
            label: "Label",
            value: "Placeholder",
            placeholder: "Placeholder"
        )
        XCTAssertEqual(emittedTexts(in: placeholder), ["Label"])
    }

    func testSecureFieldsNeverEmitValuesAfterKeyboardCloses() {
        for secret in ["s3cret", "1234"] {
            for field in [
                TVNodeSketch(elementType: 50, label: "Code", value: secret),
                TVNodeSketch(elementType: 49, identifier: "userPIN", label: "Code", value: secret),
                TVNodeSketch(elementType: 49, label: "Password", value: secret),
                TVNodeSketch(elementType: 52, label: "Code", value: secret, placeholder: "Secret"),
            ] {
                XCTAssertFalse(TVTextEntryPolicy.resolve(root: field).keyboardPresent)
                XCTAssertEqual(emittedTexts(in: field), [field.label])
            }
        }
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
