#if canImport(SimHidCore)
    import SimHidCore
#endif
import Darwin
import Foundation

// Usage: sim-hid-helper <udid>. Prints one `ready` line, then reads one JSON command per stdin
// line and prints one JSON ack per command until stdin closes (#19118). Commands run on their
// own queue so stdin EOF (the daemon retiring the helper) interrupts a command in progress, which
// then releases its held touch or button before the helper exits (#19163).
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

// Only the serial `commands` queue uses the server; the main thread only reads stdin.
nonisolated(unsafe) let server = SimHidServer(sender: backend)
let commands = DispatchQueue(label: "auto-mobile.sim-hid.commands")
while let line = readLine() {
    guard !line.trimmingCharacters(in: .whitespaces).isEmpty else { continue }
    commands.async { emit(SimHidServer.encode(server.handle(line: line))) }
}

backend.interrupt()
commands.sync {}
