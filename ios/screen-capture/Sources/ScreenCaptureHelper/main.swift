import AVFoundation
import Foundation
import ScreenCaptureCore

// MARK: - Logging

func logError(_ message: String) {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
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
    let response = DeviceListResponse(devices: infos)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    do {
        let data = try encoder.encode(response)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    } catch {
        logError("error: failed to encode device list: \(error)")
        exit(1)
    }
    exit(0)

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

    // Graceful shutdown on SIGTERM/SIGINT.
    let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    let shutdown = {
        captureSession.stop()
        exit(0)
    }
    termSource.setEventHandler(handler: shutdown)
    intSource.setEventHandler(handler: shutdown)
    termSource.resume()
    intSource.resume()

    RunLoop.main.run()
}
