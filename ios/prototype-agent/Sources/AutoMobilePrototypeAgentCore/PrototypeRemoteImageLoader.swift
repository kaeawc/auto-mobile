import Foundation
import ImageIO

/// Immutable decoded pixels can cross the loader actor boundary.
final class PrototypeRemoteImage: NSObject, @unchecked Sendable {
    let image: CGImage
    var decodedBytes: Int { image.bytesPerRow * image.height }

    init(bytes: Data) throws {
        let prefix = Array(bytes.prefix(12))
        let png = prefix.starts(with: [137, 80, 78, 71, 13, 10, 26, 10])
        let jpeg = prefix.starts(with: [255, 216, 255])
        let webp = prefix.count == 12 && prefix.prefix(4).elementsEqual("RIFF".utf8) &&
            prefix.suffix(4).elementsEqual("WEBP".utf8)
        guard bytes.count <= PrototypeRemoteImages.maxDownloadBytes, png || jpeg || webp,
              let source = CGImageSourceCreateWithData(
                  bytes as CFData,
                  [kCGImageSourceShouldCache: false] as CFDictionary
              ),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
              let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
              // Reject decompression bombs from the header before any pixels are allocated.
              PrototypeRemoteImages.fitsDecodeBudget(
                  width: width.doubleValue, height: height.doubleValue,
                  depth: (properties[kCGImagePropertyDepth] as? NSNumber)?.intValue
              ),
              // The thumbnail path applies the EXIF orientation and bounds the decoded edge.
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceCreateThumbnailWithTransform: true,
                  kCGImageSourceThumbnailMaxPixelSize: PrototypeRemoteImages.maxDecodedEdge,
                  kCGImageSourceShouldCacheImmediately: true,
              ] as CFDictionary), image.height > 0,
              image.bytesPerRow <= PrototypeRemoteImages.maxIOSMemoryBytes / image.height
        else { throw PrototypeRemoteImageLoader.Failure.invalidImage }
        self.image = image
    }
}

/// Loads bounded image responses through the configured HTTP transport.
actor PrototypeRemoteImageLoader {
    enum Failure: Error { case invalidImage, disabled }

    static let shared = PrototypeRemoteImageLoader(development: PrototypeRemoteImages.developmentLoopback)
    private let client: any PrototypeHttpClient
    private let egress: PrototypeRequestEgressCheck
    private let gate: PrototypeLibraryNetworkGate?
    private let memory: PrototypeRemoteImageMemory
    private var disk: PrototypeRemoteImageDiskCache
    private let slots: PrototypeRemoteImageSlots

    init(
        client: (any PrototypeHttpClient)? = nil,
        slots: PrototypeRemoteImageSlots = .shared,
        memory: PrototypeRemoteImageMemory = .shared,
        development: Bool = false,
        resolver: any HostResolving = PrototypeSystemHostResolver(),
        gate: PrototypeLibraryNetworkGate? = nil,
        onLocalNetworkDenied: @escaping @MainActor @Sendable (PrototypeConsentEpoch) -> Void = { _ in },
        directory: URL? = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("AutoMobilePrototypeRemoteImages", isDirectory: true),
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        // A runtime flag never enables image loopback in a build without the development flag.
        let development = development && PrototypeRemoteImages.developmentLoopback
        let imageEgress = PrototypeRequestEgressCheck(
            policy: PrototypeEgressPolicy(), resolver: resolver, remoteImageDevelopment: development
        )
        let transport: any PrototypeHttpClient
        if let client {
            transport = client
        } else {
            #if canImport(Network)
                // Dial only the checked addresses; URLSession would re-resolve after the preflight.
                // Image requests carry isRemoteImage, so every redirect hop keeps the image egress.
                transport = PrototypePinnedHttpClient(resolver: resolver, allowsCleartext: development)
            #else
                transport = PrototypeURLSessionClient(remoteImageDevelopment: development, resolver: resolver)
            #endif
        }
        if let gate {
            self.client = PrototypeLibraryGatedClient(gate: gate, factory: { _ in
                PrototypeNetworkConfiguration(device: transport)
            }, onLocalNetworkDenied: onLocalNetworkDenied)
        } else {
            self.client = transport
        }
        self.memory = memory
        self.slots = slots
        self.gate = gate
        egress = imageEgress
        disk = PrototypeRemoteImageDiskCache(directory: directory, now: now)
    }

    func load(
        _ resolvedURL: String, delivery: PrototypeDeliveryCheck = PrototypeDeliveryCheck()
    )
        async throws -> PrototypeRemoteImage
    {
        // Validate after all renderer bindings, even on cache hits. No URL enters diagnostics.
        try egress.validateImageURL(resolvedURL)
        let epoch = gate?.snapshot()
        if gate != nil, epoch == nil { throw Failure.disabled }
        if let gate, let epoch {
            delivery.bind(isCurrent: { gate.permits(epoch) }, obsolete: PrototypeLibraryGatedClient.disabled)
        }
        return try await slots.perform { try await self.fetch(resolvedURL, epoch: epoch) }
    }

    private func fetch(_ resolvedURL: String, epoch: PrototypeConsentEpoch?) async throws -> PrototypeRemoteImage {
        try Task.checkCancellation()
        if let gate, let epoch, !gate.permits(epoch) { throw Failure.disabled }
        if let cached = memory.get(resolvedURL) {
            disk.touch(resolvedURL)
            return cached
        }
        if let bytes = disk.read(resolvedURL), let decoded = try? PrototypeRemoteImage(bytes: bytes) {
            memory.put(decoded, url: resolvedURL)
            return decoded
        }
        let request = PrototypeHttpRequest(job: PrototypeRequestJob(
            requestId: "image", prototypeId: "image", via: .device, method: .get,
            url: resolvedURL, headers: [:], body: nil, timeoutMs: 30000
        ), maxResponseBytes: PrototypeRemoteImages.maxDownloadBytes, isRemoteImage: true)
        // The transport owns DNS preflight inside its total deadline, including every redirect.
        let response = try await client.perform(request)
        try Task.checkCancellation()
        if let gate, let epoch, !gate.permits(epoch) { throw Failure.disabled }
        guard (200 ... 299).contains(response.status) else { throw Failure.invalidImage }
        let decoded = try PrototypeRemoteImage(bytes: response.body)
        memory.put(decoded, url: resolvedURL)
        disk.write(response.body, url: resolvedURL)
        return decoded
    }
}
