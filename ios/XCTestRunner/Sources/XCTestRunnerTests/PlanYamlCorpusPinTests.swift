import Foundation
import XCTest
@testable import XCTestRunner
import Yams

/// Issue #11889: pin metadata and scalar semantics against the original scanner corpus.
/// Driver capture (run before the ordinary assertion run):
/// PLAN_CORPUS_CAPTURE_PATH="$PWD/Sources/XCTestRunnerTests/Resources/PlanCorpus/golden.json" \
///   swift test --filter PlanYamlCorpusPinTests
/// Rebuild/rerun without the variable so Bundle.module contains the captured golden.
final class PlanYamlCorpusPinTests: XCTestCase {
    private struct Outcome<Value: Codable & Equatable & Sendable>: Codable, Equatable, Sendable {
        let value: Value?
        let error: String?

        init(_ operation: () throws -> Value) {
            do {
                value = try operation()
                error = nil
            } catch {
                value = nil
                self.error = String(describing: error)
            }
        }
    }

    private struct Metadata: Codable, Equatable, Sendable {
        let platform: String?
        let devicePlatforms: [String: String]
        let deviceLabels: [String]
        let hasDevices: Bool

        init(_ parsed: PlanMetadata) {
            platform = parsed.platform?.rawValue
            devicePlatforms = parsed.devicePlatforms.mapValues(\.rawValue)
            deviceLabels = parsed.deviceLabels
            hasDevices = parsed.hasDevices
        }
    }

    private struct Substitution: Codable, Equatable, Sendable {
        let parameters: [String: String]
        let output: Outcome<String>
    }

    private struct Golden: Codable, Sendable {
        let metadata: Outcome<Metadata>
        let secretParameterKeys: [String]
        let toolNames: [String]
        let substitutions: [String: Substitution]
    }

    private struct Corpus: Sendable {
        let actual: [String: Golden]
        let expected: [String: Golden]
        let semanticSubstitutions: [String: [String: Bool]]
    }

    private static let capturePath = ProcessInfo.processInfo.environment["PLAN_CORPUS_CAPTURE_PATH"]

    // One immutable Sendable snapshot, initialized in class setup (outside timed test bodies).
    // This loads each resource and compares parsed substitution trees once; the table-driven assertions
    // below only compare values, keeping their bodies within the 15 ms budget.
    private static let corpus: Result<Corpus, Error> = Result { try loadCorpus() }

    override static func setUp() {
        super.setUp()
        _ = corpus
    }

    func testCaptureGoldens() throws {
        guard let path = Self.capturePath else {
            throw XCTSkip("Set PLAN_CORPUS_CAPTURE_PATH to capture current scanner outputs.")
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        var data = try encoder.encode(Self.corpus.get().actual)
        data.append(0x0A)
        try data.write(to: URL(fileURLWithPath: path), options: .atomic)
    }

    func testGoldenCoversEveryCorpusPlan() throws {
        let corpus = try assertionCorpus()
        XCTAssertFalse(corpus.actual.isEmpty, "No bundled corpus plans were found.")
        XCTAssertEqual(Set(corpus.expected.keys), Set(corpus.actual.keys))
    }

    func testMetadataMatchesGoldens() throws {
        let corpus = try assertionCorpus()
        for name in corpus.actual.keys.sorted() {
            let actual = try XCTUnwrap(corpus.actual[name])
            let expected = try XCTUnwrap(corpus.expected[name], "Missing golden: \(name)")
            XCTAssertEqual(actual.metadata, expected.metadata, name)
        }
    }

    func testSecretParameterKeysMatchGoldens() throws {
        let corpus = try assertionCorpus()
        for name in corpus.actual.keys.sorted() {
            let actual = try XCTUnwrap(corpus.actual[name])
            let expected = try XCTUnwrap(corpus.expected[name], "Missing golden: \(name)")
            XCTAssertEqual(actual.secretParameterKeys, expected.secretParameterKeys, name)
        }
    }

    func testStepToolNamesMatchGoldens() throws {
        let corpus = try assertionCorpus()
        for name in corpus.actual.keys.sorted() {
            let actual = try XCTUnwrap(corpus.actual[name])
            let expected = try XCTUnwrap(corpus.expected[name], "Missing golden: \(name)")
            XCTAssertEqual(actual.toolNames, expected.toolNames, name)
        }
    }

    func testSubstitutionSemanticsMatchGoldens() throws {
        let corpus = try assertionCorpus()
        for name in corpus.actual.keys.sorted() {
            let actual = try XCTUnwrap(corpus.actual[name])
            let expected = try XCTUnwrap(corpus.expected[name], "Missing golden: \(name)")
            XCTAssertEqual(Set(actual.substitutions.keys), Set(expected.substitutions.keys), name)
            for label in expected.substitutions.keys.sorted() {
                let new = try XCTUnwrap(actual.substitutions[label])
                let old = try XCTUnwrap(expected.substitutions[label])
                XCTAssertEqual(new.parameters, old.parameters, "\(name): \(label)")
                XCTAssertEqual(new.output.error, old.output.error, "\(name): \(label)")
                XCTAssertEqual(corpus.semanticSubstitutions[name]?[label], true, "\(name): \(label)")
            }
        }
    }

    private func assertionCorpus() throws -> Corpus {
        if Self.capturePath != nil {
            throw XCTSkip("Capture mode: run again without PLAN_CORPUS_CAPTURE_PATH to assert goldens.")
        }
        return try Self.corpus.get()
    }

    private static func loadCorpus() throws -> Corpus {
        // SwiftPM .process("Resources") flattens these YAML resources into the bundle root.
        // Enumerate instead of maintaining a filename list: a new PlanCorpus fixture MUST require
        // a golden. The two existing Plans/*.yaml resources participate without being copied.
        let urls = try XCTUnwrap(Bundle.module.urls(forResourcesWithExtension: "yaml", subdirectory: nil))
        guard !urls.isEmpty else { throw CorpusError.noBundledPlans }
        let placeholder = try NSRegularExpression(pattern: #"\$\{([^{}]+)\}"#)
        var actual: [String: Golden] = [:]
        for url in urls.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            let name = url.lastPathComponent
            guard actual[name] == nil else {
                throw CorpusError.duplicateResource(name)
            }
            let yaml = try String(contentsOf: url, encoding: .utf8)
            // This regex only inventories literal placeholder tokens; it never parses YAML.
            let keys = Set(placeholder.matches(in: yaml, range: NSRange(yaml.startIndex..., in: yaml)).compactMap {
                Range($0.range(at: 1), in: yaml).map { String(yaml[$0]) }
            }).sorted()
            let parameters = Dictionary(uniqueKeysWithValues: keys.map { ($0, "corpus-\($0)") })
            var substitutions = ["deterministic": substitute(yaml, parameters: parameters)]
            // Apply EACH tricky value to EVERY placeholder, including plans with only one key.
            // Rotating values among keys would silently miss cases on most of this real corpus.
            let trickyValues = [
                ("hash", "shoes #1"), ("colon", "a: b"), ("quote-newline", "say \"hi\"\n"),
                ("apostrophe", "it's"), ("numeric", "500"), ("boolean", "true"),
            ]
            for (label, value) in trickyValues {
                substitutions[label] = substitute(
                    yaml, parameters: Dictionary(uniqueKeysWithValues: keys.map { ($0, value) })
                )
            }
            actual[name] = Golden(
                metadata: Outcome { try Metadata(PlanMetadataParser.parse(from: yaml)) },
                secretParameterKeys: PlanMetadataParser.parseSecretParameterKeys(from: yaml).sorted(),
                toolNames: PlanStepToolParser.toolNames(from: yaml),
                substitutions: substitutions
            )
        }
        let expected: [String: Golden]
        if capturePath == nil {
            let url = try XCTUnwrap(Bundle.module.url(forResource: "golden", withExtension: "json"))
            expected = try JSONDecoder().decode([String: Golden].self, from: Data(contentsOf: url))
        } else {
            expected = [:]
        }
        // Yams nodes contain mutable reference tags and are not Sendable. Compare them locally
        // during setup and store only Sendable results; timed tests never parse the corpus again.
        var semanticSubstitutions: [String: [String: Bool]] = [:]
        for (name, golden) in expected {
            var results: [String: Bool] = [:]
            for (label, substitution) in golden.substitutions {
                let new = actual[name]?.substitutions[label]?.output
                if let oldText = substitution.output.value, let newText = new?.value {
                    results[label] = try Yams.compose(yaml: newText) == Yams.compose(yaml: oldText)
                } else {
                    results[label] = new?.error == substitution.output.error
                }
            }
            semanticSubstitutions[name] = results
        }
        return Corpus(actual: actual, expected: expected, semanticSubstitutions: semanticSubstitutions)
    }

    private static func substitute(_ yaml: String, parameters: [String: String]) -> Substitution {
        Substitution(parameters: parameters, output: Outcome {
            try PlanParameterSubstitutor.substitute(in: yaml, parameters: parameters)
        })
    }

    private enum CorpusError: Error {
        case duplicateResource(String)
        case noBundledPlans
    }
}
