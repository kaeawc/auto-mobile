import Foundation
import XCTest

final class RecoverySourceInvariantTests: XCTestCase {
    func testProcessSpawningIsMacOSOnly() throws {
        let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("XCTestRunner", isDirectory: true)
        let enumerator = try XCTUnwrap(FileManager.default.enumerator(
            at: sources, includingPropertiesForKeys: nil
        ))
        let files = try XCTUnwrap(enumerator.allObjects as? [URL]).filter { $0.pathExtension == "swift" }
        var processCalls = 0
        for file in files {
            let lines = try String(contentsOf: file, encoding: .utf8).components(separatedBy: .newlines)
            var macOSGuards: [Bool] = []
            for line in lines.map({ $0.trimmingCharacters(in: .whitespaces) }) {
                if line.hasPrefix("#if ") {
                    macOSGuards.append(line == "#if os(macOS)")
                } else if line.hasPrefix("#else"), !macOSGuards.isEmpty {
                    macOSGuards[macOSGuards.count - 1] = false
                } else if line == "#endif" {
                    _ = macOSGuards.popLast()
                }
                if line.contains("Process(") {
                    processCalls += 1
                    XCTAssertTrue(macOSGuards.contains(true), file.path)
                }
            }
        }
        XCTAssertGreaterThan(processCalls, 0, "The guard must inspect actual Process calls")
    }

    func testRootManifestAlsoMakesTachikomaMacOSOnly() throws {
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        while true {
            let manifestURL = directory.appendingPathComponent("Package.swift")
            var isDirectory: ObjCBool = false
            if FileManager.default.fileExists(
                atPath: directory.appendingPathComponent("ios").path, isDirectory: &isDirectory
            ), isDirectory.boolValue, FileManager.default.fileExists(atPath: manifestURL.path) {
                let manifest = try String(contentsOf: manifestURL, encoding: .utf8).filter { !$0.isWhitespace }
                XCTAssertTrue(manifest.contains(
                    #".product(name:"Tachikoma",package:"Tachikoma",condition:.when(platforms:[.macOS]))"#
                ), manifestURL.path)
                return
            }
            let parent = directory.deletingLastPathComponent()
            guard parent != directory else {
                throw XCTSkip("Repository root manifest is not present in this package checkout")
            }
            directory = parent
        }
    }

    func testTachikomaIsMacOSOnlyAndItsImportsAreGuarded() throws {
        let packageRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let manifest = try String(contentsOf: packageRoot.appendingPathComponent("Package.swift"), encoding: .utf8)
            .filter { !$0.isWhitespace }
        XCTAssertTrue(manifest.contains(
            #".product(name:"Tachikoma",package:"Tachikoma",condition:.when(platforms:[.macOS]))"#
        ))
        XCTAssertTrue(manifest.contains(".iOS(.v17)"))

        let enumerator = try XCTUnwrap(FileManager.default.enumerator(
            at: packageRoot.appendingPathComponent("Sources", isDirectory: true), includingPropertiesForKeys: nil
        ))
        let files = try XCTUnwrap(enumerator.allObjects as? [URL]).filter { $0.pathExtension == "swift" }
        var importingFiles = 0
        for file in files {
            let lines = try String(contentsOf: file, encoding: .utf8).components(separatedBy: .newlines)
                .map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            guard lines.contains("import Tachikoma") else { continue }
            importingFiles += 1
            // Importing files are wholly conditional, including declarations using Tachikoma types.
            XCTAssertEqual(lines.first, "#if canImport(Tachikoma)", file.path)
            XCTAssertEqual(lines.last, "#endif", file.path)
            XCTAssertEqual(lines.filter { $0.hasPrefix("#if ") }.count, 1, file.path)
            XCTAssertFalse(lines.contains { $0.hasPrefix("#else") }, file.path)
        }
        XCTAssertGreaterThan(importingFiles, 0, "The guard must inspect actual Tachikoma imports")
    }
}
