#if canImport(SimHidCore)
    import SimHidCore
#endif
import Darwin
import Foundation

// Usage: sim-hid-helper <udid>. Prints one `ready` line, then reads one JSON command per stdin
// line and prints one JSON ack per command until stdin closes (#19118).
func emit(_ line: String) {
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

let arguments = CommandLine.arguments.dropFirst()
guard arguments.count == 1, let udid = arguments.first else {
    emit(SimHidServer.encode(SimHidStartupFailure(error: SimHidError("usage", "Usage: sim-hid-helper <udid>"))))
    exit(2)
}

let started = Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000
let backend: SimulatorKitHIDBackend
do {
    backend = try SimulatorKitHIDBackend(udid: udid)
} catch {
    emit(SimHidServer.encode(SimHidStartupFailure(error: simHidError(error))))
    exit(1)
}

emit(SimHidServer.encode(SimHidReady(initMs: backend.nowMs() - started)))

let server = SimHidServer(sender: backend)
while let line = readLine() {
    guard !line.trimmingCharacters(in: .whitespaces).isEmpty else { continue }
    emit(SimHidServer.encode(server.handle(line: line)))
}
