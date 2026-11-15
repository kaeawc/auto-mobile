@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

/// R1 fixtures shared with the TypeScript and Kotlin validators: a library spec uses no sensitive module.
final class PrototypeLibraryModulesTests: XCTestCase {
    private func files() throws -> [URL] {
        let directory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec/library-modules")
        return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    func testFixturesCoverRefusedCallsARefusedHandlerAndAcceptedModules() throws {
        let names = try files().map(\.lastPathComponent)
        XCTAssertEqual(names.filter { $0.hasPrefix("valid-") }.count, 3)
        XCTAssertEqual(names.filter { !$0.hasPrefix("valid-") }.count, 4)
    }

    func testLibraryModuleFixtures() throws {
        for file in try files() {
            let name = file.lastPathComponent
            let fixture = try XCTUnwrap(
                JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: file)).objectFields, name
            )
            XCTAssertEqual(fixture["options"], .object(["library": .bool(true)]), name)
            let spec = try XCTUnwrap(fixture["spec"], name)
            let data = try JSONEncoder().encode(spec)
            XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(data: data), name)
            let path = fixture["expectedPath"]?.stringValue
            XCTAssertEqual(path == nil, name.hasPrefix("valid-"), name)
            guard let path else {
                XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(data: data, library: true), name)
                continue
            }
            let message = try XCTUnwrap(fixture["expectedMessage"]?.stringValue, name)
            XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(data: data, library: true), name) {
                XCTAssertEqual($0 as? PrototypeLoadError, .invalidSpec(path: path, message: message), name)
            }
        }
    }

    func testPasteButtonIsASensitiveCallAtItsNodePath() throws {
        let spec: [String: JSONValue] = [
            "root": .object(["type": .string("column"), "children": .array([
                .object(["type": .string("pasteButton"), "into": .string("/data/code")]),
            ])]),
        ]
        XCTAssertEqual(PrototypeLibraryModuleRule.uses(spec), [.init(
            path: "root.children[0]",
            message: "Sensitive platform call clipboard.paste is unavailable in a library",
            module: "clipboard"
        )])
    }

    func testPayloadAndValueLiteralsAreData() {
        let call: JSONValue = .object(["type": .string("platform"), "call": .string("clipboard.paste")])
        let spec: [String: JSONValue] = [
            "root": .object(["type": .string("button"), "onTap": .array([
                .object(["type": .string("emit"), "name": .string("x"), "payload": call]),
                .object(["value": call]),
            ])]),
        ]
        XCTAssertEqual(PrototypeLibraryModuleRule.uses(spec), [])
    }

    // MARK: R6 provenance

    func testProvenanceNamesTheModuleOfEachRefusedFixtureAndNothingForAcceptedOnes() throws {
        let expected = [
            "call-clipboard-paste.json": ["clipboard"], "call-share-open.json": ["share"],
            "call-test-protected.json": ["test"], "event-notifications-reply.json": ["notifications"],
            "valid-device-changed.json": [], "valid-haptics-perform.json": [], "valid-sound-play.json": [],
        ]
        for file in try files() {
            let fixture = try XCTUnwrap(JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: file)).objectFields)
            let spec = try JSONEncoder().encode(XCTUnwrap(fixture["spec"]))
            let name = file.lastPathComponent
            XCTAssertEqual(PrototypeLibraryProvenance.sensitiveModules(spec), expected[name], name)
        }
        XCTAssertEqual(PrototypeLibraryProvenance.sensitiveModules(Data("not json".utf8)), [])
    }

    func testProvenanceNamesEachModuleOnceInOrder() {
        let paste: JSONValue = .object(["type": .string("platform"), "call": .string("clipboard.paste")])
        let share: JSONValue = .object(["type": .string("platform"), "call": .string("share.open")])
        let spec: [String: JSONValue] = [
            "root": .object(["type": .string("button"), "onTap": .array([share, paste, paste])]),
        ]
        XCTAssertEqual(PrototypeLibraryProvenance.sensitiveModules(spec), ["clipboard", "share"])
    }
}
