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
        /// When `true`, `startCapture()` parks far longer than any test-injected
        /// deadline, standing in for a `SCStream.startCapture()` hung inside
        /// ScreenCaptureKit start (issue #4350). The session's deadline race is
        /// expected to cancel this task, so the sleep unwinds via `CancellationError`
        /// rather than leaking. If the deadline ever regresses, the sleep instead
        /// completes (a bounded 5s) so the test fails fast with a clear assertion
        /// instead of hanging.
        var startCaptureHangs = false
        /// When set, every `updateConfiguration` call throws it.
        var updateConfigurationError: Error?
        /// Throws on the first N `updateConfiguration` calls, then succeeds —
        /// models a transient failure that a single retry recovers from.
        var updateConfigurationTransientFailures = 0

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
            if startCaptureHangs {
                // Far exceeds any sane test deadline; the session's timeout arm
                // cancels this task, so the sleep throws `CancellationError` and
                // unwinds cleanly. The 5s bound only elapses if the deadline
                // regresses, turning a hang into a fast assertion failure.
                try await Task.sleep(nanoseconds: 5_000_000_000)
            }
            if let error = startCaptureError { throw error }
        }

        func stopCapture() async throws {
            stopCaptureCallCount += 1
        }

        func updateConfiguration(_ configuration: SCStreamConfiguration) async throws {
            updatedConfigurations.append(configuration)
            if updateConfigurationTransientFailures > 0 {
                updateConfigurationTransientFailures -= 1
                throw StubError(id: -1)
            }
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

    func testReconfigureRetriesOnceThenWarnsButDimensionsStick() async {
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
        // A persistent failure is retried exactly once (two total attempts).
        XCTAssertEqual(fake.updatedConfigurations.count, 2)
        XCTAssertEqual(diagnostics.lines.count, 2)
        XCTAssertTrue(
            diagnostics.lines[0].hasPrefix("warn: stream configuration update failed; retrying once:"),
            "unexpected first diagnostic line: \(diagnostics.lines[0])"
        )
        XCTAssertTrue(
            diagnostics.lines[1].hasPrefix("warn: failed to update stream configuration after retry:"),
            "unexpected second diagnostic line: \(diagnostics.lines[1])"
        )
    }

    func testReconfigureRecoversOnRetryWithoutFinalWarning() async {
        let diagnostics = DiagnosticRecorder()
        let session = makeSession(diagnostics: diagnostics)
        let fake = FakeCaptureStream()
        // Fail the first update, succeed on the retry.
        fake.updateConfigurationTransientFailures = 1
        session.stream = fake

        await session.performReconfiguration(width: 800, height: 600)

        XCTAssertEqual(session.configuredPixelWidth, 800)
        XCTAssertEqual(session.configuredPixelHeight, 600)
        // Two attempts: the transient failure plus the successful retry.
        XCTAssertEqual(fake.updatedConfigurations.count, 2)
        XCTAssertEqual(fake.updatedConfigurations.last?.width, 800)
        XCTAssertEqual(fake.updatedConfigurations.last?.height, 600)
        // Only the "retrying once" notice; no ultimate-failure line, since the
        // retry applied the new configuration.
        XCTAssertEqual(diagnostics.lines.count, 1)
        XCTAssertTrue(
            diagnostics.lines[0].hasPrefix("warn: stream configuration update failed; retrying once:"),
            "unexpected diagnostic line: \(diagnostics.lines[0])"
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

    // MARK: - Reconfigure dedup (storm / data-race fix)

    func testBeginReconfigureCommitsSizeSynchronouslyAndDedupsWhileInFlight() {
        let session = makeSession(diagnostics: DiagnosticRecorder())
        let fake = FakeCaptureStream()
        session.stream = fake

        // First frame at a new size claims the reconfigure slot and commits the size
        // synchronously (before any async hop), so subsequent frames see the new size.
        let first = session.beginReconfigure(width: 900, height: 1900)
        XCTAssertTrue(first === fake, "first reconfigure returns the stream to update")
        XCTAssertEqual(session.configuredPixelWidth, 900)
        XCTAssertEqual(session.configuredPixelHeight, 1900)

        // A second frame while the update is in flight commits the size but does NOT
        // spawn a second update — this is the storm dedup.
        let second = session.beginReconfigure(width: 900, height: 1900)
        XCTAssertNil(second, "a reconfigure already in flight is deduped")
        XCTAssertEqual(session.configuredPixelWidth, 900)

        // Once the in-flight update completes, a genuinely new size reconfigures again.
        session.endReconfigure()
        let third = session.beginReconfigure(width: 910, height: 1910)
        XCTAssertTrue(third === fake, "after the slot is released a new size reconfigures again")
        XCTAssertEqual(session.configuredPixelWidth, 910)
        XCTAssertEqual(session.configuredPixelHeight, 1910)
    }

    func testBeginReconfigureWithoutStreamReturnsNilAndLeavesSizeUnset() {
        let session = makeSession(diagnostics: DiagnosticRecorder())

        let result = session.beginReconfigure(width: 640, height: 480)

        XCTAssertNil(result)
        XCTAssertEqual(session.configuredPixelWidth, 0, "no stream: nothing to reconfigure")
        XCTAssertEqual(session.configuredPixelHeight, 0)
    }

    // MARK: - Bounded startCapture() deadline (issue #4350 / #4764)

    /// A `startCapture()` that hangs inside ScreenCaptureKit start must be
    /// surfaced as a specific `StartCaptureTimeoutError` — the greppable
    /// `error:` diagnostic the parent supervisor fails fast on — rather than
    /// stalling until the parent's 15s SIGTERM with silent frame starvation.
    /// This pins the deadline race added for the #4350 no-frames flake.
    func testBeginCaptureTimesOutWhenStartCaptureHangs() async {
        let diagnostics = DiagnosticRecorder()
        let session = makeSession(diagnostics: diagnostics)
        // Shrink the 14s production deadline so the hang resolves in tens of ms.
        session.startCaptureDeadlineSeconds = 0.05
        let fake = FakeCaptureStream()
        fake.startCaptureHangs = true

        do {
            try await session.beginCapture(with: fake, audio: false)
            XCTFail("beginCapture should time out when startCapture never returns")
        } catch let error as StartCaptureTimeoutError {
            XCTAssertEqual(error.deadlineSeconds, 0.05)
        } catch {
            XCTFail("unexpected error type: \(error)")
        }

        // The start was attempted, but a stream that never started must not be
        // retained as the live stream.
        XCTAssertEqual(fake.startCaptureCallCount, 1)
        XCTAssertNil(session.stream)
    }
}
