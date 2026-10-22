@testable import AutoMobilePrototypeAgentCore
import Darwin
import Foundation
import os
import XCTest

final class PrototypeLibraryFileReaderTests: XCTestCase {
    func testRejectsOversizedFileFromSizeBeforeReadingAnything() {
        let input = FakeInput(size: PrototypeBundle.maxCompressedBytes + 1, prefix: Data())
        XCTAssertThrowsError(try PrototypeLibraryFileReader().read(input))
        XCTAssertEqual(input.readBytes, 0)
    }

    func testSniffsFormatBeforeReadingOversizedBareJSON() {
        let input = FakeInput(size: PrototypeBundle.maxSpecBytes + 1, prefix: Data("{\"id".utf8))
        XCTAssertThrowsError(try PrototypeLibraryFileReader().read(input))
        XCTAssertEqual(input.readBytes, 4)
    }

    func testBoundsUnknownOrGrowingInputToCapPlusOne() {
        for size in [nil, PrototypeBundle.maxSpecBytes - 1] {
            let input = FakeInput(size: size, prefix: Data("{\"id".utf8))
            XCTAssertThrowsError(try PrototypeLibraryFileReader().read(input))
            XCTAssertEqual(input.readBytes, PrototypeBundle.maxSpecBytes + 1)
            XCTAssertLessThanOrEqual(input.largestRead, 65536)
        }
    }

    func testZIPReceivesLargerBudgetAndShortReadsAreAccumulated() throws {
        let input = FakeInput(size: nil, prefix: Data([80, 75, 3, 4]))
        input.limit = PrototypeBundle.maxSpecBytes + 1
        input.shortRead = 3
        let bytes = try PrototypeLibraryFileReader().read(input)
        XCTAssertEqual(bytes.count, PrototypeBundle.maxSpecBytes + 1)
        XCTAssertTrue(PrototypeLibraryImporter.isZIP(bytes))
    }

    func testRejectsRemoteURLsWithoutReading() throws {
        let url = try XCTUnwrap(URL(string: "https://example.test/spec.json"))
        XCTAssertThrowsError(try PrototypeLibraryFileReader().read(url))
    }

    func testDiskReaderRejectsSymlinksDirectoriesAndFIFOWithoutBlocking() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("spec.json")
        try Data("{}".utf8).write(to: file)
        let alias = directory.appendingPathComponent("alias.json")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: file)
        let fifo = directory.appendingPathComponent("pipe")
        XCTAssertEqual(mkfifo(fifo.path, 0o600), 0)
        let reader = PrototypeLibraryFileReader()
        XCTAssertEqual(try reader.read(file), Data("{}".utf8))
        for url in [alias, directory, fifo] {
            XCTAssertThrowsError(try reader.read(url))
        }
    }

    func testOpenedDescriptorSurvivesPathReplacementAndUsesItsOwnSize() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("spec.json")
        let original = Data("{}".utf8)
        try original.write(to: path)
        let input = try PrototypeLibraryReadDiskFileSystem().openRegularFile(path)
        defer { try? input.close() }
        try FileManager.default.removeItem(at: path)
        try Data(repeating: 0, count: 8).write(to: path)
        XCTAssertEqual(input.byteCount, original.count)
        XCTAssertEqual(try PrototypeLibraryFileReader().read(input), original)
    }

    func testDiskReaderRejectsOversizedDescriptorBeforeReadingSparseContents() throws {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        XCTAssertTrue(FileManager.default.createFile(atPath: path.path, contents: nil))
        addTeardownBlock { try FileManager.default.removeItem(at: path) }
        let handle = try FileHandle(forWritingTo: path)
        try handle.truncate(atOffset: UInt64(PrototypeBundle.maxCompressedBytes + 1))
        try handle.close()
        XCTAssertThrowsError(try PrototypeLibraryFileReader().read(path)) {
            XCTAssertEqual(
                $0 as? PrototypeLibraryImportFailure,
                .invalid(path: "$", message: "Import byte cap exceeded")
            )
        }
    }

    func testInjectedOpenInputIsClosedAfterReadFailureAndSuccess() throws {
        for fails in [true, false] {
            let closed = OSAllocatedUnfairLock(initialState: false)
            let reader = PrototypeLibraryFileReader(files: FakeReadFileSystem(fails: fails, closed: closed))
            if fails {
                XCTAssertThrowsError(try reader.read(URL(fileURLWithPath: "/input")))
            } else {
                XCTAssertEqual(try reader.read(URL(fileURLWithPath: "/input")), Data())
            }
            XCTAssertTrue(closed.withLock { $0 })
        }
    }

    private struct FakeReadFileSystem: PrototypeLibraryReadFileSystem {
        let fails: Bool
        let closed: OSAllocatedUnfairLock<Bool>
        func openRegularFile(_: URL) throws -> any PrototypeLibraryInput {
            Input(fails: fails, closed: closed)
        }

        private struct Input: PrototypeLibraryInput {
            let fails: Bool
            let closed: OSAllocatedUnfairLock<Bool>
            var byteCount: Int? { 0 }
            func read(upToCount _: Int) throws -> Data {
                if fails { throw POSIXError(.EIO) }
                return Data()
            }

            func close() throws { closed.withLock { $0 = true } }
        }
    }

    private final class FakeInput: PrototypeLibraryInput {
        let byteCount: Int?
        let prefix: Data
        var readBytes = 0
        var largestRead = 0
        var limit = PrototypeBundle.maxCompressedBytes + 1
        var shortRead = Int.max
        init(size: Int?, prefix: Data) {
            byteCount = size
            self.prefix = prefix
        }

        func read(upToCount count: Int) throws -> Data {
            largestRead = max(largestRead, count)
            let count = min(count, readBytes < 4 ? shortRead : Int.max, limit - readBytes)
            var bytes = Data(repeating: 0, count: count)
            let prefixCount = min(count, max(0, prefix.count - readBytes))
            for index in 0 ..< prefixCount {
                bytes[index] = prefix[readBytes + index]
            }
            readBytes += count
            return bytes
        }
    }
}
