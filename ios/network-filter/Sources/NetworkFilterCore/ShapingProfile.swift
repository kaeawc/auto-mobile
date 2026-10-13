import Foundation

/// Upload is app → remote; download is remote → app.
public enum FlowDirection: String, Codable {
    case inbound, outbound
}

public enum ShapingComponent: String, Codable {
    case latency, downloadBandwidth, uploadBandwidth, packetLoss
}

/// Host units: added round-trip milliseconds and decimal kilobits (1000 bits)
/// per second, both integral to match profile units. Zero rates mean unlimited.
/// Loss accepts fractional percentages and is reported, never emulated.
public struct ShapingRequest: Equatable {
    public let delayMilliseconds: UInt64
    public let downloadKilobitsPerSecond: UInt64
    public let uploadKilobitsPerSecond: UInt64
    public let packetLossPercent: Double

    public init(
        delayMilliseconds: UInt64 = 0,
        downloadKilobitsPerSecond: UInt64 = 0,
        uploadKilobitsPerSecond: UInt64 = 0,
        packetLossPercent: Double = 0
    ) {
        self.delayMilliseconds = delayMilliseconds
        self.downloadKilobitsPerSecond = downloadKilobitsPerSecond
        self.uploadKilobitsPerSecond = uploadKilobitsPerSecond
        self.packetLossPercent = packetLossPercent
    }
}

public enum ShapingRejection: Error, Equatable {
    case outOfRange(ShapingComponent)
    case nothingToApply(unapplied: [ShapingComponent])
}

public struct ShapingResolution: Equatable {
    public let profile: ShapingProfile
    public let applied: [ShapingComponent]
    public let unapplied: [ShapingComponent]
}

/// Explicit directional burst-start delays (0...2000 ms) and app-aggregate
/// rates (1000...125000000 bytes/s, nil = unlimited). A continuous transfer is
/// shifted once, not per chunk. Loss cannot be represented by this profile.
public struct ShapingProfile: Codable, Equatable {
    public let outboundDelayMilliseconds: UInt64
    public let inboundDelayMilliseconds: UInt64
    public let outboundBytesPerSecond: UInt64?
    public let inboundBytesPerSecond: UInt64?

    public init?(
        outboundDelayMilliseconds: UInt64 = 0,
        inboundDelayMilliseconds: UInt64 = 0,
        outboundBytesPerSecond: UInt64? = nil,
        inboundBytesPerSecond: UInt64? = nil
    ) {
        guard outboundDelayMilliseconds <= 2000, inboundDelayMilliseconds <= 2000,
              [outboundBytesPerSecond, inboundBytesPerSecond].allSatisfy({ rate in
                  rate.map { (1000 ... 125_000_000).contains($0) } ?? true
              }),
              outboundDelayMilliseconds > 0 || inboundDelayMilliseconds > 0 ||
              outboundBytesPerSecond != nil || inboundBytesPerSecond != nil
        else { return nil }
        self.outboundDelayMilliseconds = outboundDelayMilliseconds
        self.inboundDelayMilliseconds = inboundDelayMilliseconds
        self.outboundBytesPerSecond = outboundBytesPerSecond
        self.inboundBytesPerSecond = inboundBytesPerSecond
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard let profile = try ShapingProfile(
            outboundDelayMilliseconds: container.decode(UInt64.self, forKey: .outboundDelayMilliseconds),
            inboundDelayMilliseconds: container.decode(UInt64.self, forKey: .inboundDelayMilliseconds),
            outboundBytesPerSecond: container.decodeIfPresent(UInt64.self, forKey: .outboundBytesPerSecond),
            inboundBytesPerSecond: container.decodeIfPresent(UInt64.self, forKey: .inboundBytesPerSecond)
        ) else {
            throw DecodingError.dataCorrupted(.init(
                codingPath: decoder.codingPath,
                debugDescription: "A shaping profile needs an effect and valid directional delays and byte rates"
            ))
        }
        self = profile
    }

    public func shapes(_ direction: FlowDirection) -> Bool {
        delayNanoseconds(direction) > 0 || rate(direction) != nil
    }

    /// Odd round-trip delays put the extra millisecond on upload. A content
    /// filter drop is not packet loss; unsupported loss remains explicitly unapplied.
    public static func resolve(_ request: ShapingRequest) -> Result<ShapingResolution, ShapingRejection> {
        guard request.delayMilliseconds <= 4000 else { return .failure(.outOfRange(.latency)) }
        guard validKilobits(request.downloadKilobitsPerSecond) else {
            return .failure(.outOfRange(.downloadBandwidth))
        }
        guard validKilobits(request.uploadKilobitsPerSecond) else {
            return .failure(.outOfRange(.uploadBandwidth))
        }
        guard request.packetLossPercent.isFinite, (0 ... 100).contains(request.packetLossPercent) else {
            return .failure(.outOfRange(.packetLoss))
        }
        let unapplied: [ShapingComponent] = request.packetLossPercent > 0 ? [.packetLoss] : []
        guard let profile = ShapingProfile(
            outboundDelayMilliseconds: (request.delayMilliseconds + 1) / 2,
            inboundDelayMilliseconds: request.delayMilliseconds / 2,
            outboundBytesPerSecond: request.uploadKilobitsPerSecond == 0 ? nil : request.uploadKilobitsPerSecond * 125,
            inboundBytesPerSecond: request.downloadKilobitsPerSecond == 0 ? nil : request
                .downloadKilobitsPerSecond * 125
        ) else { return .failure(.nothingToApply(unapplied: unapplied)) }
        var applied: [ShapingComponent] = []
        if request.delayMilliseconds > 0 { applied.append(.latency) }
        if request.downloadKilobitsPerSecond > 0 { applied.append(.downloadBandwidth) }
        if request.uploadKilobitsPerSecond > 0 { applied.append(.uploadBandwidth) }
        return .success(ShapingResolution(profile: profile, applied: applied, unapplied: unapplied))
    }

    func rate(_ direction: FlowDirection) -> UInt64? {
        direction == .outbound ? outboundBytesPerSecond : inboundBytesPerSecond
    }

    func delayNanoseconds(_ direction: FlowDirection) -> UInt64 {
        (direction == .outbound ? outboundDelayMilliseconds : inboundDelayMilliseconds) * 1_000_000
    }

    var quietGapNanoseconds: UInt64 {
        [outboundDelayMilliseconds, inboundDelayMilliseconds].filter { $0 > 0 }.min().map { $0 * 1_000_000 } ?? 0
    }

    func quantum(_ direction: FlowDirection) -> Int {
        rate(direction).map { Int(min(1_048_576, max(1, $0 / 10))) } ?? 65536
    }

    private static func validKilobits(_ rate: UInt64) -> Bool {
        rate == 0 || (8 ... 1_000_000).contains(rate)
    }
}
