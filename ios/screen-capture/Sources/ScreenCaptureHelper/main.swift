import AppKit
import AVFoundation
import CoreGraphics
import Foundation
import ScreenCaptureKit
import ScreenCaptureCore

// MARK: - Constants

// ScreenCaptureKit cold-starts just beyond two seconds on hosted macOS runners.
// Keep the permission hint behind the source's first-frame timeout so startup
// latency is not misreported as a missing Screen Recording entitlement.
let simulatorPermissionTimeoutSeconds: TimeInterval = 10.0

// Exit status used when a capture stream dies *after* it started delivering
// frames (a mid-stream `SCStream`/`AVCaptureSession` fatal error). The helper
// deliberately exits with a non-zero, non-`1` code instead of leaving a dead
// stream spinning `RunLoop.main`: the parent supervisor (`IosH264Source`) owns
// bounded reconnect and re-launches a fresh helper on any non-zero exit, so a
// deterministic process signal is a stronger contract than a live-but-silent
// process the supervisor can only detect by string-matching an `error:` stderr
// line. `1` is already used for startup failures; `70` (EX_SOFTWARE) marks the
// distinct "was running, then the stream failed" case for log triage. See
// issue #4768.
let midStreamFatalExitCode: Int32 = 70

// A command-line process has no AppKit application by default. ScreenCaptureKit
// reaches CoreGraphics when creating an SCStream, and CoreGraphics aborts with
// CGS_REQUIRE_INIT unless this connection is initialized first.
_ = NSApplication.shared

// MARK: - Logging

func logError(_ message: String) {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
}

private final class FrameMetricsReporter {
    private static let linePrefix = "automobile-frame-metrics:"

    private let writer: FrameWriter
    private let output: (String) -> Void
    private let queue = DispatchQueue(label: "automobile.screen-capture.metrics")
    private var timer: DispatchSourceTimer?

    init(writer: FrameWriter, output: @escaping (String) -> Void) {
        self.writer = writer
        self.output = output
    }

    func start() {
        guard timer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in
            self?.emitSnapshot()
        }
        self.timer = timer
        timer.resume()
    }

    func stop() {
        timer?.cancel()
        timer = nil
    }

    private func emitSnapshot() {
        guard let encoded = try? JSONEncoder().encode(writer.metrics()),
              let json = String(data: encoded, encoding: .utf8) else {
            return
        }
        output("\(Self.linePrefix)\(json)")
    }
}

// ScreenCaptureKit failures can surface as Objective-C exceptions, which would
// otherwise terminate this subprocess with only SIGABRT visible to its parent.
// Emit the exception while stderr is still connected so the daemon artifact
// identifies the failing capture stage.
NSSetUncaughtExceptionHandler { exception in
    logError(
        "fatal: uncaught Objective-C exception \(exception.name.rawValue): "
        + (exception.reason ?? "no reason provided")
    )
}

func writeJSON<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    do {
        let data = try encoder.encode(value)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    } catch {
        logError("error: failed to encode JSON: \(error)")
        exit(1)
    }
}

// MARK: - Argument parsing

let options: CommandLineOptions
do {
    options = try CommandLineOptions.parse(CommandLine.arguments)
} catch let CommandLineOptions.ParseError.missingValue(flag) {
    logError("error: missing value for \(flag)")
    logError(CommandLineOptions.helpText)
    exit(2)
} catch let CommandLineOptions.ParseError.unknownArgument(arg) {
    logError("error: unknown argument \(arg)")
    logError(CommandLineOptions.helpText)
    exit(2)
} catch let CommandLineOptions.ParseError.invalidValue(flag, value) {
    logError("error: invalid value '\(value)' for \(flag)")
    logError(CommandLineOptions.helpText)
    exit(2)
} catch let CommandLineOptions.ParseError.conflictingFlags(message) {
    logError("error: conflicting flags — \(message)")
    logError(CommandLineOptions.helpText)
    exit(2)
} catch {
    logError("error: \(error)")
    exit(2)
}

// MARK: - Dispatch

switch options.mode {
case .help:
    print(CommandLineOptions.helpText)
    exit(0)

case .listDevices:
    CMIOSystem.enableScreenCaptureDevices()
    // Poll briefly for the system to register USB devices instead of an
    // unconditional 0.5s sleep; return as soon as one enumerates (issue #4737).
    DeviceReadinessPolling.waitUntilReady { !DeviceDiscovery.discover().isEmpty }
    let infos = DeviceDiscovery.discover().map(DeviceDiscovery.toInfo)
    writeJSON(DeviceListResponse(devices: infos))
    exit(0)

case .listSimulators:
    switch runBlocking({ try await SimulatorWindowDiscovery.discover() }) {
    case .success(let windows):
        writeJSON(SimulatorWindowListResponse(windows: windows))
        exit(0)
    case .failure(let error):
        logError("error: failed to query simulator windows: \(error)")
        logError("hint: grant Screen Recording permission to your terminal/IDE.")
        exit(1)
    }

case .captureSimulator(let windowID, let fps, let audio):
    guard CGPreflightScreenCaptureAccess() else {
        logError(
            "error: Screen Recording permission is required. Grant Screen Recording to your terminal/IDE in System Settings > Privacy & Security > Screen Recording."
        )
        exit(1)
    }
    logError(CaptureStartupMarker.line(.permissionReady))

    if audio {
        switch runBlocking({ try await SimulatorWindowDiscovery.discover() }) {
        case .success(let windows):
            if let error = SimulatorAudioCaptureAvailability.errorMessage(for: windows) {
                logError("error: \(error)")
                exit(1)
            }
        case .failure(let error):
            logError("error: failed to query simulator windows: \(error)")
            exit(1)
        }
    }

    // Emit stage markers synchronously to stderr before each blocking call. The
    // capture start itself must not use `runBlocking`: ScreenCaptureKit completes
    // it through the main run loop on recent macOS releases.
    logError(CaptureStartupMarker.line(.resolvingWindow(windowID: windowID)))
    let window: SCWindow
    switch runBlocking({ try await SimulatorWindowDiscovery.find(windowID: windowID) }) {
    case .success(.resolved(let resolved)):
        window = resolved
        logError(CaptureStartupMarker.line(.resolvedWindow(
            windowID: windowID,
            width: Int(resolved.frame.width),
            height: Int(resolved.frame.height)
        )))
    case .success(.notFound):
        logError("error: no window with CGWindowID \(windowID)")
        exit(1)
    case .success(.notSimulatorWindow(let bundleIdentifier)):
        // Fail closed: the window id resolves to a live window that is not owned
        // by the iOS Simulator (a recycled/stale window id). Capturing it would
        // silently leak an unrelated window's contents (#4763).
        logError(
            "error: window with CGWindowID \(windowID) is not an iOS Simulator window"
            + " (owning bundle: \(bundleIdentifier ?? "unknown")); refusing to capture"
        )
        exit(1)
    case .failure(let error):
        logError("error: failed to query simulator windows: \(error)")
        exit(1)
    }

    let sink = FileHandleFrameSink(handle: .standardOutput)
    let writer = FrameWriter(sink: sink)
    let metricsReporter = FrameMetricsReporter(writer: writer, output: logError)
    metricsReporter.start()
    let simSession = SimulatorCaptureSession(writer: writer) { error in
        // A mid-stream ScreenCaptureKit fatal error: exit deterministically so
        // the supervisor's bounded reconnect re-establishes capture, rather than
        // leaving RunLoop.main spinning on a dead stream (issue #4768).
        logError("error: ScreenCaptureKit stream stopped: \(error)")
        exit(midStreamFatalExitCode)
    }
    let firstFrameSignal = simSession.firstFrameSignal

    // ScreenCaptureKit silently emits no frames when the host process lacks
    // Screen Recording permission — there's no error to surface. Emit a hint on
    // stderr if nothing arrives within the deadline; this leaves stdout (the
    // frame channel) untouched. The timer lives on a dedicated queue — never the
    // main run loop — so a main-actor-blocked start cannot starve it (issue
    // #4764). It is *armed* only once capture has started so the measured
    // 2.6–13s slow-start window cannot trip a false "no frames" warning; a start
    // that never reaches capture-started is bounded and surfaced by the start
    // deadline inside SimulatorCaptureSession instead.
    let permissionHintQueue = DispatchQueue(label: "automobile.simulator-capture.permission-hint")
    let permissionHintTimer = DispatchSource.makeTimerSource(queue: permissionHintQueue)
    permissionHintTimer.setEventHandler {
        if !firstFrameSignal.hasReceivedFrame {
            logError(
                "warn: no frames received within \(simulatorPermissionTimeoutSeconds)s. "
                + "Grant 'Screen Recording' to your terminal/IDE in "
                + "System Settings → Privacy & Security → Screen Recording."
            )
        }
    }

    logError(CaptureStartupMarker.line(.startingCapture(windowID: windowID, fps: fps)))
    installShutdownHandlers {
        metricsReporter.stop()
        permissionHintTimer.cancel()
        Task { @MainActor in
            await simSession.stop()
            exit(0)
        }
    }
    Task { @MainActor in
        do {
            try await simSession.start(window: window, fps: fps, audio: audio)
            logError(CaptureStartupMarker.line(.captureStarted(windowID: windowID)))

            // Measure the no-frames window from capture-started, not from launch,
            // so the slow-start tail never counts against it.
            permissionHintTimer.schedule(deadline: .now() + simulatorPermissionTimeoutSeconds)
            permissionHintTimer.resume()
        } catch {
            logError("error: failed to start simulator capture: \(error)")
            exit(1)
        }
    }
    RunLoop.main.run()

case .capture(let deviceID):
    CMIOSystem.enableScreenCaptureDevices()
    // Poll briefly for the requested device to register instead of an
    // unconditional 0.5s sleep; return as soon as it enumerates (issue #4737).
    DeviceReadinessPolling.waitUntilReady {
        if let id = deviceID {
            return DeviceDiscovery.find(uniqueID: id) != nil
        }
        return !DeviceDiscovery.discover().isEmpty
    }

    let resolved: AVCaptureDevice?
    if let id = deviceID {
        resolved = DeviceDiscovery.find(uniqueID: id)
        if resolved == nil {
            logError("error: no device with uniqueID '\(id)'")
            exit(1)
        }
    } else {
        resolved = DeviceDiscovery.discover().first
        if resolved == nil {
            logError("error: no muxed external capture devices found")
            exit(1)
        }
    }
    guard let device = resolved else { exit(1) }

    let sink = FileHandleFrameSink(handle: .standardOutput)
    let writer = FrameWriter(sink: sink)
    let metricsReporter = FrameMetricsReporter(writer: writer, output: logError)
    metricsReporter.start()
    let captureSession = DeviceCaptureSession(writer: writer) { error in
        // A mid-stream AVCaptureSession fatal error (runtime error / interruption
        // once running): exit deterministically so the supervisor's bounded
        // reconnect re-establishes capture instead of leaving a dead session
        // spinning RunLoop.main (issue #4768).
        logError("error: iOS device capture failed: \(error)")
        exit(midStreamFatalExitCode)
    }

    do {
        try captureSession.start(device: device)
    } catch {
        logError("error: failed to start capture session: \(error)")
        exit(1)
    }

    installShutdownHandlers {
        metricsReporter.stop()
        captureSession.stop()
        exit(0)
    }
    RunLoop.main.run()
}

// MARK: - Async/sync bridges

// A reference box so the Task closure mutates a captured class instead of a
// `var`. Swift 5.9 (Xcode 15) rejects `var` capture in `Task { … }` even when
// the semaphore enforces a happens-before relationship; class capture is fine.
private final class Box<T> {
    var value: T
    init(_ value: T) { self.value = value }
}

func runBlocking<T>(_ body: @escaping () async throws -> T) -> Result<T, Error> {
    let semaphore = DispatchSemaphore(value: 0)
    let box = Box<Result<T, Error>>(.failure(CancellationError()))
    Task {
        do {
            box.value = .success(try await body())
        } catch {
            box.value = .failure(error)
        }
        semaphore.signal()
    }
    semaphore.wait()
    return box.value
}

func runBlocking<T>(_ body: @escaping () async -> T) -> T {
    let semaphore = DispatchSemaphore(value: 0)
    let box = Box<T?>(nil)
    Task {
        box.value = await body()
        semaphore.signal()
    }
    semaphore.wait()
    // box.value is set by the async body before semaphore.signal(); wait() blocks until then.
    return box.value!  // swiftlint:disable:this force_unwrapping
}

// MARK: - Signal handling

// Retain signal sources beyond `installShutdownHandlers` to keep them alive
// for the duration of the run loop.
private var retainedSignalSources: [DispatchSourceSignal] = []

func installShutdownHandlers(_ handler: @escaping () -> Void) {
    let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    // Ignore the default disposition so the DispatchSources are the only
    // handlers that run.
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    termSource.setEventHandler(handler: handler)
    intSource.setEventHandler(handler: handler)
    termSource.resume()
    intSource.resume()
    retainedSignalSources = [termSource, intSource]
}
