import Foundation

/// Host-only injection. Every refusal precedes module mutation and ordinary event delivery.
@MainActor
enum PrototypePlatformSimulation {
    static func apply(
        id: String, event: String, data: JSONValue, session: PrototypeSession,
        registry: PrototypePlatformRegistry, deliver: (PlatformEvent) -> Void
    )
        -> String?
    {
        guard session.isShown, let spec = session.spec, spec.id == id else {
            return "Unknown or inactive prototype id: \(id)"
        }
        let parts = event.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 2,
              PrototypePlatformValidator.modules[String(parts[0])]?.events.contains(String(parts[1])) == true
        else { return "Unknown platform event: \(event); use a known module event" }
        let name = String(parts[0])
        guard spec.declaredPlatform.contains(name) else {
            return "Declare \(name) in requires.platform before simulation"
        }
        guard data.objectFields != nil else { return "simulate data must be a JSON object" }
        let payload = JSONValue.object(["event": .string(event), "data": data, "simulated": .bool(true)])
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        guard let encoded = try? encoder.encode(payload) else { return "simulate data must contain only JSON values" }
        guard encoded.count <= PrototypeLimits.maxEmitPayloadBytes else {
            return "simulate event payload exceeds the 4096-byte emit budget; reduce data"
        }
        guard let module = registry.modules[name], module.supportsSimulation,
              module.simulate(PlatformEvent(event: event, data: data))
        else { return "unsupported: platform module does not support simulation" }
        deliver(PlatformEvent(simulating: event, data: data))
        return nil
    }
}
