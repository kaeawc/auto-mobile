import Foundation

/// Reference vocabulary installed only by the launch test-hook factory.
@MainActor
final class PrototypeTestPlatformModule: PrototypePlatformModule {
    let name = "test"
    let capability = "prototype_platform_test_v1"
    let supportsSimulation = true
    private(set) var state: [String: JSONValue] = [:]
    let events: AsyncStream<PlatformEvent>

    init() { events = AsyncStream { $0.finish() } }

    func availability() -> PlatformAvailability { .ready }

    func call(_ call: PlatformCall) async -> PlatformCallResult {
        guard call.call == "test.echo" else { return .failure(.unsupported, "Unknown test call") }
        guard let message = call.args["message"] else { return .failure(.invalidArgs, "message is required") }
        return .success(message)
    }

    func simulate(_ event: PlatformEvent) -> Bool {
        guard event.event == "test.tick", let data = event.data.objectFields else { return false }
        state = data
        return true
    }
}
