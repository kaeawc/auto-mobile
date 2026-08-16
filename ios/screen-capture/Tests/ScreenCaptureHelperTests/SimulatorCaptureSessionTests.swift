import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit
import XCTest
@testable import ScreenCaptureCore
@testable import ScreenCaptureHelper

/// Deterministic coverage for `SimulatorCaptureSession`'s lifecycle paths.
///
/// These tests drive the session through its injected `CaptureStream` seam and
/// diagnostic sink, so none of them require a real Simulator window, a live
/// `SCStream`, or Screen Recording permission (issue #4771). They exercise the
/// four behaviors called out on the issue: start/stop wiring, fatal-error
/// handling, reconfigure success/failure, and once-only first-frame signalling.
final class SimulatorCaptureSessionTests: XCTestCase {

    // MARK: - Test doubles

    /// In-memory `FrameSink` so a real `FrameWriter` can back the session.
    private final class MemorySink: FrameSink {
        private(set) var writes: [Data] = []
        func write(_ data: Data) { writes.append(data) }
    }

    /// Records diagnostic lines the session would otherwise send to stderr.
    private final class DiagnosticRecorder {
        private(set) var lines: [String] = []
        func record(_ line: String) { lines.append(line) }
    }

    /// Fake `CaptureStream` that records calls and can be told to fail specific
    /// operations, standing in for a real `SCStream`.
    private final class FakeCaptureStream: CaptureStream {
        private(set) var addedScreenOutput = false
        private(set) var addedAudioOutput = false
        private(set) var startCaptureCallCount = 0
        private(set) var stopCaptureCallCount = 0
        private(set) var removedScreenOutput = false
        private(set) var updatedConfigurations: [SCStreamConfiguration] = []

        var startCaptureError: Error?
        var updateConfigurationError: Error?

        func addStreamOutput(
            _ output: SCStreamOutput,
            type: SCStreamOutputType,
            sampleHandlerQueue: DispatchQueue?
        ) throws {
            if type == .screen { addedScreenOutput = true }
            if type == .audio { addedAudioOutput = true }
        }

        func removeStreamOutput(_ output: SCStreamOutput, type: SCStreamOutputType) throws {
            if type == .screen { removedScreenOutput = true }
        }

        func startCapture() async throws {
            startCaptureCallCount += 1
            if let error = startCaptureError { throw error }
        }

        func stopCapture() async throws {
            stopCaptureCallCount += 1
        }

        func updateConfiguration(_ configuration: SCStreamConfiguration) async throws {
            updatedConfigurations.append(configuration)
            if let error = updateConfigurationError { throw error }
        }
    }

    private struct StubError: Error, Equatable {
        let id: Int
    }

    private func makeSession(
        diagnostics: DiagnosticRecorder,
        onFatalError: @escaping (Error) -> Void = { _ in }
    ) -> SimulatorCaptureSession {
        let writer = FrameWriter(sink: MemorySink())
        return SimulatorCaptureSession(
            writer: writer,
            diagnosticSink: { diagnostics.record($0) },
            onFatalError: onFatalError
        )
    }

    // MARK: - Start / stop wiring

    func testBeginCaptureAddsScreenOutputStartsAndStoresStream() async throws {
        let diagnostics = DiagnosticRecorder()
        let session = makeSession(diagnostics: diagnostics)
        let fake = FakeCaptureStream()

        try await session.beginCapture(with: fake, audio: false)

        XCTAssertTrue(fake.addedScreenOutput)
        XCTAssertFalse(fake.addedAudioOutput)
        XCTAssertEqual(fake.startCaptureCallCount, 1)
        XCTAssertTrue(session.stream === fake)
    }

    func testBeginCaptureAddsAudioOutputWhenEnabled() async throws {
        let diagnostics = DiagnosticRecorder()
        let session = makeSession(diagnostics: diagnostics)
        let fake = FakeCaptureStream()

        try await session.beginCapture(with: fake, audio: true)

        XCTAssertTrue(fake.addedScreenOutput)
        XCTAssertTrue(fake.addedAudioOutput)
    }

    func testBeginCapturePropagatesStartFailureAndLeavesStreamUnset() async {
        let diagnostics = DiagnosticRecorder()
        let session = makeSession(diagnostics: diagnostics)
        let fake = FakeCaptureStream()
        fake.startCaptureError = StubError(id: 7)

        do {
            try await session.beginCapture(with: fake, audio: false)
            XCTFail("beginCapture should rethrow the startCapture failure")
        } catch let error as StubError {
            XCTAssertEqual(error, StubError(id: 7))
        } catch {
            XCTFail("unexpected error type: \(error)")
        }

        // A stream that never started must not be retained as the live stream.
        XCTAssertNil(session.stream)
    }

    func testStopRemovesScreenOutputStopsAndClearsStream() async {
        let diagnostics = DiagnosticRecorder()
        let session = makeSession(diagnostics: diagnostics)
        let fake = FakeCaptureStream()
        session.stream = fake

        await session.stop()

        XCTAssertTrue(fake.removedScreenOutput)
        XCTAssertEqual(fake.stopCaptureCallCount, 1)
        XCTAssertNil(session.stream)
    }

    func testStopWithoutStreamIsNoop() async {
        let diagnostics = DiagnosticRecorder()
        let session = makeSession(diagnostics: diagnostics)

        await session.stop()

        XCTAssertNil(session.stream)
    }

    // MARK: - Fatal-error handling

    func testFatalStopInvokesHandlerWithError() {
        let diagnostics = DiagnosticRecorder()
        var captured: Error?
        let session = makeSession(diagnostics: diagnostics) { captured = $0 }

        session.handleFatalStop(error: StubError(id: 42))

        XCTAssertEqual(captured as? StubError, StubError(id: 42))
    }

    // MARK: - First-frame signalling + marker emission

    func testFirstFrameEmitsMarkerOnceThenSuppresses() {
        let diagnostics = DiagnosticRecorder()
        let session = makeSession(diagnostics: diagnostics)
        session.windowID = 91

        XCTAssertFalse(session.firstFrameSignal.hasReceivedFrame)

        session.noteFrameWritten(width: 804, height: 1748)
        session.noteFrameWritten(width: 804, height: 1748)
        session.noteFrameWritten(width: 402, height: 874)

        XCTAssertTrue(session.firstFrameSignal.hasReceivedFrame)
        XCTAssertEqual(diagnostics.lines, ["capture-phase: first-frame id=91 size=804x1748\n"])
    }

    // MARK: - Reconfigure success / failure

    func testReconfigureSuccessUpdatesDimensionsAndPushesConfig() async {
        let diagnostics = DiagnosticRecorder()
        let session = makeSession(diagnostics: diagnostics)
        let fake = FakeCaptureStream()
        session.stream = fake
        session.fps = 30
        session.audioEnabled = true

        await session.performReconfiguration(width: 900, height: 1900)

        XCTAssertEqual(session.configuredPixelWidth, 900)
        XCTAssertEqual(session.configuredPixelHeight, 1900)
        XCTAssertEqual(fake.updatedConfigurations.count, 1)
        let pushed = fake.updatedConfigurations.first
        XCTAssertEqual(pushed?.width, 900)
        XCTAssertEqual(pushed?.height, 1900)
        XCTAssertEqual(pushed?.capturesAudio, true)
        XCTAssertTrue(diagnostics.lines.isEmpty)
    }

    func testReconfigureFailureIsSwallowedWithWarningButDimensionsStick() async {
        let diagnostics = DiagnosticRecorder()
        let session = makeSession(diagnostics: diagnostics)
        let fake = FakeCaptureStream()
        fake.updateConfigurationError = StubError(id: 1)
        session.stream = fake

        await session.performReconfiguration(width: 640, height: 480)

        // The new dimensions are recorded before the update is attempted, so a
        // failed update does not resurrect the stale size.
        XCTAssertEqual(session.configuredPixelWidth, 640)
        XCTAssertEqual(session.configuredPixelHeight, 480)
        XCTAssertEqual(diagnostics.lines.count, 1)
        let warning = diagnostics.lines.first ?? ""
        XCTAssertTrue(
            warning.hasPrefix("warn: failed to update stream configuration:"),
            "unexpected diagnostic line: \(warning)"
        )
    }

    func testReconfigureWithoutStreamIsNoop() async {
        let diagnostics = DiagnosticRecorder()
        let session = makeSession(diagnostics: diagnostics)

        await session.performReconfiguration(width: 100, height: 200)

        // No stream means nothing to update and no dimension bookkeeping.
        XCTAssertEqual(session.configuredPixelWidth, 0)
        XCTAssertEqual(session.configuredPixelHeight, 0)
        XCTAssertTrue(diagnostics.lines.isEmpty)
    }

    // NOTE: A bounded `startCapture()` timeout is not present on this branch
    // (tracked separately as the #4350 hardening work). When it lands, add a
    // case here that injects a `startCapture()` which never returns and asserts
    // the session times out — the `CaptureStream` seam already supports it.
}
