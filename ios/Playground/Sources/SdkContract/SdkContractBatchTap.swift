import AutoMobileSDK
import Foundation

/// Records the SDK's own encoded event batches for one contract run.
///
/// `SdkEventBroadcaster` posts every encoded batch on this notification just before it
/// delivers the batch to CtrlProxy, so the tap sees the exact serialized bytes whether or not
/// delivery later succeeds. That separates an SDK serialization fault from a delivery fault.
final class SdkContractBatchTap: @unchecked Sendable {
    static let notificationName = Notification.Name("dev.jasonpearson.automobile.sdk.EVENT_BATCH")
    static let userInfoKey = "eventBatch"

    struct Snapshot {
        let bundleId: String?
        let events: [SdkEventEnvelope]
        let undecodableBatches: Int
    }

    private let lock = NSLock()
    private let belongsToRun: @Sendable (SdkEventEnvelope) -> Bool
    private var observer: NSObjectProtocol?
    private var bundleId: String?
    private var events: [SdkEventEnvelope] = []
    private var undecodableBatches = 0

    init(belongsToRun: @escaping @Sendable (SdkEventEnvelope) -> Bool) {
        self.belongsToRun = belongsToRun
    }

    /// Matches network events whose URL carries the run's `/contract/<runId>/` path.
    static func networkEvents(forRun runId: String) -> @Sendable (SdkEventEnvelope) -> Bool {
        let marker = "/contract/\(runId)/"
        return { envelope in
            SdkContractBatchTap.networkPayloadURL(envelope)?.contains(marker) == true
        }
    }

    static func networkPayloadURL(_ envelope: SdkEventEnvelope) -> String? {
        guard envelope.eventType == .networkRequest,
              let object = try? JSONSerialization.jsonObject(with: envelope.payload) as? [String: Any]
        else {
            return nil
        }
        return object["url"] as? String
    }

    func start() {
        observer = NotificationCenter.default.addObserver(
            forName: Self.notificationName,
            object: nil,
            queue: nil
        ) { [weak self] notification in
            self?.receive(notification)
        }
    }

    func stop() {
        if let observer {
            NotificationCenter.default.removeObserver(observer)
        }
        observer = nil
    }

    func snapshot() -> Snapshot {
        lock.lock()
        defer { lock.unlock() }
        return Snapshot(bundleId: bundleId, events: events, undecodableBatches: undecodableBatches)
    }

    private func receive(_ notification: Notification) {
        guard let data = notification.userInfo?[Self.userInfoKey] as? Data else { return }
        guard let batch = try? JSONDecoder().decode(SdkEventBatch.self, from: data) else {
            lock.lock()
            undecodableBatches += 1
            lock.unlock()
            return
        }
        let matching = batch.events.filter(belongsToRun)
        guard !matching.isEmpty else { return }
        lock.lock()
        defer { lock.unlock() }
        bundleId = batch.bundleId
        events.append(contentsOf: matching)
    }
}
