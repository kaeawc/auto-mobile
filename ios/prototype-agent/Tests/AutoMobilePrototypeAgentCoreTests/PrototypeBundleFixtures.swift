@testable import AutoMobilePrototypeAgentCore
import Foundation

/// Corpus JSON and archive base64 are decoded once, lazily, outside individual test timing.
enum PrototypeBundleFixtures {
    struct Corpus: Decodable, Sendable {
        let contractLimits: [String: Int]
        let caps: [String: Int]
        let errorCodes: [String]
        let cases: [Case]
    }

    struct Case: Decodable, Sendable {
        let name: String
        let expect: String
        let code: String?
        let path: String?
        let bundleBase64: Data
        let exportInputs: Export?
    }

    struct Export: Decodable, Sendable {
        let specBase64: Data
        let assets: [Asset]
        let fonts: [Asset]
        var input: PrototypeBundleExportInput {
            .init(spec: specBase64, assets: { id in
                assets.first { Data($0.id.utf8) == Data(id.utf8) }?.asset
            }, fonts: { id in fonts.first { Data($0.id.utf8) == Data(id.utf8) }?.asset })
        }
    }

    struct Asset: Decodable, Sendable {
        let id: String
        let mediaType: String
        let base64: Data
        var asset: PrototypeBundleAsset { .init(mediaType: mediaType, bytes: base64) }
    }

    static let corpus: Result<Corpus, Error> = Result {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        return try JSONDecoder().decode(Corpus.self, from: Data(
            contentsOf:
            root.appendingPathComponent("test/fixtures/prototype-bundle/corpus.json")
        ))
    }
}
