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

    private var labeledField: TVFocusedField {
        TVFocusedField(identifier: "am-labeled-field", label: "Label", placeholder: "Placeholder", isSecure: false)
    }

    private var secureField: TVFocusedField {
        TVFocusedField(identifier: "am-secure-field", label: "", placeholder: "Secret", isSecure: true)
    }

    private var closedLabeledField: TVNodeSketch {
        TVNodeSketch(
            elementType: 49, identifier: "am-labeled-field", label: "Label",
            value: "hello", placeholder: "Placeholder", hasFocus: true
        )
    }

    /// Walk every emitted text using the same resolution as the router, including fallback nodes.
    private func emittedTexts(in root: TVNodeSketch, field: TVFocusedField?) -> [String] {
        let resolution = TVTextEntryPolicy.resolve(root: root, lastFocusedField: field)
        func walk(_ node: TVNodeSketch, path: [Int]) -> [String] {
            [resolution.text(for: node, path: path)] + node.children.enumerated().flatMap { index, child in
                walk(child, path: path + [index])
            }
        }
        return walk(root, path: [])
    }

    /// Captured tvOS tree, omitting the 40 key nodes and retaining the entry container and prompt.
    private func keyboardTree(
        value: String, prompt: String = "Placeholder", button: String = "next", keyboardFocused: Bool = true
    )
        -> TVNodeSketch
    {
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

    func testCapturedKeyboardEntryReportsRememberedLabeledField() throws {
        for (value, expected) in [("hello", "Label hello"), ("", "Label")] {
            var memory = TVFocusMemory()
            let bundle = "dev.jasonpearson.automobile.ctrlproxy.tv"
            memory.observe(bundle: bundle, processToken: 1, root: closedLabeledField)
            let root = keyboardTree(value: value)
            // The app may open its keyboard itself; positive same-generation evidence still permits text.
            memory.observe(bundle: bundle, processToken: 1, root: root)
            let entry = try XCTUnwrap(TVTextEntryPolicy.resolve(
                root: root, lastFocusedField: memory.field(for: bundle, processToken: 1)
            ).entry)
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
            root: root, lastFocusedField: field
        ).entry)
        XCTAssertEqual(entry.text, "")
        XCTAssertEqual(entry.resourceId, "am-secure-field")
        // A label is still allowed for a secure field; its value is never used.
        let labeledSecure = TVFocusedField(
            identifier: field.identifier, label: "Secret", placeholder: "Secret", isSecure: true
        )
        XCTAssertEqual(TVTextEntryPolicy.resolve(
            root: root, lastFocusedField: labeledSecure
        ).entry?.text, "Secret")
    }

    func testUnknownKeyboardEntryWithholdsValue() throws {
        let root = keyboardTree(value: "s3cret", prompt: "Secret", button: "done")
        let entry = try XCTUnwrap(TVTextEntryPolicy.resolve(
            root: root, lastFocusedField: nil
        ).entry)
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
            root: root, lastFocusedField: labeledField
        ).entry)
        XCTAssertEqual(TVTextEntryPolicy.rememberedField(in: root, previous: nil), labeledField)
    }

    func testKeyboardSubtreeIsExcludedAndMultipleEntriesWithholdValues() {
        // Synthetic placement checks subtree exclusion and ambiguous attribution.
        var root = keyboardTree(value: "hello")
        root.children.insert(TVNodeSketch(elementType: 19, hasFocus: true, children: [
            TVNodeSketch(elementType: 52, value: "inside keyboard"),
        ]), at: 0)
        root.children.append(TVNodeSketch(elementType: 49, value: "later field"))
        let resolution = TVTextEntryPolicy.resolve(root: root, lastFocusedField: labeledField)
        XCTAssertTrue(resolution.keyboardPresent)
        XCTAssertNil(resolution.entry)
        XCTAssertNil(resolution.overrideEntry(at: [1, 0, 0, 1, 0, 0]))
        XCTAssertNil(resolution.overrideEntry(at: [2]))
        XCTAssertFalse(emittedTexts(in: root, field: labeledField).contains { $0.contains("hello") })
        XCTAssertFalse(emittedTexts(in: root, field: labeledField).contains { $0.contains("inside keyboard") })
        XCTAssertFalse(emittedTexts(in: root, field: labeledField).contains { $0.contains("later field") })
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
        XCTAssertEqual(
            TVTextEntryPolicy.rememberedField(in: keyboardTree(value: "hello", prompt: "Text"), previous: field),
            field
        )
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

    func testReviewReproAButtonFocusNeverLeaksSecureEntryAnywhere() throws {
        for button in ["next", "done"] {
            let root = keyboardTree(value: "s3cret", prompt: "Secret", button: button, keyboardFocused: false)
            XCTAssertTrue(TVTextEntryPolicy.hasKeyboard(root))
            XCTAssertFalse(TVTextEntryPolicy.hasFocusedKeyboard(root))
            for field in [secureField, labeledField, nil] as [TVFocusedField?] {
                let resolution = TVTextEntryPolicy.resolve(root: root, lastFocusedField: field)
                let entry = try XCTUnwrap(resolution.entry)
                XCTAssertEqual(entry.text, "")
                XCTAssertEqual(entry.resourceId, field == secureField ? secureField.identifier : nil)
                XCTAssertFalse(emittedTexts(in: root, field: field).contains { $0.contains("s3cret") })
            }
        }
    }

    func testButtonFocusKeepsPositivelyAttributedPlainEntry() throws {
        let root = keyboardTree(value: "hello", keyboardFocused: false)
        let resolution = TVTextEntryPolicy.resolve(root: root, lastFocusedField: labeledField)
        let entry = try XCTUnwrap(resolution.entry)
        XCTAssertEqual(entry.text, "Label hello")
        XCTAssertEqual(entry.resourceId, labeledField.identifier)
        XCTAssertTrue(entry.focused)
        XCTAssertEqual(resolution.overrideEntry(at: entry.path), entry)
        XCTAssertEqual(emittedTexts(in: root, field: labeledField).filter { $0.contains("hello") }, ["Label hello"])
        XCTAssertFalse(emittedTexts(in: root, field: nil).contains { $0.contains("hello") })
    }

    func testPromptMismatchDropsIdentityEvenWhileKeyboardHasFocus() throws {
        let root = keyboardTree(value: "s3cret", prompt: "Secret", button: "done")
        XCTAssertNil(TVTextEntryPolicy.rememberedField(in: root, previous: labeledField))
        let entry = try XCTUnwrap(TVTextEntryPolicy.resolve(root: root, lastFocusedField: labeledField).entry)
        XCTAssertNil(entry.resourceId)
        XCTAssertEqual(entry.text, "")
        XCTAssertFalse(emittedTexts(in: root, field: labeledField).contains { $0.contains("s3cret") })
    }

    func testEmptyPromptNeverAttributesRememberedPlainFieldToSecureEntry() throws {
        let bundle = "dev.jasonpearson.automobile.ctrlproxy.tv"
        for (type, identifier) in [(50, ""), (49, "userPIN"), (49, "")] {
            var memory = TVFocusMemory()
            memory.observe(bundle: bundle, processToken: 1, root: TVNodeSketch(
                elementType: 49, identifier: "am-text-field", placeholder: "", hasFocus: true
            ))
            XCTAssertNotNil(memory.field(for: bundle, processToken: 1))
            var root = keyboardTree(value: "s3cret", prompt: "")
            root.children[0].children[0].children[0].children[1].children[0].children[0] = TVNodeSketch(
                elementType: type, identifier: identifier, value: "s3cret", placeholder: ""
            )
            let previous = memory.field(for: bundle, processToken: 1)
            // Check resolution directly as well as through observation, so neither layer can mask a leak.
            memory.observe(bundle: bundle, processToken: 1, root: root)
            XCTAssertNil(memory.field(for: bundle, processToken: 1))
            for field in [previous, memory.field(for: bundle, processToken: 1)] {
                let entry = try XCTUnwrap(TVTextEntryPolicy.resolve(root: root, lastFocusedField: field).entry)
                XCTAssertNil(entry.resourceId)
                XCTAssertFalse(entry.text.contains("s3cret"))
                XCTAssertFalse(emittedTexts(in: root, field: field).contains { $0.contains("s3cret") })
            }
        }
    }

    func testMissingPromptNeverAttributesRememberedField() throws {
        let root = TVNodeSketch(elementType: 2, children: [
            TVNodeSketch(elementType: 49, value: "s3cret"),
            TVNodeSketch(elementType: 19, children: [
                TVNodeSketch(elementType: 48, label: "Placeholder"),
            ]),
        ])
        XCTAssertNil(TVTextEntryPolicy.rememberedField(in: root, previous: labeledField))
        let entry = try XCTUnwrap(TVTextEntryPolicy.resolve(root: root, lastFocusedField: labeledField).entry)
        XCTAssertNil(entry.resourceId)
        XCTAssertFalse(entry.text.contains("s3cret"))
        XCTAssertFalse(emittedTexts(in: root, field: labeledField).contains { $0.contains("s3cret") })
    }

    func testPromptCanMatchRememberedLabelAndIgnoresKeyboardStaticText() throws {
        var root = keyboardTree(value: "hello", prompt: "Label")
        root.children.insert(TVNodeSketch(elementType: 19, children: [
            TVNodeSketch(elementType: 48, label: "Secret"),
        ]), at: 0)
        let entry = try XCTUnwrap(TVTextEntryPolicy.resolve(root: root, lastFocusedField: labeledField).entry)
        XCTAssertEqual(entry.text, "Label hello")
        XCTAssertEqual(entry.resourceId, labeledField.identifier)
    }

    func testKeyboardPresenceWithholdsAllUnattributedTextInputTypes() {
        for keyboardFocused in [false, true] {
            for type in [45, 49, 50, 52] {
                let root = TVNodeSketch(elementType: 2, children: [
                    TVNodeSketch(elementType: type, label: "Label", value: "s3cret"),
                    TVNodeSketch(elementType: 19, hasFocus: keyboardFocused, children: [
                        TVNodeSketch(elementType: type, label: "Label", value: "s3cret"),
                    ]),
                    TVNodeSketch(elementType: type, label: "Label", value: "s3cret"),
                ])
                for field in [labeledField, secureField, nil] as [TVFocusedField?] {
                    XCTAssertFalse(emittedTexts(in: root, field: field).contains { $0.contains("s3cret") })
                    XCTAssertEqual(emittedTexts(in: root, field: field).filter { $0 == "Label" }.count, 3)
                }
            }
        }
    }

    func testType50StaysSecureEvenWithMatchingPlainMemoryAndPrompt() {
        let root = TVNodeSketch(elementType: 2, children: [
            TVNodeSketch(elementType: 48, label: "Placeholder"),
            TVNodeSketch(elementType: 50, value: "s3cret"),
            TVNodeSketch(elementType: 19),
        ])
        XCTAssertFalse(emittedTexts(in: root, field: labeledField).contains { $0.contains("s3cret") })
    }

    func testReviewReproBSelectOnNextClearsIdentityBeforeSecureFieldSwitch() throws {
        var memory = TVFocusMemory()
        let bundle = "dev.jasonpearson.automobile.ctrlproxy.tv"
        memory.observe(bundle: bundle, processToken: 1, root: closedLabeledField)
        XCTAssertEqual(memory.field(for: bundle, processToken: 1), labeledField)
        let onNext = keyboardTree(value: "", keyboardFocused: false)
        memory.observe(bundle: bundle, processToken: 1, root: onNext)
        XCTAssertEqual(memory.field(for: bundle, processToken: 1), labeledField)
        memory.willSelect(bundle: bundle, processToken: 1, snapshot: onNext)
        XCTAssertNil(memory.field(for: bundle, processToken: 1))
        let secureUp = keyboardTree(value: "s3cret", prompt: "Secret", button: "done")
        memory.observe(bundle: bundle, processToken: 1, root: secureUp)
        let field = memory.field(for: bundle, processToken: 1)
        XCTAssertNil(field)
        let entry = try XCTUnwrap(TVTextEntryPolicy.resolve(root: secureUp, lastFocusedField: field).entry)
        XCTAssertNil(entry.resourceId)
        XCTAssertEqual(entry.text, "")
        XCTAssertFalse(emittedTexts(in: secureUp, field: field).contains { $0.contains("s3cret") })
    }

    func testSelectWithFocusedOrUnfocusedKeyboardAndSnapshotFailureClearsMemory() {
        let bundle = "dev.jasonpearson.automobile.ctrlproxy.tv"
        let snapshots: [TVNodeSketch?] = [
            keyboardTree(value: "hello"), keyboardTree(value: "hello", keyboardFocused: false), nil,
        ]
        for snapshot in snapshots {
            var memory = TVFocusMemory()
            memory.observe(bundle: bundle, processToken: 1, root: closedLabeledField)
            memory.willSelect(bundle: bundle, processToken: 1, snapshot: snapshot)
            XCTAssertNil(memory.field(for: bundle, processToken: 1))
            let root = keyboardTree(value: "s3cret", prompt: "Secret")
            XCTAssertFalse(
                emittedTexts(in: root, field: memory.field(for: bundle, processToken: 1))
                    .contains { $0.contains("s3cret") }
            )
        }
    }

    func testSelectWithoutKeyboardRemembersFieldAndAppSwitchDiscardsIt() {
        var memory = TVFocusMemory()
        let bundleA = "dev.jasonpearson.automobile.ctrlproxy.tv"
        let bundleB = "com.apple.TVSettings"
        memory.willSelect(bundle: bundleA, processToken: 1, snapshot: closedLabeledField)
        XCTAssertEqual(memory.field(for: bundleA, processToken: 1), labeledField)
        XCTAssertNil(memory.field(for: bundleB, processToken: 1))
        let root = keyboardTree(value: "s3cret", prompt: "Secret")
        memory.observe(bundle: bundleB, processToken: 1, root: root)
        XCTAssertNil(memory.field(for: bundleB, processToken: 1))
        XCTAssertNil(memory.field(for: bundleA, processToken: 1))
        XCTAssertFalse(
            emittedTexts(in: root, field: memory.field(for: bundleB, processToken: 1))
                .contains { $0.contains("s3cret") }
        )
    }

    func testSelectFromFocusedButtonClearsRememberedField() throws {
        var memory = TVFocusMemory()
        let bundle = "dev.jasonpearson.automobile.ctrlproxy.tv"
        memory.observe(bundle: bundle, processToken: 1, root: closedLabeledField)
        XCTAssertEqual(memory.field(for: bundle, processToken: 1), labeledField)
        memory.willSelect(bundle: bundle, processToken: 1, snapshot: TVNodeSketch(elementType: 2, children: [
            TVNodeSketch(elementType: 9, label: "Sign in", hasFocus: true),
        ]))
        XCTAssertNil(memory.field(for: bundle, processToken: 1))
        // A matching prompt cannot revive identity cleared by the button select.
        let root = keyboardTree(value: "s3cret")
        memory.observe(bundle: bundle, processToken: 1, root: root)
        let field = memory.field(for: bundle, processToken: 1)
        let entry = try XCTUnwrap(TVTextEntryPolicy.resolve(root: root, lastFocusedField: field).entry)
        XCTAssertNil(entry.resourceId)
        XCTAssertFalse(entry.text.contains("s3cret"))
        XCTAssertFalse(emittedTexts(in: root, field: field).contains { $0.contains("s3cret") })
    }

    func testSameBundleProcessTokenChangeOrNilDiscardsRememberedField() throws {
        let bundle = "dev.jasonpearson.automobile.ctrlproxy.tv"
        for token in [2, nil] as [Int?] {
            var memory = TVFocusMemory()
            memory.observe(bundle: bundle, processToken: 1, root: closedLabeledField)
            XCTAssertEqual(memory.field(for: bundle, processToken: 1), labeledField)
            let root = keyboardTree(value: "s3cret")
            memory.observe(bundle: bundle, processToken: token, root: root)
            let field = memory.field(for: bundle, processToken: token)
            XCTAssertNil(field)
            let entry = try XCTUnwrap(TVTextEntryPolicy.resolve(root: root, lastFocusedField: field).entry)
            XCTAssertNil(entry.resourceId)
            XCTAssertFalse(entry.text.contains("s3cret"))
            XCTAssertFalse(emittedTexts(in: root, field: field).contains { $0.contains("s3cret") })
            memory.observe(bundle: bundle, processToken: 1, root: root)
            XCTAssertNil(memory.field(for: bundle, processToken: 1))
        }
    }

    func testUnknownOrChangedProcessTokenLookupCannotReviveMemory() {
        let bundle = "dev.jasonpearson.automobile.ctrlproxy.tv"
        for token in [2, nil] as [Int?] {
            var memory = TVFocusMemory()
            memory.willSelect(bundle: bundle, processToken: 1, snapshot: closedLabeledField)
            XCTAssertEqual(memory.field(for: bundle, processToken: 1), labeledField)
            XCTAssertNil(memory.field(for: bundle, processToken: token))
            XCTAssertNil(memory.field(for: bundle, processToken: 1))
            memory.observe(bundle: bundle, processToken: nil, root: closedLabeledField)
            XCTAssertNil(memory.field(for: bundle, processToken: nil))
            memory.willSelect(bundle: bundle, processToken: nil, snapshot: closedLabeledField)
            XCTAssertNil(memory.field(for: bundle, processToken: nil))
            XCTAssertNil(memory.field(for: bundle, processToken: 1))
        }
    }

    func testMemoryObservationDiscardsMismatchedPrompt() {
        var memory = TVFocusMemory()
        let bundle = "dev.jasonpearson.automobile.ctrlproxy.tv"
        memory.observe(bundle: bundle, processToken: 1, root: closedLabeledField)
        memory.observe(bundle: bundle, processToken: 1, root: keyboardTree(value: "s3cret", prompt: "Secret"))
        XCTAssertNil(memory.field(for: bundle, processToken: 1))
        memory.observe(bundle: bundle, processToken: 1, root: keyboardTree(value: "hello"))
        XCTAssertNil(memory.field(for: bundle, processToken: 1))
    }

    func testWithoutKeyboardPlainFieldsStillEmitLabelAndValue() {
        for type in [45, 49, 52] {
            let root = TVNodeSketch(elementType: type, label: "Label", value: "hello", placeholder: "Placeholder")
            XCTAssertEqual(emittedTexts(in: root, field: nil), ["Label hello"])
        }
        let placeholder = TVNodeSketch(
            elementType: 49,
            label: "Label",
            value: "Placeholder",
            placeholder: "Placeholder"
        )
        XCTAssertEqual(emittedTexts(in: placeholder, field: nil), ["Label"])
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
