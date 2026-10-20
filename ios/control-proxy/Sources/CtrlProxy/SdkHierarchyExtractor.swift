import AutoMobileSdkWire
import Foundation
import os

public enum SdkHierarchyExtractor {
    /// Matches SDK's `SdkEventType.viewHierarchy.rawValue` (separate package, can't share the enum).
    private static let viewHierarchyEventType = "view_hierarchy"

    /// UTF-8 bytes of `viewHierarchyEventType`, used for the raw-buffer presence scan.
    private static let viewHierarchyEventTypeBytes = Data(viewHierarchyEventType.utf8)

    public static func extractIfPresent(
        from batchData: Data,
        into cache: any SdkHierarchyCaching,
        onHierarchyUpdated: (() -> Void)? = nil,
        warn: (String) -> Void = SdkHierarchyExtractor.logWarning
    ) {
        // Fast path: skip full JSON decode if batch doesn't contain a hierarchy event.
        // Scan the raw UTF-8 bytes rather than allocating a whole-buffer String copy.
        guard batchData.contains(viewHierarchyEventTypeBytes) else { return }

        let batch: SdkEventBatchEnvelope
        do {
            batch = try JSONDecoder().decode(SdkEventBatchEnvelope.self, from: batchData)
        } catch {
            // Envelope drift must not look like "no hierarchy" (#13319).
            warn("SDK event batch envelope undecodable: \(String(describing: error))")
            return
        }

        var didUpdateHierarchy = false
        for entry in batch.events {
            let event: SdkEventEnvelopeEntry
            switch entry {
            case let .success(decoded): event = decoded
            case let .failure(error):
                // One malformed entry must not hide a valid later event in the same batch.
                warn("SDK event envelope entry undecodable: \(String(describing: error))")
                continue
            }
            guard event.eventType == viewHierarchyEventType else { continue }
            do {
                let payload = try JSONDecoder().decode(SdkViewHierarchyEventPayload.self, from: event.payload)
                cache.update(payload.hierarchy)
                didUpdateHierarchy = true
            } catch {
                // A decode failure means SDK/runner wire drift; do not let it look like "no hierarchy".
                // DecodingError's description includes its case, coding path and missing key.
                warn("SDK hierarchy event undecodable: \(String(describing: error))")
            }
        }
        if didUpdateHierarchy {
            onHierarchyUpdated?()
        }
    }

    public static func logWarning(_ message: String) {
        Logger(subsystem: "dev.jasonpearson.automobile", category: "SdkHierarchyExtractor")
            .warning("\(message, privacy: .public)")
    }
}

// MARK: - Minimal Decodable types for batch extraction

/// Mirrors SDK's `SdkEventBatch` just enough to extract hierarchy events.
struct SdkEventBatchEnvelope: Decodable {
    let events: [Result<SdkEventEnvelopeEntry, Error>]

    enum CodingKeys: String, CodingKey { case events }

    init(from decoder: Decoder) throws {
        var list = try decoder.container(keyedBy: CodingKeys.self).nestedUnkeyedContainer(forKey: .events)
        var entries: [Result<SdkEventEnvelopeEntry, Error>] = []
        while !list.isAtEnd {
            // A failed element decode does not advance the container; decode a placeholder to skip it.
            do {
                try entries.append(.success(list.decode(SdkEventEnvelopeEntry.self)))
            } catch {
                _ = try list.decode(SdkSkippedElement.self)
                entries.append(.failure(error))
            }
        }
        events = entries
    }
}

private struct SdkSkippedElement: Decodable {
    init(from _: Decoder) throws {}
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
