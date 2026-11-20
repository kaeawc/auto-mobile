import CarPlayPowerCore
import Darwin
import Foundation

func writeJSON(_ value: some Encodable, to handle: FileHandle) throws {
    var data = try JSONEncoder().encode(value)
    data.append(0x0A)
    handle.write(data)
}

do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard arguments.count == 2, arguments[1] == "status" || arguments[1] == "power-on" else {
        throw CarPlayPowerError(.usage, "Usage: carplay-power-helper <udid> status|power-on")
    }
    let controller = CarPlayPowerController(backend: PrivateSimulatorBackend())
    let state = try controller.run(udid: arguments[0], powerOn: arguments[1] == "power-on")
    try writeJSON(state, to: .standardOutput)
} catch {
    let failure = (error as? CarPlayPowerError)
        ?? CarPlayPowerError(.powerOnFailed, error.localizedDescription)
    do { try writeJSON(CarPlayErrorResponse(error: failure), to: .standardError) } catch {
        FileHandle.standardError
            .write(Data("{\"error\":{\"code\":\"power-on-failed\",\"message\":\"Cannot encode helper error\"}}\n".utf8))
    }
    exit(1)
}
