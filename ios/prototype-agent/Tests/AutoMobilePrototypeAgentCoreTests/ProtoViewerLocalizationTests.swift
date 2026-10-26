import Foundation
import XCTest

final class ProtoViewerLocalizationTests: XCTestCase {
    private var package: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
    }

    private func catalog(_ name: String) throws -> [String: Any] {
        let data = try Data(contentsOf: package.appendingPathComponent("ProtoViewer/\(name).xcstrings"))
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(root["sourceLanguage"] as? String, "en")
        XCTAssertEqual(root["version"] as? String, "1.0")
        return try XCTUnwrap(root["strings"] as? [String: Any])
    }

    private func placeholders(_ value: String) throws -> [String] {
        let regex = try NSRegularExpression(pattern: "%@|%lld")
        return regex.matches(in: value, range: NSRange(value.startIndex..., in: value)).map {
            String(value[Range($0.range, in: value)!]) // swiftlint:disable:this force_unwrapping
        }.sorted()
    }

    func testCatalogContracts() throws {
        for name in ["Localizable", "InfoPlist"] {
            let strings = try catalog(name)
            XCTAssertFalse(strings.isEmpty)
            for (key, raw) in strings {
                let entry = try XCTUnwrap(raw as? [String: Any])
                XCTAssertFalse(
                    try XCTUnwrap(entry["comment"] as? String)
                        .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                    key
                )
                let locales = try XCTUnwrap(entry["localizations"] as? [String: Any])
                let english = try XCTUnwrap(locales["en"] as? [String: Any])
                let units: [[String: Any]]
                if let variations = english["variations"] as? [String: Any] {
                    let plural = try XCTUnwrap(variations["plural"] as? [String: [String: Any]])
                    XCTAssertNotNil(plural["one"], key)
                    XCTAssertNotNil(plural["other"], key)
                    units = Array(plural.values)
                } else {
                    units = [english]
                }
                for unit in units {
                    let string = try XCTUnwrap(unit["stringUnit"] as? [String: String])
                    let value = try XCTUnwrap(string["value"])
                    XCTAssertFalse(value.isEmpty, key)
                    XCTAssertEqual(string["state"], "translated", key)
                    XCTAssertEqual(try placeholders(key), try placeholders(value), key)
                }
            }
        }
    }

    func testInfoPlistLocalizationMatchesFallbacks() throws {
        let data = try Data(contentsOf: package.appendingPathComponent("ProtoViewer/Info.plist"))
        let metadata = try XCTUnwrap(PropertyListSerialization.propertyList(
            from: data, options: [], format: nil
        ) as? [String: Any])
        XCTAssertEqual(metadata["CFBundleDevelopmentRegion"] as? String, "en")
        XCTAssertEqual(metadata["CFBundleLocalizations"] as? [String], ["en"])
        let strings = try catalog("InfoPlist")
        for key in ["CFBundleDisplayName", "NSLocalNetworkUsageDescription"] {
            let entry = try XCTUnwrap(strings[key] as? [String: Any])
            let locales = try XCTUnwrap(entry["localizations"] as? [String: Any])
            let english = try XCTUnwrap(locales["en"] as? [String: Any])
            let unit = try XCTUnwrap(english["stringUnit"] as? [String: String])
            XCTAssertEqual(unit["value"], metadata[key] as? String, key)
        }
    }

    func testChromeLiteralCoverage() throws {
        let strings = try catalog("Localizable")
        // Per-file EXEMPT list: independent licenses lane owns its text and catalog integration.
        // Remove this exemption when LicensesView's catalog entries land.
        let exempt = ["LicensesView.swift": "Concurrent licenses work has its own strings."]
        // Lint-style scan only: SwiftSyntax is not a dependency. This covers plain first
        // literal arguments, not arbitrary Swift expressions or prototype content.
        let calls =
            #"(?:Text|Button|Label|Toggle|ProgressView|navigationTitle|ContentUnavailableView|confirmationDialog|alert|accessibilityLabel)\s*\(\s*"((?:\\.|[^"\\])*)"|String\s*\(\s*localized:\s*"((?:\\.|[^"\\])*)""#
        let regex = try NSRegularExpression(pattern: calls)
        let interpolation = try NSRegularExpression(pattern: #"\\\(([^)]*)\)"#)
        for directory in ["ProtoViewer", "Viewer"] {
            let files = try FileManager.default.contentsOfDirectory(
                at: package.appendingPathComponent(directory), includingPropertiesForKeys: nil
            )
            for file in files where file.pathExtension == "swift" && exempt[file.lastPathComponent] == nil {
                let source = try String(contentsOf: file, encoding: .utf8)
                for match in regex.matches(in: source, range: NSRange(source.startIndex..., in: source)) {
                    let capture = match.range(at: match.range(at: 1).location == NSNotFound ? 2 : 1)
                    let range = try XCTUnwrap(Range(capture, in: source))
                    var key = String(source[range])
                    for item in interpolation.matches(in: key, range: NSRange(key.startIndex..., in: key)).reversed() {
                        let expression = try XCTUnwrap(Range(item.range(at: 1), in: key))
                        let integerExpressions = ["skippedCount", "version", "PrototypeSavedLayout.formatVersion"]
                        let replacement = integerExpressions.contains(String(key[expression])) ? "%lld" : "%@"
                        try key.replaceSubrange(XCTUnwrap(Range(item.range, in: key)), with: replacement)
                    }
                    key = key.replacingOccurrences(of: #"\n"#, with: "\n")
                        .replacingOccurrences(of: #"\""#, with: "\"")
                    XCTAssertNotNil(strings[key], "\(file.lastPathComponent): missing catalog entry for \(key)")
                }
            }
        }
    }
}
