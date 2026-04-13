import Foundation

/// Thread-safe cache holding the latest SDK view hierarchy received from the target app.
/// Updated when the SDK POSTs hierarchy events via `/sdk-events`.
public final class SdkHierarchyCache: SdkHierarchyCaching, @unchecked Sendable {
    private let lock = NSLock()
    private var _latest: SdkViewHierarchy?

    public var latest: SdkViewHierarchy? {
        lock.lock()
        defer { lock.unlock() }
        return _latest
    }

    public func update(_ hierarchy: SdkViewHierarchy) {
        lock.lock()
        _latest = hierarchy
        lock.unlock()
    }

    public func clear() {
        lock.lock()
        _latest = nil
        lock.unlock()
    }
}

// MARK: - Extraction from SDK Event Batches

/// Extracts `view_hierarchy` events from SDK event batches POSTed to `/sdk-events`
/// and updates the provided hierarchy cache.
public enum SdkHierarchyExtractor {

    /// Matches SDK's `SdkEventType.viewHierarchy.rawValue` (separate package, can't share the enum).
    private static let viewHierarchyEventType = "view_hierarchy"

    /// Try to extract a view hierarchy event from the raw batch data.
    /// Called on every `POST /sdk-events` — skips full decode when no hierarchy event is present.
    public static func extractIfPresent(from batchData: Data, into cache: any SdkHierarchyCaching) {
        // Fast path: skip full JSON decode if batch doesn't contain a hierarchy event
        guard let jsonString = String(data: batchData, encoding: .utf8),
              jsonString.contains(viewHierarchyEventType) else { return }

        guard let batch = try? JSONDecoder().decode(SdkEventBatchEnvelope.self, from: batchData) else { return }

        for event in batch.events where event.eventType == viewHierarchyEventType {
            if let hierarchy = try? JSONDecoder().decode(SdkViewHierarchyEventPayload.self, from: event.payload) {
                cache.update(hierarchy.hierarchy)
            }
        }
    }
}

// MARK: - Minimal Decodable types for batch extraction

/// Mirrors SDK's `SdkEventBatch` just enough to extract hierarchy events.
struct SdkEventBatchEnvelope: Decodable {
    let events: [SdkEventEnvelopeEntry]
}

struct SdkEventEnvelopeEntry: Decodable {
    let eventType: String
    let payload: Data

    enum CodingKeys: String, CodingKey {
        case eventType, payload
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        eventType = try container.decode(String.self, forKey: .eventType)
        // payload is base64-encoded Data in JSON
        payload = try container.decode(Data.self, forKey: .payload)
    }
}

/// Mirrors SDK's `SdkViewHierarchyEvent` to extract the hierarchy payload.
struct SdkViewHierarchyEventPayload: Decodable {
    let hierarchy: SdkViewHierarchy
}
