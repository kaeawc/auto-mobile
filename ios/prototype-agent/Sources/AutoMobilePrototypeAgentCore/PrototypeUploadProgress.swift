/// Pure progress state: only the request that last reset a key may advance it. The injected clock
/// is read by the driver, never here. Serial delegate callbacks may reach the main actor out of
/// order; this high-water guard also drops old ticks and per-hop byte-counter restarts.
struct PrototypeUploadProgress {
    private struct Entry {
        let requestId: String
        var value = 0
        var lastWriteMs: Int
    }

    private var entries: [String: Entry] = [:]

    mutating func reset(key: String, requestId: String, nowMs: Int) -> Int {
        entries[key] = Entry(requestId: requestId, lastWriteMs: nowMs)
        return 0
    }

    mutating func advance(key: String, requestId: String, value: Int, nowMs: Int, completed: Bool = false) -> Int? {
        guard var entry = entries[key], entry.requestId == requestId else { return nil }
        let value = min(100, max(0, value))
        guard completed || (value > entry.value && nowMs - entry.lastWriteMs >= 100) else { return nil }
        entry.value = value
        entry.lastWriteMs = nowMs
        entries[key] = entry
        return value
    }

    mutating func finish(key: String, requestId: String) {
        if entries[key]?.requestId == requestId { entries[key] = nil }
    }
}
