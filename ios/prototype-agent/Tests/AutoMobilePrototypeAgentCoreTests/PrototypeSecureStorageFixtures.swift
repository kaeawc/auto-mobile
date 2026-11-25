@testable import AutoMobilePrototypeAgentCore
import XCTest

final class FakeSecureValueStore: PrototypeSecureValueStore {
    var records: [String: [String: PrototypeSecureEntry]] = [:]
    /// Invalidated keys by prototype id, like `records`.
    var invalidated: [String: Set<String>] = [:]
    var readFailure = false
    var writeFailure = false
    var deleteFailure = false
    var deleteAllFailure = false
    var reads: [String] = []
    var writes: [String] = []
    var deletes: [String] = []
    struct Failure: Error {}

    func readAll(id: String) throws -> (entries: [String: PrototypeSecureEntry], invalidated: Set<String>) {
        reads.append(id)
        if readFailure { throw Failure() }
        return (records[id] ?? [:], invalidated[id] ?? [])
    }

    func write(id: String, key: String, entry: PrototypeSecureEntry) throws {
        writes.append(key)
        if writeFailure { throw Failure() }
        records[id, default: [:]][key] = entry
    }

    func delete(id: String, key: String) throws {
        deletes.append(key)
        if deleteFailure { throw Failure() }
        records[id]?[key] = nil
        invalidated[id]?.remove(key)
    }

    func deleteAll(id: String) throws -> Int {
        if deleteAllFailure { throw Failure() }
        let count = Set(records[id]?.keys ?? [String: PrototypeSecureEntry]().keys).union(invalidated[id] ?? []).count
        records[id] = nil
        invalidated[id] = nil
        return count
    }
}

final class SecureStorageClock: PrototypeClock {
    final class Timer: PrototypeTimerHandle {
        var cancelled = false
        let fire: () -> Void
        init(_ fire: @escaping () -> Void) { self.fire = fire }
        func cancel() { cancelled = true }
    }

    var timers: [Timer] = []
    var delays: [Int] = []
    func schedule(afterMilliseconds delay: Int, _ fire: @escaping () -> Void) -> PrototypeTimerHandle {
        let timer = Timer(fire)
        timers.append(timer)
        delays.append(delay)
        return timer
    }

    func elapse() {
        for timer in timers where !timer.cancelled {
            timer.cancel()
            timer.fire()
        }
    }
}

func secureRuntimeSpec(id: String = "vault", version: Int = 1, biometric: Bool = false) throws -> PrototypeSpec {
    let auth = biometric ? #", "secureAuth":{"state:pin":"biometric"}"# : ""
    let platform = biometric ? #"["secureStorage","biometric"]"# : #"["secureStorage"]"#
    return try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
    {"id":"\(id)","window":{"placement":{"type":"fullscreen"}},
     "requires":{"platform":\(platform)},"state":{"token":"authored","pin":"","count":0},
     "storage":{"version":\(version),"keys":["state:count"],"secure":["state:token","state:pin"]\(auth)},
     "root":{"type":"text","text":"vault"}}
    """.utf8))
}
