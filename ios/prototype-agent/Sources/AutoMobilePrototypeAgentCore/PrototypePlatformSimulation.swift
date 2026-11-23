import Foundation

/// Host-only injection. Every refusal precedes module mutation and ordinary event delivery.
@MainActor
enum PrototypePlatformSimulation {
    static func callRefusal(
        id: String, call: String, session: PrototypeSession, registry: PrototypePlatformRegistry
    )
        -> String?
    {
        guard session.isShown, let spec = session.spec, spec.id == id else {
            return "Unknown or inactive prototype id: \(id)"
        }
        let parts = call.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 2, PrototypePlatformValidator.modules[String(parts[0])]?.calls[String(parts[1])] != nil
        else { return "Unknown platform call: \(call)" }
        let name = String(parts[0])
        guard spec.declaredPlatform.contains(name) else {
            return "Declare \(name) in requires.platform before simulation"
        }
        guard let module = registry.modules[name] else { return "No module registered for \(call)" }
        guard module.supportsSimulation else { return "unsupported: platform module does not support simulation" }
        return nil
    }

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
        guard let byteCount = PrototypeEmitContext.jsonByteCount(payload) else {
            return "simulate data must contain only JSON values"
        }
        guard byteCount <= PrototypeLimits.maxEmitPayloadBytes else {
            return "simulate event payload exceeds the 4096-byte emit budget; reduce data"
        }
        guard let module = registry.modules[name], module.supportsSimulation,
              module.simulate(PlatformEvent(event: event, data: data))
        else { return "unsupported: platform module does not support simulation" }
        deliver(PlatformEvent(simulating: event, data: data))
        return nil
    }
}

/// One FIFO per contract call, owned by the presentation's driver.
struct PrototypePlatformOutcomes {
    private static let maxQueuedPerCall = 16
    private var queues: [String: [PlatformCallResult]] = [:]

    mutating func enqueue(call: String, outcome: JSONValue) -> String? {
        guard let bytes = PrototypeEmitContext.jsonByteCount(outcome), bytes <= PrototypeLimits.maxEmitPayloadBytes
        else { return "simulate outcome must be JSON within the 4096-byte emit budget" }
        guard let fields = outcome.objectFields, fields.count == 1 else {
            return "Provide exactly one result or error"
        }
        let result: PlatformCallResult
        if let value = fields["result"] { result = .success(value) }
        else {
            guard let error = fields["error"]?.objectFields,
                  error.keys.allSatisfy({ $0 == "code" || $0 == "message" }),
                  let rawCode = error["code"]?.stringValue, let code = PlatformErrorCode(rawValue: rawCode)
            else { return "Outcome error requires a known platform error code" }
            let message = error["message"]?.stringValue
            guard error["message"] == nil || (message?.utf16.count ?? 201) <= 200 else {
                return "Outcome error message must be at most 200 characters"
            }
            result = .failure(code, message ?? "")
        }
        guard (queues[call]?.count ?? 0) < Self.maxQueuedPerCall else {
            return "At most \(Self.maxQueuedPerCall) outcomes can be queued for \(call)"
        }
        queues[call, default: []].append(result)
        return nil
    }

    func hasQueued(call: String) -> Bool {
        queues[call] != nil
    }

    mutating func consume(call: String) -> PlatformCallResult? {
        let result = queues[call]?.removeFirst()
        if queues[call]?.isEmpty == true { queues[call] = nil }
        return result
    }

    mutating func clear() {
        queues.removeAll()
    }
}
