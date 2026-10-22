@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeContractValidatorTests: XCTestCase {
    /// Host-only semantics, kept explicit: any newly rejected exemption must be removed.
    private let EXEMPT: [String: String] = [
        "card-nested-bad-child.json": "State declaration, type, range or action binding requires host semantics.",
        "carousel-in-horizontal-scroll.json": "Ancestor layout or combined component options require host semantics.",
        "chart-point-non-numeric-y.json": "Chart data and inter-field rules require host semantics (renderer out of scope).",
        "chart-point-not-object.json": "Chart data and inter-field rules require host semantics (renderer out of scope).",
        "chart-ring-goal-zero.json": "Chart data and inter-field rules require host semantics (renderer out of scope).",
        "chart-ring-missing-goal.json": "Chart data and inter-field rules require host semantics (renderer out of scope).",
        "chart-ring-two-series.json": "Chart data and inter-field rules require host semantics (renderer out of scope).",
        "chart-series-path-not-array.json": "Chart data and inter-field rules require host semantics (renderer out of scope).",
        "chart-y-range-inverted.json": "Chart data and inter-field rules require host semantics (renderer out of scope).",
        "chat-scroll-at-end-key-repeat-undeclared.json": "State declaration, type, range or action binding requires host semantics.",
        "chat-scroll-at-end-key-string.json": "State declaration, type, range or action binding requires host semantics.",
        "chat-scroll-at-end-key-undeclared.json": "State declaration, type, range or action binding requires host semantics.",
        "chat-scroll-horizontal-reverse.json": "Ancestor layout or combined component options require host semantics.",
        "chat-scroll-to-duplicate-id.json": "Cross-node identity and target resolution require host semantics.",
        "chat-scroll-to-unknown-id.json": "Cross-node identity and target resolution require host semantics.",
        "checkbox-undeclared-state.json": "State declaration, type, range or action binding requires host semantics.",
        "checks-bounds-order.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-checkbox-format.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-checkbox-max.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-checkbox-maxLength.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-checkbox-min.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-checkbox-minLength.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-checkbox-pattern.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-datePicker-format.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-datePicker-maxLength.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-datePicker-minLength.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-datePicker-pattern.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-guard-missing.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-guard-value.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-length-order.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-1.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-10.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-11.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-12.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-13.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-14.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-15.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-16.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-17.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-18.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-19.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-2.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-20.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-21.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-22.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-23.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-24.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-25.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-26.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-27.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-28.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-3.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-30.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-31.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-32.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-33.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-34.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-35.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-36.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-37.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-38.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-39.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-4.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-40.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-41.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-42.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-43.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-44.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-45.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-46.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-47.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-5.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-6.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-7.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-8.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-pattern-9.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-radioGroup-format.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-radioGroup-max.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-radioGroup-maxLength.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-radioGroup-min.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-radioGroup-minLength.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-radioGroup-pattern.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-slider-format.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-slider-maxLength.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-slider-minLength.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-slider-pattern.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-switch-format.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-switch-max.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-switch-maxLength.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-switch-min.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-switch-minLength.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-switch-pattern.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-textField-max.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-textField-min.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-timePicker-format.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-timePicker-maxLength.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-timePicker-minLength.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-timePicker-pattern.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-valid-missing.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "checks-valid-value.json": "Check applicability, pattern grammar and referenced values require host semantics.",
        "chip-assist-with-state-key.json": "State declaration, type, range or action binding requires host semantics.",
        "chip-filter-without-state-key.json": "State declaration, type, range or action binding requires host semantics.",
        "chip-state-type.json": "State declaration, type, range or action binding requires host semantics.",
        "chip-suggestion-with-state-key.json": "State declaration, type, range or action binding requires host semantics.",
        "dangling-action.json": "Cross-node identity and target resolution require host semantics.",
        "dangling-pager.json": "Cross-node identity and target resolution require host semantics.",
        "dangling-stack.json": "Cross-node identity and target resolution require host semantics.",
        "data-action-key-only-in-data.json": "State declaration, type, range or action binding requires host semantics.",
        "data-condition-templated-operand.json": "Emit, link or template scope requires host semantics.",
        "data-repeat-bound-key-invalid.json": "Repeat binding, expansion or substituted-text budgets require host semantics.",
        "data-repeat-bound-key-undeclared.json": "Repeat binding, expansion or substituted-text budgets require host semantics.",
        "data-repeat-key-duplicate.json": "Repeat binding, expansion or substituted-text budgets require host semantics.",
        "data-repeat-key-unknown-field.json": "Repeat binding, expansion or substituted-text budgets require host semantics.",
        "data-repeat-path-cell-limit.json": "Repeat binding, expansion or substituted-text budgets require host semantics.",
        "data-repeat-path-item-not-object.json": "Repeat binding, expansion or substituted-text budgets require host semantics.",
        "data-repeat-path-missing.json": "Repeat binding, expansion or substituted-text budgets require host semantics.",
        "data-repeat-path-not-array.json": "Repeat binding, expansion or substituted-text budgets require host semantics.",
        "data-repeat-path-too-many-items.json": "Repeat binding, expansion or substituted-text budgets require host semantics.",
        "data-repeat-unknown-field.json": "Repeat binding, expansion or substituted-text budgets require host semantics.",
        "date-picker-invalid-date.json": "State declaration, type, range or action binding requires host semantics.",
        "date-picker-out-of-range.json": "State declaration, type, range or action binding requires host semantics.",
        "decrement-nonnumeric.json": "State declaration, type, range or action binding requires host semantics.",
        "dialog-open-state-type.json": "State declaration, type, range or action binding requires host semantics.",
        "duplicate-pager.json": "Cross-node identity and target resolution require host semantics.",
        "duplicate-stack.json": "Cross-node identity and target resolution require host semantics.",
        "emit-context-index-outside.json": "Emit, link or template scope requires host semantics.",
        "emit-context-item-missing-in-one-row.json": "Emit, link or template scope requires host semantics.",
        "emit-context-item-outside.json": "Emit, link or template scope requires host semantics.",
        "emit-context-unknown-item.json": "Emit, link or template scope requires host semantics.",
        "emit-context-unknown-page.json": "Emit, link or template scope requires host semantics.",
        "emit-context-unprojected-data-item.json": "Emit, link or template scope requires host semantics.",
        "fab-extended-with-size.json": "Combined component options require host semantics.",
        "grid-span-exceeds-columns.json": "Combined component options require host semantics.",
        "grid-span-outside-grid.json": "Combined component options require host semantics.",
        "increment-nonnumeric.json": "State declaration, type, range or action binding requires host semantics.",
        "invalid-selection-binding.json": "State declaration, type, range or action binding requires host semantics.",
        "invalid-state-binding.json": "State declaration, type, range or action binding requires host semantics.",
        "linkify-match-into-switch.json": "Emit, link or template scope requires host semantics.",
        "linkify-match-outside.json": "Emit, link or template scope requires host semantics.",
        "linkify-repeat-binding.json": "Emit, link or template scope requires host semantics.",
        "linkify-with-spans.json": "Emit, link or template scope requires host semantics.",
        "list-item-trailing-state-type.json": "State declaration, type, range or action binding requires host semantics.",
        "list-item-trailing-undeclared.json": "State declaration, type, range or action binding requires host semantics.",
        "long-press-dangling-pager.json": "Cross-node identity and target resolution require host semantics.",
        "menu-open-state-type.json": "State declaration, type, range or action binding requires host semantics.",
        "motion-zoomable-double-tap.json": "Combined component options require host semantics.",
        "pager-default-axis-in-horizontal-scroll.json": "Ancestor layout or combined component options require host semantics.",
        "pager-horizontal-in-horizontal-scroll.json": "Ancestor layout or combined component options require host semantics.",
        "pager-vertical-in-default-scroll.json": "Ancestor layout or combined component options require host semantics.",
        "pager-vertical-in-vertical-scroll.json": "Ancestor layout or combined component options require host semantics.",
        "platform-argument-value.json": "Platform registry, declarations and action context require host semantics.",
        "platform-condition-unknown-module.json": "Platform registry, declarations and action context require host semantics.",
        "platform-duplicate-permission.json": "Platform registry, declarations and action context require host semantics.",
        "platform-event-outside-handler.json": "Platform registry, declarations and action context require host semantics.",
        "platform-into-array-element.json": "Platform registry, declarations and action context require host semantics.",
        "platform-into-platform.json": "Platform registry, declarations and action context require host semantics.",
        "platform-missing-argument.json": "Platform registry, declarations and action context require host semantics.",
        "platform-repeat-unknown-item.json": "Platform registry, declarations and action context require host semantics.",
        "platform-reserved-emit.json": "Platform registry, declarations and action context require host semantics.",
        "platform-status-key-undeclared.json": "Platform registry, declarations and action context require host semantics.",
        "platform-undeclared-background.json": "Platform registry, declarations and action context require host semantics.",
        "platform-undeclared-module-handler.json": "Platform registry, declarations and action context require host semantics.",
        "platform-undeclared-module-read.json": "Platform registry, declarations and action context require host semantics.",
        "platform-undeclared-module.json": "Platform registry, declarations and action context require host semantics.",
        "platform-undeclared-permission.json": "Platform registry, declarations and action context require host semantics.",
        "platform-unknown-argument.json": "Platform registry, declarations and action context require host semantics.",
        "platform-unknown-call.json": "Platform registry, declarations and action context require host semantics.",
        "platform-unknown-event.json": "Platform registry, declarations and action context require host semantics.",
        "platform-unknown-module.json": "Platform registry, declarations and action context require host semantics.",
        "progress-max-not-positive.json": "State declaration, type, range or action binding requires host semantics.",
        "progress-max-without-state-key.json": "State declaration, type, range or action binding requires host semantics.",
        "progress-value-out-of-range.json": "State declaration, type, range or action binding requires host semantics.",
        "radio-group-duplicate-value.json": "Option value uniqueness requires host semantics.",
        "radio-group-state-type.json": "State declaration, type, range or action binding requires host semantics.",
        "radio-group-undeclared-state.json": "State declaration, type, range or action binding requires host semantics.",
        "repeat-bound-key-invalid.json": "Repeat binding, expansion or substituted-text budgets require host semantics.",
        "repeat-bound-key-outside-template.json": "Repeat binding, expansion or substituted-text budgets require host semantics.",
        "repeat-bound-key-undeclared.json": "Repeat binding, expansion or substituted-text budgets require host semantics.",
        "repeat-bound-key-unknown-field.json": "Repeat binding, expansion or substituted-text budgets require host semantics.",
        "repeat-field-missing-in-one-item.json": "Repeat binding, expansion or substituted-text budgets require host semantics.",
        "repeat-image-limit-expanded.json": "Repeat binding, expansion or substituted-text budgets require host semantics.",
        "repeat-nested.json": "Repeat binding, expansion or substituted-text budgets require host semantics.",
        "repeat-node-limit-expanded.json": "Repeat binding, expansion or substituted-text budgets require host semantics.",
        "repeat-pager-in-template.json": "Repeat binding, expansion or substituted-text budgets require host semantics.",
        "repeat-unknown-action-field.json": "Repeat binding, expansion or substituted-text budgets require host semantics.",
        "repeat-unknown-condition-field.json": "Repeat binding, expansion or substituted-text budgets require host semantics.",
        "repeat-unknown-emit-name-field.json": "Repeat binding, expansion or substituted-text budgets require host semantics.",
        "repeat-unknown-text-field.json": "Repeat binding, expansion or substituted-text budgets require host semantics.",
        "repeat-unknown-visible-when-field.json": "Repeat binding, expansion or substituted-text budgets require host semantics.",
        "scroll-refresh-horizontal.json": "Ancestor layout or combined component options require host semantics.",
        "scroll-refresh-state-type.json": "State declaration, type, range or action binding requires host semantics.",
        "search-bar-active-key-not-boolean.json": "State declaration, type, range or action binding requires host semantics.",
        "search-bar-active-key-undeclared.json": "State declaration, type, range or action binding requires host semantics.",
        "search-bar-state-key-not-string.json": "State declaration, type, range or action binding requires host semantics.",
        "search-bar-state-key-undeclared.json": "State declaration, type, range or action binding requires host semantics.",
        "segmented-button-duplicate-value.json": "Option value uniqueness requires host semantics.",
        "segmented-button-state-type.json": "State declaration, type, range or action binding requires host semantics.",
        "select-duplicate-values.json": "Option value uniqueness requires host semantics.",
        "select-state-type.json": "State declaration, type, range or action binding requires host semantics.",
        "set-state-checkbox-number.json": "State declaration, type, range or action binding requires host semantics.",
        "set-state-date-picker-bad-date.json": "State declaration, type, range or action binding requires host semantics.",
        "set-state-dialog-open-string.json": "State declaration, type, range or action binding requires host semantics.",
        "set-state-radio-boolean.json": "State declaration, type, range or action binding requires host semantics.",
        "set-state-repeat-item-slider-range.json": "State declaration, type, range or action binding requires host semantics.",
        "set-state-slider-out-of-range.json": "State declaration, type, range or action binding requires host semantics.",
        "set-state-slider-string.json": "State declaration, type, range or action binding requires host semantics.",
        "set-state-switch-string.json": "State declaration, type, range or action binding requires host semantics.",
        "set-state-tab-bar-negative.json": "State declaration, type, range or action binding requires host semantics.",
        "set-state-text-field-number.json": "State declaration, type, range or action binding requires host semantics.",
        "set-state-time-picker-hour-range.json": "State declaration, type, range or action binding requires host semantics.",
        "sheet-state-type.json": "State declaration, type, range or action binding requires host semantics.",
        "shimmer-on-text-style-when.json": "Combined component options require host semantics.",
        "shimmer-on-text.json": "Combined component options require host semantics.",
        "slider-min-not-below-max.json": "State declaration, type, range or action binding requires host semantics.",
        "slider-state-type.json": "State declaration, type, range or action binding requires host semantics.",
        "slider-step-not-dividing.json": "State declaration, type, range or action binding requires host semantics.",
        "slider-step-zero.json": "State declaration, type, range or action binding requires host semantics.",
        "slider-value-out-of-range.json": "State declaration, type, range or action binding requires host semantics.",
        "snackbar-open-state-type.json": "State declaration, type, range or action binding requires host semantics.",
        "stack-substituted-text-data-limit.json": "Repeat binding, expansion or substituted-text budgets require host semantics.",
        "stack-unknown-screen.json": "Cross-node identity and target resolution require host semantics.",
        "stack-unknown-start.json": "Cross-node identity and target resolution require host semantics.",
        "substituted-text-data-limit.json": "Repeat binding, expansion or substituted-text budgets require host semantics.",
        "substituted-text-data-repeat-cascade.json": "Repeat binding, expansion or substituted-text budgets require host semantics.",
        "substituted-text-repeat-emit-limit.json": "Repeat binding, expansion or substituted-text budgets require host semantics.",
        "substituted-text-repeat-limit.json": "Repeat binding, expansion or substituted-text budgets require host semantics.",
        "substituted-text-repeat-path-limit.json": "Repeat binding, expansion or substituted-text budgets require host semantics.",
        "substituted-text-total-data-in-repeat-limit.json": "Repeat binding, expansion or substituted-text budgets require host semantics.",
        "substituted-text-total-data-limit.json": "Repeat binding, expansion or substituted-text budgets require host semantics.",
        "substituted-text-total-repeat-limit.json": "Repeat binding, expansion or substituted-text budgets require host semantics.",
        "swipe-actions-empty.json": "Ancestor layout or combined component options require host semantics.",
        "swipe-actions-in-carousel.json": "Ancestor layout or combined component options require host semantics.",
        "swipe-actions-in-horizontal-pager.json": "Ancestor layout or combined component options require host semantics.",
        "switch-state-type.json": "State declaration, type, range or action binding requires host semantics.",
        "text-field-ime-multiline.json": "Combined component options require host semantics.",
        "text-field-line-range.json": "Combined component options require host semantics.",
        "text-field-max-lines-without-multiline.json": "Combined component options require host semantics.",
        "text-field-min-lines-without-multiline.json": "Combined component options require host semantics.",
        "text-field-multiline-password.json": "Combined component options require host semantics.",
        "text-field-multiline-secure.json": "Combined component options require host semantics.",
        "text-field-on-submit-multiline.json": "Combined component options require host semantics.",
        "text-field-value-too-long.json": "State declaration, type, range or action binding requires host semantics.",
        "text-spans-unknown-repeat-field.json": "Repeat binding, expansion or substituted-text budgets require host semantics.",
        "theme-modes-repeat-image-limit-expanded.json": "Repeat binding, expansion or substituted-text budgets require host semantics.",
        "time-picker-hour-out-of-range.json": "State declaration, type, range or action binding requires host semantics.",
        "time-picker-minute-not-integer.json": "State declaration, type, range or action binding requires host semantics.",
        "time-picker-same-keys.json": "State declaration, type, range or action binding requires host semantics.",
        "toggle-nonboolean.json": "State declaration, type, range or action binding requires host semantics.",
        "toggle-undeclared.json": "State declaration, type, range or action binding requires host semantics.",
    ]

    private var fixtures: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec")
    }

    private func files(_ directory: String) throws -> [URL] {
        try FileManager.default.contentsOfDirectory(
            at: fixtures.appendingPathComponent(directory),
            includingPropertiesForKeys: nil
        )
        .filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    func testValidFixtures() throws {
        let hostAnchors: Set<String> = [
            "doc-example-3.json",
            "exact-selector-depth.json",
            "floating-element-anchor.json",
        ]
        let valid = try files("valid")
        XCTAssertTrue(hostAnchors.isSubset(of: Set(valid.map(\.lastPathComponent))))
        XCTAssertFalse(valid.isEmpty)
        for url in valid {
            let data = try Data(contentsOf: url)
            XCTAssertNoThrow(try PrototypeContractValidator.validate(data: data), url.lastPathComponent)
            if hostAnchors.contains(url.lastPathComponent) {
                XCTAssertThrowsError(try PrototypeEmbeddedSpec.load(data: data)) { error in
                    XCTAssertEqual(
                        error as? PrototypeLoadError,
                        .invalidSpec(
                            path: "root.anchor",
                            message: "Element anchors must be resolved to bounds by the host"
                        )
                    )
                }
            } else {
                XCTAssertNoThrow(try PrototypeEmbeddedSpec.load(data: data), url.lastPathComponent)
            }
        }
        print("Validated \(valid.count) valid fixtures; \(hostAnchors.count) retain host-anchor diagnostics")
    }

    private struct InvalidFixture: Decodable {
        let spec: JSONValue
        let expectedPath: String
    }

    func testInvalidFixtures() throws {
        let invalid = try files("invalid")
        XCTAssertFalse(invalid.isEmpty)
        XCTAssertTrue(Set(EXEMPT.keys).isSubset(of: Set(invalid.map(\.lastPathComponent))))
        for url in invalid {
            // Foundation rejects lone UTF-16 surrogates before a raw JSON tree exists. Decode
            // the envelope using a replacement key, then restore the original invalid escape.
            let surrogate = url.lastPathComponent == "surrogate-key.json"
            let source = try String(contentsOf: url, encoding: .utf8)
            let envelope = surrogate ? source.replacingOccurrences(of: #""\ud800""#, with: #""\ufffd""#) : source
            let fixture = try JSONDecoder().decode(InvalidFixture.self, from: Data(envelope.utf8))
            let encoded = try XCTUnwrap(String(data: JSONEncoder().encode(fixture.spec), encoding: .utf8))
            let data = Data((surrogate ? encoded.replacingOccurrences(of: "�", with: #"\ud800"#) : encoded).utf8)
            do {
                try PrototypeContractValidator.validate(data: data)
                XCTAssertNotNil(EXEMPT[url.lastPathComponent], "ACCEPTED \(url.lastPathComponent)")
            } catch let PrototypeLoadError.invalidSpec(path, _) {
                XCTAssertNil(EXEMPT[url.lastPathComponent], "Remove stale exemption: \(url.lastPathComponent)")
                XCTAssertEqual(path, surrogate ? "$" : fixture.expectedPath, url.lastPathComponent)
            }
        }
        print("Checked \(invalid.count) invalid fixtures; \(EXEMPT.count) host-only exemptions")
    }

    private func assertInvalid(_ json: String, path: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try PrototypeLoadError.validate(spec: Data(json.utf8)), file: file, line: line) { error in
            guard case let PrototypeLoadError.invalidSpec(actual, _) = error else {
                return XCTFail("Expected invalidSpec, got \(error)", file: file, line: line)
            }
            XCTAssertEqual(actual, path, file: file, line: line)
        }
    }

    func testDataDiagnosticPreservesPunctuationInKeys() {
        assertInvalid(
            #"{"id":"x","window":{"placement":{"type":"fullscreen"}},"root":{"type":"spacer"},"data":{"a: b":null}}"#,
            path: #"data["a: b"]"#
        )
    }

    func testUniqueStringsCompareExactUTF16() throws {
        let distinct =
            #"{"id":"x","window":{"placement":{"type":"fullscreen"}},"root":{"type":"spacer"},"storage":{"version":1,"keys":["/data/é","/data/e\u0301"]}}"#
        XCTAssertNoThrow(try PrototypeContractValidator.validate(data: Data(distinct.utf8)))
        let duplicate = distinct.replacingOccurrences(of: #"e\u0301"#, with: "é")
        assertInvalid(duplicate, path: "storage.keys[1]")
    }

    func testUnknownWidgetShowsLoadError() {
        assertInvalid(
            #"{"id":"x","window":{"placement":{"type":"fullscreen"}},"root":{"type":"futureWidget"}}"#,
            path: "root.type"
        )
    }

    func testUnknownTopLevelFieldShowsLoadError() {
        assertInvalid(
            #"{"id":"x","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"ok"},"extra":true}"#,
            path: "extra"
        )
    }

    func testMalformedStorageShowsLoadError() {
        assertInvalid(
            #"{"id":"x","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"ok"},"storage":{"keys":"bad"}}"#,
            path: "storage.keys"
        )
    }
}
