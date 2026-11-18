import Foundation

/// Model-owned, deliberately outside registry membership/capabilities. A task chain is a
/// non-reentrant controller lock: every operation awaits its predecessor through sink suspension.
/// Lifecycle entry points only POST, so synchronous runtime mutations never acquire that lock.
@MainActor
final class PrototypeRealtimeModule: PrototypePlatformModule {
    let name = "realtime"
    let capability = "prototype_platform_realtime_v1"
    let state: [String: JSONValue] = [:]
    var events: AsyncStream<PlatformEvent> { AsyncStream { $0.finish() } }
    private let config: PrototypeRealtimeConfig
    private let sink: PrototypeChannelSink
    private let clock: any PrototypeClock
    private var controller: PrototypeChannelController?
    private var tail: Task<Void, Never>?
    private var owner = 0
    private var prototypeID: String?
    var onError: (Error) -> Void = { error in
        NSLog("Prototype realtime action failed: %@", String(describing: error))
    }

    init(config: PrototypeRealtimeConfig, sink: PrototypeChannelSink, clock: any PrototypeClock) {
        self.config = config
        self.sink = sink
        self.clock = clock
    }

    func availability() -> PlatformAvailability { .ready }

    func begin(prototypeID: String) {
        if self.prototypeID == prototypeID, controller?.closing == false { return }
        self.prototypeID = prototypeID
        close()
        owner += 1
        let generation = owner
        let parent = sink
        let scoped = PrototypeChannelSink(
            exclusively: parent.exclusively,
            isCurrent: { [weak self] channel in
                self?.owner == generation && self?.controller?.closing == false &&
                    parent.isCurrent(channel)
            },
            apply: parent.apply
        )
        let next = PrototypeChannelController(prototypeID: prototypeID, config: config, sink: scoped, clock: clock)
        next.post = { [weak self] work in self?.post(work) }
        controller = next
    }

    func update(_ channels: [String: JSONValue]) {
        guard let controller else { return }
        post { try await controller.update(channels) }
    }

    func show() {
        guard let controller else { return }
        post { try await controller.show() }
    }

    func close() {
        guard let controller else { return }
        controller.beginClose()
        post { controller.close() }
    }

    private func post(_ work: @escaping @MainActor () async throws -> Void) {
        let previous = tail
        tail = Task { [weak self] in
            await previous?.value
            do { try await work() }
            catch { self?.onError(error) }
        }
    }

    func call(_ call: PlatformCall) async -> PlatformCallResult {
        guard !Task.isCancelled, let controller, !controller.closing else {
            return .failure(.cancelled, "The channels are closed")
        }
        let previous = tail
        let queued = Task { [weak self] in
            await previous?.value
            // Cancellation of the CALLER (including a driver deadline) cancels this task while it
            // waits for the inbox. Check here, not just before enqueueing.
            guard !Task.isCancelled else { return PlatformCallResult.failure(.cancelled, "Call cancelled") }
            do { return try await controller.call(call) }
            catch {
                self?.onError(error)
                return .failure(.platformError, String(describing: error))
            }
        }
        tail = Task { _ = await queued.value }
        return await withTaskCancellationHandler {
            await queued.value
        } onCancel: {
            queued.cancel()
        }
    }

    /// Deterministic test/drain barrier; include callbacks posted by earlier operations.
    func settled() async {
        var previous = tail
        await previous?.value
        // Operations can enqueue callbacks synchronously (e.g. transport.open). Insert a barrier
        // after them, rather than waiting on timers that have not fired.
        previous = tail
        await previous?.value
    }
}
