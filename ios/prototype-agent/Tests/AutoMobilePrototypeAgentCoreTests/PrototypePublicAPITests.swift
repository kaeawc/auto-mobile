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

    /// What an open brace belongs to. Members of a public enum, protocol or extension are public
    /// without carrying the modifier, so the scanner has to know which scope it is inside.
    private enum Scope {
        case publicEnum(String)
        case publicProtocol(String)
        case publicExtension(String)
        case other

        var owner: String? {
            switch self {
            case let .publicEnum(name), let .publicProtocol(name), let .publicExtension(name): name
            case .other: nil
            }
        }
    }

    private static let explicitPattern = #"^(@[A-Za-z]+(\([^)]*\))? +)*(public|open) "#
    private static let attributes = #"(@[A-Za-z]+(\([^)]*\))? +)*"#
    private static let enumCase = "^" + attributes + #"(indirect +)?case "#
    private static let member = "^" + attributes
        + #"((static|class|mutating|nonmutating|final|convenience|required|override) +)*"#
        + #"(func|var|let|init|subscript|typealias|associatedtype|struct|class|enum|actor|protocol)\b"#
    private static let continuation = #"^(->|throws\b|rethrows\b|async\b|where\b)"#

    private static func matches(_ line: String, _ pattern: String) -> Bool {
        line.range(of: pattern, options: .regularExpression) != nil
    }

    /// The scope a declaration opens, from its (explicitly public) text.
    private static func scope(opened declaration: String) -> Scope {
        for (keyword, make) in [
            ("enum", Scope.publicEnum), ("protocol", Scope.publicProtocol), ("extension", Scope.publicExtension),
        ] {
            let pattern = #"\b"# + keyword + #" +([A-Za-z_][A-Za-z0-9_.]*)"#
            if let range = declaration.range(of: pattern, options: .regularExpression) {
                let text = declaration[range].dropFirst(keyword.count).trimmingCharacters(in: .whitespaces)
                return make(text)
            }
        }
        return .other
    }

    /// Whether a line outside a pending declaration starts a public member by virtue of its scope.
    private static func isImplicitMember(_ line: String, in scope: Scope?) -> Bool {
        switch scope {
        case .publicEnum: matches(line, enumCase)
        case .publicProtocol, .publicExtension: matches(line, member)
        case .other, nil: false
        }
    }

    /// Net `{` minus `}` of a line, ignoring string literals and trailing comments.
    private static func braceDelta(_ text: String) -> Int {
        var code = text.replacingOccurrences(of: #""([^"\\]|\\.)*""#, with: "\"\"", options: .regularExpression)
        if let comment = code.range(of: "//") { code = String(code[..<comment.lowerBound]) }
        return code.filter { $0 == "{" }.count - code.filter { $0 == "}" }.count
    }

    static func declarations(in source: String, file: String) -> [String] {
        let lines = source.split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
        var result: [String] = []
        var scopes: [Scope] = []
        var index = 0
        var inBlockComment = false
        while index < lines.count {
            var line = lines[index]
            index += 1
            if inBlockComment {
                if line.contains("*/") { inBlockComment = false }
                continue
            }
            if line.hasPrefix("//") { continue }
            if line.hasPrefix("/*") {
                inBlockComment = !line.contains("*/")
                continue
            }
            let explicit = matches(line, explicitPattern)
            guard explicit || isImplicitMember(line, in: scopes.last) else {
                apply(braceDelta(line), opening: .other, to: &scopes)
                continue
            }
            // Join the parameter list, then any return type or effects on the following lines.
            var depth = line.filter { $0 == "(" }.count - line.filter { $0 == ")" }.count
            while depth > 0, index < lines.count {
                line += " " + lines[index]
                depth += lines[index].filter { $0 == "(" }.count - lines[index].filter { $0 == ")" }.count
                index += 1
            }
            while index < lines.count, matches(lines[index], continuation) {
                line += " " + lines[index]
                index += 1
            }
            let owner = scopes.last?.owner
            let text = normalize(line)
            result.append(explicit || owner == nil ? "\(file): \(text)" : "\(file): [\(owner ?? "")] \(text)")
            apply(braceDelta(line), opening: explicit ? scope(opened: line) : .other, to: &scopes)
        }
        return result
    }

    private static func apply(_ delta: Int, opening scope: Scope, to scopes: inout [Scope]) {
        if delta > 0 {
            scopes.append(contentsOf: Array(repeating: .other, count: delta - 1) + [scope])
        } else if delta < 0 {
            scopes.removeLast(min(-delta, scopes.count))
        }
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

    func testScannerCapturesReturnTypesAfterMultilineParameterLists() {
        let source = """
        public enum Net {
            public static func configuration(
                a: Int
            ) -> Config {
                Config()
            }
        }
        """
        XCTAssertEqual(Self.declarations(in: source, file: "F.swift"), [
            "F.swift: public enum Net",
            "F.swift: public static func configuration(a: Int) -> Config",
        ])
    }

    func testScannerIncludesImplicitlyPublicMembers() {
        let source = """
        public enum Storage {
            case memory
            indirect case directory(URL)
            private func hidden() {}
            case other
        }
        public protocol Store {
            func bool(forKey key: String) -> Bool
            var flag: Bool { get set }
        }
        public extension Storage {
            static func make() -> Storage { .memory }
            private func nope() {}
        }
        enum Internal {
            case skipped
        }
        public struct Holder {
            enum Inner { case skipped }
            public func run() { let x = [1].map { $0 } }
            func plain() {}
        }
        """
        XCTAssertEqual(Self.declarations(in: source, file: "F.swift"), [
            "F.swift: public enum Storage",
            "F.swift: [Storage] case memory",
            "F.swift: [Storage] indirect case directory(URL)",
            "F.swift: [Storage] case other",
            "F.swift: public protocol Store",
            "F.swift: [Store] func bool(forKey key: String) -> Bool",
            "F.swift: [Store] var flag: Bool",
            "F.swift: public extension Storage",
            "F.swift: [Storage] static func make() -> Storage",
            "F.swift: public struct Holder",
            "F.swift: public func run()",
        ])
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
