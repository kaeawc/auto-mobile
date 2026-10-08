import Darwin
import Foundation
@testable import ScreenCaptureCore
import XCTest

/// `DescriptorWrite` replaces `FileHandle.write(_:)`, which raises an uncatchable
/// Objective-C exception on a closed descriptor and terminated the helper with
/// SIGTRAP mid-stream when its stderr reader went away (#7604).
final class DescriptorWriteTests: XCTestCase {
    private func makePipe() throws -> (read: Int32, write: Int32) {
        var descriptors: [Int32] = [0, 0]
        guard pipe(&descriptors) == 0 else {
            throw XCTSkip("pipe creation failed")
        }
        return (descriptors[0], descriptors[1])
    }

    func testWriteAllDeliversEveryByte() throws {
        let (readEnd, writeEnd) = try makePipe()
        defer {
            _ = close(readEnd)
            _ = close(writeEnd)
        }
        let payload = Data("automobile-frame-metrics:{}\n".utf8)

        XCTAssertTrue(DescriptorWrite.writeAll(payload, toFileDescriptor: writeEnd))

        var buffer = [UInt8](repeating: 0, count: payload.count)
        XCTAssertEqual(read(readEnd, &buffer, buffer.count), payload.count)
        XCTAssertEqual(Data(buffer), payload)
    }

    func testWriteAllOfEmptyDataSucceedsWithoutWriting() {
        XCTAssertTrue(DescriptorWrite.writeAll(Data(), toFileDescriptor: -1))
    }

    func testWriteAllReportsClosedReaderInsteadOfTrapping() throws {
        // The helper ignores SIGPIPE in main.swift; mirror that so the write
        // reaches the EPIPE path. Restore the test process's prior disposition.
        let previousSignalHandler = signal(SIGPIPE, SIG_IGN)
        defer { _ = signal(SIGPIPE, previousSignalHandler) }
        let (readEnd, writeEnd) = try makePipe()
        defer { _ = close(writeEnd) }
        _ = close(readEnd)

        XCTAssertFalse(DescriptorWrite.writeAll(Data([1]), toFileDescriptor: writeEnd))
        XCTAssertEqual(errno, EPIPE)
    }

    func testWriteAllReportsClosedDescriptorInsteadOfTrapping() throws {
        let (readEnd, writeEnd) = try makePipe()
        _ = close(readEnd)
        _ = close(writeEnd)

        XCTAssertFalse(DescriptorWrite.writeAll(Data([1]), toFileDescriptor: writeEnd))
        XCTAssertEqual(errno, EBADF)
    }

    func testWriteDiagnosticDropsTextWhenReaderIsGone() throws {
        let previousSignalHandler = signal(SIGPIPE, SIG_IGN)
        defer { _ = signal(SIGPIPE, previousSignalHandler) }
        let (readEnd, writeEnd) = try makePipe()
        defer { _ = close(writeEnd) }
        _ = close(readEnd)

        // Reaching the next line is the assertion: the old FileHandle path raised here.
        DescriptorWrite.writeDiagnostic("error: ScreenCaptureKit stream stopped\n", toFileDescriptor: writeEnd)
        XCTAssertEqual(errno, EPIPE)
    }
}
