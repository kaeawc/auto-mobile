import Foundation
import XCTest

/// Guards the embedding API surface that the `AutoMobilePrototype` library product exposes (#13726).
/// The renderer keeps everything else `internal`, so any new `public` declaration, or a changed
/// signature, must be a deliberate edit of `api/AutoMobilePrototype.api`. Regenerate the baseline
/// with `UPDATE_PROTOTYPE_API=1 swift test --filter PrototypePublicAPITests`.
final class PrototypePublicAPITests: XCTestCase {
    private var packageRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private var baselineURL: URL { packageRoot.appendingPathComponent("api/AutoMobilePrototype.api") }

    /// One normalized line per `public`/`open` declaration, with multi-line signatures joined.
    private func publicDeclarations() throws -> [String] {
        let sources = packageRoot.appendingPathComponent("Sources")
        let enumerator = try XCTUnwrap(FileManager.default.enumerator(
            at: sources, includingPropertiesForKeys: nil
        ))
        var result: [String] = []
        for case let file as URL in enumerator where file.pathExtension == "swift" {
            let relative = String(file.path.dropFirst(sources.path.count + 1))
            result += try Self.declarations(in: String(contentsOf: file, encoding: .utf8), file: relative)
        }
        return result.sorted()
    }

    static func declarations(in source: String, file: String) -> [String] {
        let pattern = #"^(@[A-Za-z]+(\([^)]*\))? +)*(public|open) "#
        var result: [String] = []
        var pending: String?
        var depth = 0
        for raw in source.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if pending == nil {
                guard line.range(of: pattern, options: .regularExpression) != nil else { continue }
                pending = line
                depth = 0
            } else {
                pending = (pending ?? "") + " " + line
            }
            depth += line.filter { $0 == "(" }.count - line.filter { $0 == ")" }.count
            if depth <= 0, let done = pending {
                result.append("\(file): \(normalize(done))")
                pending = nil
            }
        }
        return result
    }

    private static func normalize(_ declaration: String) -> String {
        var text = declaration
        if let comment = text.range(of: " //") { text = String(text[..<comment.lowerBound]) }
        text = text.replacingOccurrences(of: #"\(\s+"#, with: "(", options: .regularExpression)
        text = text.replacingOccurrences(of: #"\s+\)"#, with: ")", options: .regularExpression)
        // A closure default value (`= { _ in }`) is part of the signature; a body is not.
        text = text.replacingOccurrences(of: "= {", with: "= \u{1}")
        text = text.replacingOccurrences(of: #"\s*\{.*$"#, with: "", options: .regularExpression)
        return text.replacingOccurrences(of: "\u{1}", with: "{").trimmingCharacters(in: .whitespaces)
    }

    func testPublicSurfaceMatchesCheckedInBaseline() throws {
        let actual = try publicDeclarations().joined(separator: "\n") + "\n"
        if ProcessInfo.processInfo.environment["UPDATE_PROTOTYPE_API"] == "1" {
            try FileManager.default.createDirectory(
                at: baselineURL.deletingLastPathComponent(), withIntermediateDirectories: true
            )
            try actual.write(to: baselineURL, atomically: true, encoding: .utf8)
        }
        let expected = try String(contentsOf: baselineURL, encoding: .utf8)
        XCTAssertEqual(
            actual, expected,
            "Public API changed. If intended, regenerate api/AutoMobilePrototype.api (see this test's header)."
        )
    }

    func testEmbeddingEntryPointsAreInTheBaseline() throws {
        let baseline = try String(contentsOf: baselineURL, encoding: .utf8)
        for name in [
            "public struct AutoMobilePrototypeView: View", "public struct PrototypeAssets",
            "public enum PrototypeStorageOption", "public struct PrototypeNetworkConfiguration",
            "public struct PrototypeEvent", "public enum PrototypeDismissReason", "public enum PrototypeLoadError",
        ] {
            XCTAssertTrue(baseline.contains(name), "Missing embedding type: \(name)")
        }
    }

    func testDeclarationScannerJoinsMultilineSignaturesAndIgnoresInternal() {
        let source = """
        struct Hidden { public var x = 1 }
        internal func skip() {}
        public struct Shown {
            public init(
                a: Int,
                b: String = ""
            ) {}
            @MainActor public func run() // note
            private func inner() {}
        }
        """
        XCTAssertEqual(Self.declarations(in: source, file: "F.swift"), [
            "F.swift: public struct Shown",
            "F.swift: public init(a: Int, b: String = \"\")",
            "F.swift: @MainActor public func run()",
        ])
    }
}
