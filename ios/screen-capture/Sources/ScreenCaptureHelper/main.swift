import AVFoundation
import Foundation
import ScreenCaptureKit
import ScreenCaptureCore

// MARK: - Constants

let simulatorPermissionTimeoutSeconds: TimeInterval = 2.0

// MARK: - Logging

func logError(_ message: String) {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
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

case .captureSimulator(let windowID, let fps):
    let window: SCWindow
    switch runBlocking({ try await SimulatorWindowDiscovery.find(windowID: windowID) }) {
    case .success(.some(let resolved)):
        window = resolved
    case .success(.none):
        logError("error: no window with CGWindowID \(windowID)")
        exit(1)
    case .failure(let error):
        logError("error: failed to query simulator windows: \(error)")
        exit(1)
    }

    let sink = FileHandleFrameSink(handle: .standardOutput)
    let writer = FrameWriter(sink: sink)
    let simSession = SimulatorCaptureSession(writer: writer)

    if case .failure(let error) = runBlocking({
        try await simSession.start(window: window, fps: fps)
    }) {
        logError("error: failed to start simulator capture: \(error)")
        exit(1)
    }

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
    let captureSession = DeviceCaptureSession(writer: writer)

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
