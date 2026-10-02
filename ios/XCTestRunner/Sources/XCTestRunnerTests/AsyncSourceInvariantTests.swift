import Foundation
import XCTest

final class AsyncSourceInvariantTests: XCTestCase {
    func testRunnerHasNoLegacySessionOrBlockingTransportState() throws {
        try assertRunnerSourcesExclude([
            "threadDictionary", "AutoMobileSession", "BlockingAsyncCall", "LegacyDaemonLineConnection",
        ])
    }

    func testTimingFetchAwaitedPathCannotRequireMainThread() throws {
        try assertRunnerSourcesExclude(["@MainActor", "MainActor.run", "DispatchQueue.main"])
    }

    func testScannerRejectsCodeAndIgnoresLineAndNestedBlockComments() {
        let forbidden = ["@MainActor", "MainActor.run", "DispatchQueue.main", "threadDictionary"]
        let comments = """
        /// @MainActor
        // MainActor.run
        /* DispatchQueue.main /* threadDictionary */ @MainActor */
        let value = 1 // threadDictionary
        """
        XCTAssertTrue(SourceInvariantScanner.occurrences(in: comments, forbidden: forbidden).isEmpty)
        for token in forbidden {
            XCTAssertEqual(
                SourceInvariantScanner.occurrences(in: "let value = \(token)", forbidden: forbidden),
                [token]
            )
        }
        // A URL string must not turn the rest of its line into a comment and hide code.
        XCTAssertEqual(
            SourceInvariantScanner.occurrences(
                in: #"let url = "http://unused"; MainActor.run {}"#, forbidden: forbidden
            ), ["MainActor.run"]
        )
    }

    private func assertRunnerSourcesExclude(_ forbidden: [String]) throws {
        let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("XCTestRunner", isDirectory: true)
        let enumerator = try XCTUnwrap(FileManager.default.enumerator(
            at: sources, includingPropertiesForKeys: nil
        ))
        let files = try XCTUnwrap(enumerator.allObjects as? [URL]).filter { $0.pathExtension == "swift" }
        XCTAssertFalse(files.isEmpty, "The guard must scan the production runner, never an empty directory")
        for file in files {
            let source = try String(contentsOf: file, encoding: .utf8)
            XCTAssertEqual(
                SourceInvariantScanner.occurrences(in: source, forbidden: forbidden), [], file.path
            )
        }
    }
}

/// A grep-style guard, retaining strings and code while ignoring Swift line and nested block
/// comments. Quoted strings preserve URL slashes; escaped quotes do not end a string.
private enum SourceInvariantScanner {
    static func occurrences(in source: String, forbidden: [String]) -> [String] {
        // Most files have no candidate token; avoid lexing those so the package-wide guard stays fast.
        guard forbidden.contains(where: { source.contains($0) }) else { return [] }
        let code = withoutComments(source)
        return forbidden.filter { code.contains($0) }
    }

    private static func withoutComments(_ source: String) -> String {
        let characters = Array(source)
        var code = ""
        var index = 0
        var blockDepth = 0
        var lineComment = false
        var quoted = false
        while index < characters.count {
            let character = characters[index]
            let next: Character? = index + 1 < characters.count ? characters[index + 1] : nil
            if lineComment {
                if character == "\n" {
                    lineComment = false
                    code.append(character)
                }
            } else if blockDepth > 0 {
                if character == "/", next == "*" {
                    blockDepth += 1
                    index += 1
                } else if character == "*", next == "/" {
                    blockDepth -= 1
                    index += 1
                    if blockDepth == 0 { code.append(" ") }
                }
            } else if quoted {
                code.append(character)
                if character == "\\", let next {
                    code.append(next)
                    index += 1
                } else if character == "\"" {
                    quoted = false
                }
            } else if character == "/", next == "/" {
                lineComment = true
                index += 1
            } else if character == "/", next == "*" {
                blockDepth = 1
                index += 1
            } else {
                code.append(character)
                if character == "\"" { quoted = true }
            }
            index += 1
        }
        return code
    }
}
