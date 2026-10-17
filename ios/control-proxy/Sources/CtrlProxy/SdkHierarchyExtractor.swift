import AutoMobileSdkWire
import Foundation

public enum SdkHierarchyExtractor {
    /// Matches SDK's `SdkEventType.viewHierarchy.rawValue` (separate package, can't share the enum).
    private static let viewHierarchyEventType = "view_hierarchy"

    /// UTF-8 bytes of `viewHierarchyEventType`, used for the raw-buffer presence scan.
    private static let viewHierarchyEventTypeBytes = Data(viewHierarchyEventType.utf8)

    public static func extractIfPresent(
        from batchData: Data,
        into cache: any SdkHierarchyCaching,
        onHierarchyUpdated: (() -> Void)? = nil
    ) {
        // Fast path: skip full JSON decode if batch doesn't contain a hierarchy event.
        // Scan the raw UTF-8 bytes rather than allocating a whole-buffer String copy.
        guard batchData.range(of: viewHierarchyEventTypeBytes) != nil else { return }

        guard let batch = try? JSONDecoder().decode(SdkEventBatchEnvelope.self, from: batchData) else { return }

        var didUpdateHierarchy = false
        for event in batch.events where event.eventType == viewHierarchyEventType {
            if let hierarchy = try? JSONDecoder().decode(SdkViewHierarchyEventPayload.self, from: event.payload) {
                cache.update(hierarchy.hierarchy)
                didUpdateHierarchy = true
            }
        }
        if didUpdateHierarchy {
            onHierarchyUpdated?()
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
