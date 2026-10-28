import Darwin
@testable import ScreenCaptureCore
import XCTest

final class BufferSink: FrameSink {
    var data = Data()
    func write(_ chunk: Data) { data.append(chunk) }
}

final class BlockingPayloadSink: FrameSink {
    private let lock = NSLock()
    private var writeCount = 0
    private let firstPayloadStarted = DispatchSemaphore(value: 0)
    private let allowFirstPayload = DispatchSemaphore(value: 0)
    private(set) var writes: [Data] = []
    private var writtenPayloads: [Data] = []

    func write(_ chunk: Data) {
        lock.lock()
        writes.append(chunk)
        writeCount += 1
        if writeCount.isMultiple(of: 2) {
            writtenPayloads.append(chunk)
        }
        let shouldBlock = writeCount == 2
        lock.unlock()

        if shouldBlock {
            firstPayloadStarted.signal()
            _ = allowFirstPayload.wait(timeout: .now() + 1)
        }
    }

    func waitForFirstPayload() -> Bool {
        firstPayloadStarted.wait(timeout: .now() + 1) == .success
    }

    func allowOutput() {
        allowFirstPayload.signal()
    }

    func payloads() -> [Data] {
        lock.lock()
        defer { lock.unlock() }
        return writtenPayloads
    }
}

final class FrameWriterTests: XCTestCase {
    func testClosedOutputNotifiesOnceWithoutTrapping() {
        // The helper executable ignores SIGPIPE so a closed reader reaches the
        // sink's EPIPE handling. Restore the test process's prior disposition.
        let previousSignalHandler = signal(SIGPIPE, SIG_IGN)
        defer { _ = signal(SIGPIPE, previousSignalHandler) }
        var descriptors: [Int32] = [0, 0]
        guard pipe(&descriptors) == 0 else {
            XCTFail("pipe creation failed")
            return
        }
        defer { _ = close(descriptors[1]) }
        _ = close(descriptors[0])

        let closed = DispatchSemaphore(value: 0)
        let sink = FileHandleFrameSink(
            handle: FileHandle(fileDescriptor: descriptors[1], closeOnDealloc: false)
        ) {
            closed.signal()
        }
        sink.write(Data([1]))
        XCTAssertEqual(errno, EPIPE)
        sink.write(Data([2]))

        XCTAssertEqual(closed.wait(timeout: .now()), .success)
        XCTAssertEqual(closed.wait(timeout: .now()), .timedOut)
    }

    func testHelperHelpSurvivesClosedStdoutPipe() throws {
        let helperURL = Bundle(for: Self.self).bundleURL
            .deletingLastPathComponent()
            .appendingPathComponent("screen-capture-helper")
        let output = Pipe()
        output.fileHandleForReading.closeFile()
        let helper = Process()
        helper.executableURL = helperURL
        helper.arguments = ["--help"]
        helper.standardOutput = output

        try helper.run()
        helper.waitUntilExit()
        XCTAssertEqual(helper.terminationReason, .exit)
        XCTAssertEqual(helper.terminationStatus, 0)
    }

    /// The helper writes capability markers (and, while capturing, a frame-metrics
    /// line every second) to stderr. A closed stderr reader must not terminate it:
    /// `FileHandle.write(_:)` raised there and killed a live capture with SIGTRAP (#7604).
    func testHelperHelpSurvivesClosedStderrPipe() throws {
        let helperURL = Bundle(for: Self.self).bundleURL
            .deletingLastPathComponent()
            .appendingPathComponent("screen-capture-helper")
        let diagnostics = Pipe()
        diagnostics.fileHandleForReading.closeFile()
        let helper = Process()
        helper.executableURL = helperURL
        helper.arguments = ["--help"]
        helper.standardOutput = FileHandle.nullDevice
        helper.standardError = diagnostics

        try helper.run()
        helper.waitUntilExit()
        XCTAssertEqual(helper.terminationReason, .exit)
        XCTAssertEqual(helper.terminationStatus, 0)
    }

    /// List modes write their JSON to stdout. A closed stdout reader must end the helper
    /// with a clean non-zero exit, not an uncatchable `FileHandle.write` exception.
    func testHelperListDevicesExitsCleanlyOnClosedStdoutPipe() throws {
        let helperURL = Bundle(for: Self.self).bundleURL
            .deletingLastPathComponent()
            .appendingPathComponent("screen-capture-helper")
        let output = Pipe()
        output.fileHandleForReading.closeFile()
        let helper = Process()
        helper.executableURL = helperURL
        helper.arguments = ["--list-devices"]
        helper.standardOutput = output
        helper.standardError = FileHandle.nullDevice

        try helper.run()
        helper.waitUntilExit()
        XCTAssertEqual(helper.terminationReason, .exit)
        XCTAssertEqual(helper.terminationStatus, 1)
    }

    func testRecordsEncoderDroppedFrameInMetrics() {
        let writer = FrameWriter(sink: BufferSink())

        writer.recordEncoderDroppedFrame()

        XCTAssertEqual(writer.metrics().droppedFrames, 1)
    }

    func testSlowSinkDiscardsEmptyAudioRecords() throws {
        let sink = BlockingPayloadSink()
        let writer = FrameWriter(sink: sink)
        let first = Data([0x11, 0x11, 0x11, 0x11])

        XCTAssertTrue(writer.writeEncoded(header: Data([0x01]), payload: first))
        XCTAssertTrue(sink.waitForFirstPayload())

        for _ in 0 ..< 10 {
            writer.writeAudio(pcm16le: Data())
        }

        sink.allowOutput()
        writer.flush()

        XCTAssertEqual(sink.payloads(), [first])
        XCTAssertEqual(writer.metrics().bytesQueued, 0)
    }
}
