import Foundation

@objc
public protocol ProbeBridge {
    func snapshot(version: Int, reply: @escaping (Data?, String?) -> Void)
}

public final class ProbeService: NSObject, ProbeBridge {
    private let probe: IdentityProbe
    private let lock = NSLock()
    private var active = false
    private var generation: UInt64 = 0

    public init(probe: IdentityProbe) {
        self.probe = probe
    }

    @discardableResult
    public func stopOrBeginStartup() -> UInt64 {
        lock.lock()
        defer { lock.unlock() }
        active = false
        generation &+= 1
        return generation
    }

    public func finishStartup(generation expected: UInt64, succeeded: Bool) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard generation == expected else { return false }
        active = succeeded
        return true
    }

    public func snapshot(version: Int, reply: @escaping (Data?, String?) -> Void) {
        guard version == IdentityProbe.version else {
            reply(nil, "Unsupported identity-probe protocol version")
            return
        }
        lock.lock()
        let started = active
        let revision = generation
        lock.unlock()
        guard started else {
            reply(nil, "Identity-probe provider is not active")
            return
        }
        do {
            let data = try JSONEncoder().encode(probe.snapshot())
            lock.lock()
            let current = active && revision == generation
            lock.unlock()
            guard current else {
                reply(nil, "Identity-probe provider changed while collecting the snapshot")
                return
            }
            reply(data, nil)
        } catch {
            reply(nil, "Unable to encode identity-probe snapshot")
        }
    }
}
