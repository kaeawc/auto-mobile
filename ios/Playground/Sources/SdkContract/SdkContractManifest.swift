import AutoMobileSDK
import Foundation

/// One network event a scenario asked an SDK adapter to record, with the values it supplied.
/// A nil field is not asserted by the harness.
struct ExpectedNetworkEvent: Encodable, Equatable, Sendable {
    let caseName: String
    let url: String
    let method: String
    /// Nil for `URLProtocol` records, which carry no protocol name or direction.
    let protocolName: String?
    let direction: String?
    /// Known only for adapters whose `begin` returns the request id.
    let requestId: String?
    let connectionId: String?
    let statusCode: Int?
    let requestBodySize: Int?
    let responseBodySize: Int?
    let responseBody: String?
    let metadata: [String: String]?
    /// Request header names the SDK must report as `<redacted>`.
    let redactedRequestHeaders: [String]?
}

/// What the client saw for one fault case. The harness owns the rules and the expected outcome
/// (`scripts/ios/sdk-contract/faultSlice.ts`); Playground only runs the exchange and reports.
struct FaultCaseObservation: Encodable, Equatable, Sendable {
    let caseName: String
    let url: String
    let connectionId: String?
    let requestId: String?
    let elapsedMs: Double
    /// `<domain>:<code>`, or `posix:<code>` for an `NWError`; nil when the exchange completed.
    let clientError: String?
}

/// `AutoMobileNetwork.transportCapabilities()` before and after the host registered its transports.
struct CapabilityObservation: Encodable, Sendable {
    let beforeRegistration: [SdkCapabilityDescriptor]
    let afterRegistration: [SdkCapabilityDescriptor]
}

/// What a contract scenario fed the SDK and what the SDK serialized for it. The TypeScript
/// harness compares this with the MCP surface to name the boundary that disagreed.
struct SdkContractManifest: Encodable {
    static let currentSchemaVersion = 2

    enum Status: String, Encodable {
        /// The scenario ran to the end; the harness judges the captured events.
        case complete
        /// The fixture host could not run the scenario; `failure` says why.
        case failed
    }

    let schemaVersion = SdkContractManifest.currentSchemaVersion
    let runId: String
    let scenario: String
    var status: Status = .failed
    var failure: String?
    /// The bundle id the SDK put on the captured batches.
    var bundleId: String?
    var network: [ExpectedNetworkEvent] = []
    var faults: [FaultCaseObservation] = []
    var capabilities: CapabilityObservation?
    /// This run's SDK envelopes exactly as the SDK encoded them (payload is base64 JSON).
    var events: [SdkEventEnvelope] = []
    /// Batches the tap saw but could not decode with the public `SdkEventBatch` type.
    var undecodableBatches = 0

    init(runId: String, scenario: String) {
        self.runId = runId
        self.scenario = scenario
    }
}

enum SdkContractManifestWriter {
    static let directoryName = "sdk-contract"

    /// Writes `Documents/sdk-contract/<runId>.json` atomically, so the harness never reads a
    /// partial file.
    static func write(_ manifest: SdkContractManifest, fileManager: FileManager = .default) throws {
        let documents = try fileManager.url(
            for: .documentDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let directory = documents.appendingPathComponent(directoryName, isDirectory: true)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(manifest)
        try data.write(to: directory.appendingPathComponent("\(manifest.runId).json"), options: .atomic)
    }
}
