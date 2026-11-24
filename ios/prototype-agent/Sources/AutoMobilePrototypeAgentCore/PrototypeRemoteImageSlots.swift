/// All renderer configurations in the app share the same six-load budget.
actor PrototypeRemoteImageSlots {
    static let shared = PrototypeRemoteImageSlots()
    private var active = 0
    private var waiting: [CheckedContinuation<Void, Never>] = []
    private let onQueued: @Sendable () -> Void

    init(onQueued: @escaping @Sendable () -> Void = {}) { self.onQueued = onQueued }

    func perform<T: Sendable>(_ operation: @Sendable () async throws -> T) async throws -> T {
        if active >= PrototypeRemoteImages.maxLoads {
            await withCheckedContinuation {
                waiting.append($0)
                onQueued()
            }
        } else {
            active += 1
        }
        defer {
            if waiting.isEmpty { active -= 1 } else { waiting.removeFirst().resume() }
        }
        try Task.checkCancellation()
        return try await operation()
    }
}
