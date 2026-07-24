import AppKit
import AVFoundation
import Foundation
import ScreenCaptureKit
import ScreenCaptureCore

// MARK: - Constants

// ScreenCaptureKit cold-starts just beyond two seconds on hosted macOS runners.
// Keep the permission hint behind the source's first-frame timeout so startup
// latency is not misreported as a missing Screen Recording entitlement.
let simulatorPermissionTimeoutSeconds: TimeInterval = 10.0

// A command-line process has no AppKit application by default. ScreenCaptureKit
// reaches CoreGraphics when creating an SCStream, and CoreGraphics aborts with
// CGS_REQUIRE_INIT unless this connection is initialized first.
_ = NSApplication.shared

// MARK: - Logging

func logError(_ message: String) {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
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
    // Allow a brief moment for the system to register USB devices.
    Thread.sleep(forTimeInterval: 0.5)
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

    // Emit stage markers synchronously to stderr before each blocking call. When
    // `startCapture()` hangs, `runBlocking` parks the main thread, so the 10s
    // permission hint (scheduled on the main queue) never fires — the last marker
    // observed is then the only signal of which stage stalled (issue #4350).
    logError(CaptureStartupMarker.line(.resolvingWindow(windowID: windowID)))
    let window: SCWindow
    switch runBlocking({ try await SimulatorWindowDiscovery.find(windowID: windowID) }) {
    case .success(.some(let resolved)):
        window = resolved
        logError(CaptureStartupMarker.line(.resolvedWindow(
            windowID: windowID,
            width: Int(resolved.frame.width),
            height: Int(resolved.frame.height)
        )))
    case .success(.none):
        logError("error: no window with CGWindowID \(windowID)")
        exit(1)
    case .failure(let error):
        logError("error: failed to query simulator windows: \(error)")
        exit(1)
    }

    let sink = FileHandleFrameSink(handle: .standardOutput)
    let writer = FrameWriter(sink: sink)
    let simSession = SimulatorCaptureSession(writer: writer) { error in
        logError("error: ScreenCaptureKit stream stopped: \(error)")
    }

    logError(CaptureStartupMarker.line(.startingCapture(windowID: windowID, fps: fps)))
    if case .failure(let error) = runBlocking({
        try await simSession.start(window: window, fps: fps, audio: audio)
    }) {
        logError("error: failed to start simulator capture: \(error)")
        exit(1)
    }
    logError(CaptureStartupMarker.line(.captureStarted(windowID: windowID)))

    // ScreenCaptureKit silently emits no frames when the host process lacks
    // Screen Recording permission — there's no error to surface. Emit a hint
    // on stderr if nothing arrives within the deadline; this leaves stdout
    // (the frame channel) untouched.
    DispatchQueue.main.asyncAfter(deadline: .now() + simulatorPermissionTimeoutSeconds) {
        if !simSession.hasReceivedAnyFrame {
            logError(
                "warn: no frames received within \(simulatorPermissionTimeoutSeconds)s. "
                + "Grant 'Screen Recording' to your terminal/IDE in "
                + "System Settings → Privacy & Security → Screen Recording."
            )
        }
    }

    installShutdownHandlers {
        runBlocking { await simSession.stop() }
        exit(0)
    }
    RunLoop.main.run()

case .capture(let deviceID):
    CMIOSystem.enableScreenCaptureDevices()
    Thread.sleep(forTimeInterval: 0.5)

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
    let captureSession = DeviceCaptureSession(writer: writer) { error in
        logError("error: iOS device capture failed: \(error)")
    }

    do {
        try captureSession.start(device: device)
    } catch {
        logError("error: failed to start capture session: \(error)")
        exit(1)
    }

    installShutdownHandlers {
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
