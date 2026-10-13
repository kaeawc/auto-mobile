import Foundation

public enum FlowTransport: Equatable {
    case stream, datagram
}

public struct ShapingRule: Equatable {
    public let ticket: NetworkRuleTicket
    public let profile: ShapingProfile

    public init(ticket: NetworkRuleTicket, profile: ShapingProfile) {
        self.ticket = ticket
        self.profile = profile
    }
}

/// Lock order is shaper lock, then rule source. Implementations must never call
/// back into the shaper. Nil means reset, expiry, or a non-shaping replacement.
public protocol ShapingRuleSource {
    func shapingRule(for target: NetworkRuleTarget) -> ShapingRule?
}

/// A timer token, not buffered payload. IDs never repeat during a shaper's life.
/// The caller owns timers and calls resume at or after the deadline.
public struct FlowPause: Equatable {
    public enum Phase: Equatable {
        case newFlow
        case data(FlowDirection)
    }

    public let flow: UUID
    public let id: UInt64
    public let resumeAtNanoseconds: UInt64
    public let phase: Phase
}

public enum NewFlowDecision: Equatable {
    case allow
    case filter(inbound: Bool, outbound: Bool, peekBytes: Int)
    case pause(FlowPause)
    case drop
}

public enum DataDecision: Equatable {
    case allow
    case pass(bytes: Int, peekBytes: Int)
    case pause(FlowPause)
    case drop
}

/// Resume verdicts cannot pause: re-pausing through a resume is unverified.
public enum ResumeDecision: Equatable {
    case allow
    case filter(inbound: Bool, outbound: Bool, peekBytes: Int)
    case pass(bytes: Int, peekBytes: Int)
}

public struct FlowSettlement: Equatable {
    public let pause: FlowPause
    public let decision: ResumeDecision
}

/// Counters belong to the current ticket and reset when that ticket changes.
/// A debt release is an immediate grant on replacement or while already paused.
public struct ShapingStatus: Codable, Equatable {
    public let target: NetworkRuleTarget
    public let owner: String
    public let ownerGeneration: UInt64
    public let revision: UInt64
    public var trackedFlows = 0
    public var pausedFlows = 0
    public var outboundReleasedBytes: UInt64 = 0
    public var inboundReleasedBytes: UInt64 = 0
    public var outboundHeldBursts: UInt64 = 0
    public var inboundHeldBursts: UInt64 = 0
    public var overBudgetDrops: UInt64 = 0
    public var refusedFlows: UInt64 = 0
    public var callbacksWhilePaused: UInt64 = 0
    public var debtReleases: UInt64 = 0
}
