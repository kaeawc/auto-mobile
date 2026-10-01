import CoreMedia
import CoreVideo
import Foundation
@testable import ScreenCaptureCore
@testable import ScreenCaptureHelper
import ScreenCaptureKit
import XCTest

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
        func write(_ data: Data) {
            writes.append(data)
        }
    }

    /// Records diagnostic lines the session would otherwise send to stderr.
    private final class DiagnosticRecorder {
        private(set) var lines: [String] = []
        func record(_ line: String) {
            lines.append(line)
        }
    }

    /// Fake `CaptureStream` that records calls and can be told to fail specific
    /// operations, standing in for a real `SCStream`. `@unchecked Sendable` (as the
    /// `Sendable` `CaptureStream` seam requires): tests await lifecycle calls
    /// before inspecting state; overlapping reconfigure updates guard their log.
    private final class FakeCaptureStream: CaptureStream, @unchecked Sendable {
        func updateContentFilter(_: SCContentFilter) async throws {}
        private let updateLock = NSLock()
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
            _: SCStreamOutput,
            type: SCStreamOutputType,
            sampleHandlerQueue _: DispatchQueue?
        )
            throws
        {
            if type == .screen {
                addedScreenOutput = true
            }
            if type == .audio {
                addedAudioOutput = true
            }
        }

        func removeStreamOutput(_: SCStreamOutput, type: SCStreamOutputType) throws {
            if type == .screen {
                removedScreenOutput = true
            }
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
            if let error = startCaptureError {
                throw error
            }
        }

        func stopCapture() async throws {
            stopCaptureCallCount += 1
        }

        func updateConfiguration(_ configuration: SCStreamConfiguration) async throws {
            let shouldFailTransiently = updateLock.withLock {
                updatedConfigurations.append(configuration)
                if updateConfigurationTransientFailures > 0 {
                    updateConfigurationTransientFailures -= 1
                    return true
                }
                return false
            }
            if shouldFailTransiently {
                throw StubError(id: -1)
            }
            if let error = updateConfigurationError {
                throw error
            }
        }
    }

    private struct StubError: Error, Equatable {
        let id: Int
    }

    private func makeSession(
        diagnostics: DiagnosticRecorder,
        onFatalError: @escaping (Error) -> Void = { _ in }
    )
        -> SimulatorCaptureSession
    {
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

    func testIdleEvidenceRequiresLiveStreamAndFirstFrameAndIsRateLimited() async throws {
        let diagnostics = DiagnosticRecorder()
        var now: TimeInterval = 100
        let session = SimulatorCaptureSession(
            writer: FrameWriter(sink: MemorySink()),
            diagnosticSink: { diagnostics.record($0) },
            uptime: { now },
            onFatalError: { _ in }
        )
        session.windowID = 91
        session.noteIdleSample()
        let fake = FakeCaptureStream()
        try await session.beginCapture(with: fake, audio: false)
        session.noteIdleSample()
        XCTAssertTrue(diagnostics.lines.isEmpty)

        session.noteFrameWritten(width: 804, height: 1748)
        session.noteNonCompleteStatus(.blank)
        session.noteNonCompleteStatus(.suspended)
        session.noteNonCompleteStatus(.stopped)
        XCTAssertFalse(diagnostics.lines.contains { $0.hasPrefix("capture-idle:") })
        session.noteNonCompleteStatus(.idle)
        now += 1
        session.noteIdleSample()
        now += 1
        session.noteIdleSample()
        XCTAssertEqual(diagnostics.lines.filter { $0.hasPrefix("capture-idle:") }, [
            "capture-idle: windowID=91\n",
            "capture-idle: windowID=91\n",
        ])

        await session.stop()
        now += 2
        session.noteIdleSample()
        XCTAssertEqual(diagnostics.lines.filter { $0.hasPrefix("capture-idle:") }.count, 2)
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

    func testOverlayConfigurationPreservesRetinaPixels() async throws {
        let session = makeSession(diagnostics: DiagnosticRecorder())
        let fake = FakeCaptureStream()
        session.configuredPixelWidth = 920
        session.configuredPixelHeight = 1970
        try await session.applyOverlayConfiguration(stream: fake)
        XCTAssertEqual(fake.updatedConfigurations.last?.width, 920)
        XCTAssertEqual(fake.updatedConfigurations.last?.height, 1970)
        XCTAssertEqual(session.configuredPixelWidth, 920)
        XCTAssertEqual(session.configuredPixelHeight, 1970)
    }

    func testOverlayConfigurationFailurePropagatesAfterRetry() async {
        let session = makeSession(diagnostics: DiagnosticRecorder())
        let fake = FakeCaptureStream()
        fake.updateConfigurationError = StubError(id: 1)
        do {
            try await session.applyOverlayConfiguration(stream: fake)
            XCTFail("A failed crop transition must not be accepted")
        } catch {
            XCTAssertEqual(fake.updatedConfigurations.count, 2)
        }
    }

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

    // MARK: - Reconfigure size commit

    func testReconfigureCommitsEachSizeSynchronously() {
        let session = makeSession(diagnostics: DiagnosticRecorder())
        let fake = FakeCaptureStream()
        session.stream = fake

        // A -> B -> A can happen before any asynchronous update completes. Each
        // request must commit before returning so the frame path sees the latest size.
        session.reconfigure(width: 900, height: 1900)
        XCTAssertEqual(session.configuredPixelWidth, 900)
        XCTAssertEqual(session.configuredPixelHeight, 1900)
        session.reconfigure(width: 910, height: 1910)
        XCTAssertEqual(session.configuredPixelWidth, 910)
        XCTAssertEqual(session.configuredPixelHeight, 1910)
        session.reconfigure(width: 900, height: 1900)
        XCTAssertEqual(session.configuredPixelWidth, 900)
        XCTAssertEqual(session.configuredPixelHeight, 1900)
    }

    func testReconfigureWithoutStreamLeavesSizeUnset() {
        let session = makeSession(diagnostics: DiagnosticRecorder())

        session.reconfigure(width: 640, height: 480)

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
