import Foundation

/// Monotonic time in nanoseconds, behind a seam so lease logic is tested with a
/// fake clock.
public protocol MonotonicClock {
    func nowNanoseconds() -> UInt64
}

/// `CLOCK_MONOTONIC` on Darwin keeps counting while the Mac sleeps and never
/// jumps with wall-clock changes. A lease that elapses during sleep is therefore
/// already expired on wake: the next flow or command sweeps it.
public struct SystemMonotonicClock: MonotonicClock {
    public init() {}

    public func nowNanoseconds() -> UInt64 {
        clock_gettime_nsec_np(CLOCK_MONOTONIC)
    }
}

/// Installed configuration: only offline participates in drop evaluation.
public enum NetworkRuleCondition: Equatable {
    case offline
    case shaped(ShapingProfile)
}

/// Requests remain unresolved until the provider validates them. Keeping this
/// distinct from installed conditions permits typed rejection of invalid profiles.
public enum NetworkRuleCommandCondition: Equatable {
    case offline
    case shaped(ShapingRequest)
}

private enum RuleWireCondition: String, Codable {
    case offline, shaped
}

/// One app on one managed simulator. The bundle identifier only selects flows
/// that the resolver already attributed to `simulator`, so the same bundle on a
/// sibling simulator, or a native Mac app with that identifier, never matches.
public struct NetworkRuleTarget: Codable, Hashable {
    public static let maximumBundleIdLength = 255

    public let simulator: ManagedSimulator
    public let bundleId: String

    public init?(simulator: ManagedSimulator, bundleId: String) {
        guard Self.isValid(bundleId: bundleId) else { return nil }
        self.simulator = simulator
        self.bundleId = bundleId
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let simulator = try container.decode(ManagedSimulator.self, forKey: .simulator)
        let bundleId = try container.decode(String.self, forKey: .bundleId)
        guard let value = NetworkRuleTarget(simulator: simulator, bundleId: bundleId) else {
            throw DecodingError.dataCorrupted(.init(
                codingPath: decoder.codingPath,
                debugDescription: "A rule target needs a bundle identifier of letters, digits, '.', '-' or '_'"
            ))
        }
        self = value
    }

    static func isValid(bundleId: String) -> Bool {
        !bundleId.isEmpty && bundleId.utf8.count <= maximumBundleIdLength && bundleId.utf8.allSatisfy { byte in
            (48 ... 57).contains(byte) || (65 ... 90).contains(byte) || (97 ... 122).contains(byte) ||
                byte == 45 || byte == 46 || byte == 95
        }
    }
}

/// Who asked for a rule. `owner` is the host session; `ownerGeneration` changes
/// whenever that session's binding is replaced; `revision` increases with every
/// command the owner sends for a target within one generation.
public struct NetworkRuleOwnership: Codable, Equatable {
    public static let maximumOwnerLength = 128

    public let owner: String
    public let ownerGeneration: UInt64
    public let revision: UInt64

    public init?(owner: String, ownerGeneration: UInt64, revision: UInt64) {
        guard !owner.isEmpty, owner.utf8.count <= Self.maximumOwnerLength, revision > 0 else { return nil }
        self.owner = owner
        self.ownerGeneration = ownerGeneration
        self.revision = revision
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard let value = try NetworkRuleOwnership(
            owner: container.decode(String.self, forKey: .owner),
            ownerGeneration: container.decode(UInt64.self, forKey: .ownerGeneration),
            revision: container.decode(UInt64.self, forKey: .revision)
        ) else {
            throw DecodingError.dataCorrupted(.init(
                codingPath: decoder.codingPath,
                debugDescription: "An owner needs a non-empty name of at most 128 bytes and a revision above 0"
            ))
        }
        self = value
    }
}

public enum NetworkRuleCommandKind: String, Codable, CaseIterable {
    case apply
    case reset
    case renew
}

public struct NetworkRuleCommand: Codable, Equatable {
    public let kind: NetworkRuleCommandKind
    public let target: NetworkRuleTarget
    public let ownership: NetworkRuleOwnership
    /// `apply` only.
    public let condition: NetworkRuleCommandCondition?
    /// `apply` and `renew`.
    public let leaseMilliseconds: UInt64?

    public init(
        kind: NetworkRuleCommandKind,
        target: NetworkRuleTarget,
        ownership: NetworkRuleOwnership,
        condition: NetworkRuleCommandCondition? = nil,
        leaseMilliseconds: UInt64? = nil
    ) {
        self.kind = kind
        self.target = target
        self.ownership = ownership
        self.condition = condition
        self.leaseMilliseconds = leaseMilliseconds
    }

    private enum CodingKeys: String, CodingKey {
        case kind, target, ownership, condition, shaping, leaseMilliseconds
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = try container.decode(NetworkRuleCommandKind.self, forKey: .kind)
        target = try container.decode(NetworkRuleTarget.self, forKey: .target)
        ownership = try container.decode(NetworkRuleOwnership.self, forKey: .ownership)
        leaseMilliseconds = try container.decodeIfPresent(UInt64.self, forKey: .leaseMilliseconds)
        switch try container.decodeIfPresent(RuleWireCondition.self, forKey: .condition) {
        case .offline: condition = .offline
        case .shaped: condition = try .shaped(container.decode(ShapingRequest.self, forKey: .shaping))
        case nil: condition = nil
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(kind, forKey: .kind)
        try container.encode(target, forKey: .target)
        try container.encode(ownership, forKey: .ownership)
        try container.encodeIfPresent(leaseMilliseconds, forKey: .leaseMilliseconds)
        switch condition {
        case .offline: try container.encode(RuleWireCondition.offline, forKey: .condition)
        case let .shaped(request):
            try container.encode(RuleWireCondition.shaped, forKey: .condition)
            try container.encode(request, forKey: .shaping)
        case nil: break
        }
    }
}

/// The provider's answer to one command. Every value is definitive: an uncertain
/// IPC result never reaches this type, and the host reconciles it with `status`.
public enum NetworkRuleOutcome: String, Codable {
    case applied
    case reset
    case renewed
    /// The owner already moved to a newer generation for this target.
    case staleGeneration = "stale_generation"
    /// The owner already installed or reset a newer revision for this target.
    case staleRevision = "stale_revision"
    /// Another session holds an active rule for this target. It was not changed.
    case ownedByAnotherSession = "owned_by_another_session"
    /// `renew`: no active rule for this owner (it expired, was reset, or the provider restarted).
    case notFound = "not_found"
    case invalidLease = "invalid_lease"
    case invalidCommand = "invalid_command"
    case capacityExceeded = "capacity_exceeded"
    case unsupportedCondition = "unsupported_condition"
    case invalidShaping = "invalid_shaping"
}

/// Explicit units and components survive rejection without installing a rule.
public struct NetworkShapingRejection: Codable, Equatable {
    public enum Reason: String, Codable {
        case outOfRange = "out_of_range"
        case nothingToApply = "nothing_to_apply"
    }

    public let reason: Reason
    public let component: ShapingComponent?
    public let unapplied: [ShapingComponent]?

    public init(_ rejection: ShapingRejection) {
        switch rejection {
        case let .outOfRange(component):
            reason = .outOfRange
            self.component = component
            unapplied = nil
        case let .nothingToApply(unapplied):
            reason = .nothingToApply
            component = nil
            self.unapplied = unapplied
        }
    }
}

public struct NetworkRuleResult: Codable, Equatable {
    public let outcome: NetworkRuleOutcome
    /// The revision now installed for this target by the same owner and generation, if any.
    public let installedRevision: UInt64?
    public let leaseRemainingMilliseconds: UInt64?
    public let shaping: ShapingResolution?
    public let rejection: NetworkShapingRejection?

    public init(
        outcome: NetworkRuleOutcome,
        installedRevision: UInt64? = nil,
        leaseRemainingMilliseconds: UInt64? = nil,
        shaping: ShapingResolution? = nil,
        rejection: NetworkShapingRejection? = nil
    ) {
        self.outcome = outcome
        self.installedRevision = installedRevision
        self.leaseRemainingMilliseconds = leaseRemainingMilliseconds
        self.shaping = shaping
        self.rejection = rejection
    }
}

/// An active rule as the provider reports it in a snapshot.
public struct NetworkRuleStatus: Codable, Equatable {
    public let target: NetworkRuleTarget
    public let owner: String
    public let ownerGeneration: UInt64
    public let revision: UInt64
    public let condition: NetworkRuleCondition
    public let leaseRemainingMilliseconds: UInt64
    public let droppedFlows: UInt64
    public let shaping: ShapingResolution?

    public init(
        target: NetworkRuleTarget, owner: String, ownerGeneration: UInt64, revision: UInt64,
        condition: NetworkRuleCondition, leaseRemainingMilliseconds: UInt64, droppedFlows: UInt64,
        shaping: ShapingResolution? = nil
    ) {
        self.target = target
        self.owner = owner
        self.ownerGeneration = ownerGeneration
        self.revision = revision
        self.condition = condition
        self.leaseRemainingMilliseconds = leaseRemainingMilliseconds
        self.droppedFlows = droppedFlows
        self.shaping = shaping
    }

    private enum CodingKeys: String, CodingKey {
        case target, owner, ownerGeneration, revision, condition, leaseRemainingMilliseconds, droppedFlows, shaping
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        target = try container.decode(NetworkRuleTarget.self, forKey: .target)
        owner = try container.decode(String.self, forKey: .owner)
        ownerGeneration = try container.decode(UInt64.self, forKey: .ownerGeneration)
        revision = try container.decode(UInt64.self, forKey: .revision)
        leaseRemainingMilliseconds = try container.decode(UInt64.self, forKey: .leaseRemainingMilliseconds)
        droppedFlows = try container.decode(UInt64.self, forKey: .droppedFlows)
        switch try container.decode(RuleWireCondition.self, forKey: .condition) {
        case .offline:
            condition = .offline
            shaping = nil
        case .shaped:
            let resolution = try container.decode(ShapingResolution.self, forKey: .shaping)
            condition = .shaped(resolution.profile)
            shaping = resolution
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(target, forKey: .target)
        try container.encode(owner, forKey: .owner)
        try container.encode(ownerGeneration, forKey: .ownerGeneration)
        try container.encode(revision, forKey: .revision)
        try container.encode(leaseRemainingMilliseconds, forKey: .leaseRemainingMilliseconds)
        try container.encode(droppedFlows, forKey: .droppedFlows)
        switch condition {
        case .offline: try container.encode(RuleWireCondition.offline, forKey: .condition)
        case let .shaped(profile):
            guard let shaping, shaping.profile == profile else {
                throw EncodingError.invalidValue(condition, .init(
                    codingPath: encoder.codingPath, debugDescription: "Shaped status needs its resolution"
                ))
            }
            try container.encode(RuleWireCondition.shaped, forKey: .condition)
            try container.encode(shaping, forKey: .shaping)
        }
    }
}

/// Identifies the exact rule a pending verdict was computed against. A delayed
/// decision only takes effect while its ticket is still current.
public struct NetworkRuleTicket: Equatable {
    public let target: NetworkRuleTarget
    public let owner: String
    public let ownerGeneration: UInt64
    public let revision: UInt64
}

/// Active rules at one instant, for flow evaluation outside the store's lock.
public struct NetworkRuleEvaluationSnapshot {
    public let tickets: [NetworkRuleTarget: NetworkRuleTicket]
    public let shapedTargets: Set<NetworkRuleTarget>

    /// The simulators that active rules name: the only ones attribution may select.
    public var managedSimulators: Set<ManagedSimulator> {
        Set(tickets.keys.map(\.simulator)).union(shapedTargets.map(\.simulator))
    }
}

/// Leased, owner-fenced rules. Pure apart from `MonotonicClock`.
///
/// - A rule expires unless renewed within its lease, so a daemon that dies or
///   hangs cannot leave an app offline for longer than one lease.
/// - Rules live in memory only: a provider restart drops them and nothing is
///   resurrected. The host learns this from `renew` (`not_found`) or `status`.
/// - Removing a rule (reset or expiry) leaves a tombstone of its owner,
///   generation and revision, so a late `apply` from a released generation, or
///   a delayed retry of an older revision, is refused instead of re-installed.
public final class NetworkRuleStore: ShapingRuleSource {
    public static let minimumLeaseMilliseconds: UInt64 = 1000
    public static let maximumLeaseMilliseconds: UInt64 = 60000
    public static let maximumRules = 64
    public static let maximumTombstones = 256

    private struct Rule {
        let ownership: NetworkRuleOwnership
        let condition: NetworkRuleCondition
        let request: NetworkRuleCommandCondition
        let shaping: ShapingResolution?
        var expiresAt: UInt64
        var droppedFlows: UInt64

        var ticket: (String, UInt64, UInt64) {
            (ownership.owner, ownership.ownerGeneration, ownership.revision)
        }
    }

    private struct TombstoneKey: Hashable {
        let target: NetworkRuleTarget
        let owner: String
    }

    private struct Tombstone {
        let ownerGeneration: UInt64
        let revision: UInt64
        /// True when a reset (not expiry) removed the rule, so a duplicate reset is idempotent.
        let byReset: Bool
    }

    private let clock: MonotonicClock
    private let supportsShaping: Bool
    private let lock = NSLock()
    private var rules: [NetworkRuleTarget: Rule] = [:]
    private var tombstones: [TombstoneKey: Tombstone] = [:]
    private var tombstoneOrder: [TombstoneKey] = []

    public init(clock: MonotonicClock, supportsShaping: Bool = false) {
        self.clock = clock
        self.supportsShaping = supportsShaping
    }

    public func execute(_ command: NetworkRuleCommand) -> NetworkRuleResult {
        lock.lock()
        defer { lock.unlock() }
        // Rejected shaping must not even sweep leases or create tombstones.
        var resolution: ShapingResolution?
        if command.kind == .apply, case let .shaped(request) = command.condition {
            guard supportsShaping else { return NetworkRuleResult(outcome: .unsupportedCondition) }
            switch ShapingProfile.resolve(request) {
            case let .success(value): resolution = value
            case let .failure(rejection):
                return NetworkRuleResult(outcome: .invalidShaping, rejection: NetworkShapingRejection(rejection))
            }
        }
        let now = clock.nowNanoseconds()
        sweep(now: now)
        switch command.kind {
        case .apply:
            return apply(command, resolution: resolution, now: now)
        case .reset:
            return reset(command.target, command.ownership)
        case .renew:
            return renew(command, now: now)
        }
    }

    /// Active rules, oldest lease first. Expired rules are swept before reporting.
    public func activeRules() -> [NetworkRuleStatus] {
        lock.lock()
        defer { lock.unlock() }
        let now = clock.nowNanoseconds()
        sweep(now: now)
        return rules.map { target, rule in
            NetworkRuleStatus(
                target: target,
                owner: rule.ownership.owner,
                ownerGeneration: rule.ownership.ownerGeneration,
                revision: rule.ownership.revision,
                condition: rule.condition,
                leaseRemainingMilliseconds: (rule.expiresAt - now) / 1_000_000,
                droppedFlows: rule.droppedFlows,
                shaping: rule.shaping
            )
        }
        .sorted { ($0.target.simulator.udid, $0.target.bundleId) < ($1.target.simulator.udid, $1.target.bundleId) }
    }

    /// `nil` only when no rule is active, preserving the no-lookup fast path.
    public func evaluationSnapshot() -> NetworkRuleEvaluationSnapshot? {
        lock.lock()
        defer { lock.unlock() }
        sweep(now: clock.nowNanoseconds())
        guard !rules.isEmpty else { return nil }
        var tickets: [NetworkRuleTarget: NetworkRuleTicket] = [:]
        for (target, rule) in rules where rule.condition == .offline {
            tickets[target] = NetworkRuleTicket(
                target: target,
                owner: rule.ownership.owner,
                ownerGeneration: rule.ownership.ownerGeneration,
                revision: rule.ownership.revision
            )
        }
        let shapedTargets = Set(rules.keys.filter { rules[$0]?.shaping != nil })
        return NetworkRuleEvaluationSnapshot(tickets: tickets, shapedTargets: shapedTargets)
    }

    /// Commits a drop computed outside the lock. Returns `false`, and counts
    /// nothing, when the rule the ticket names was reset, replaced, or expired
    /// in the meantime: the caller then allows the flow.
    public func commitDrop(_ ticket: NetworkRuleTicket) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        sweep(now: clock.nowNanoseconds())
        guard var rule = rules[ticket.target], rule.condition == .offline, rule.ticket == (
            ticket.owner,
            ticket.ownerGeneration,
            ticket.revision
        )
        else { return false }
        rule.droppedFlows &+= 1
        rules[ticket.target] = rule
        return true
    }

    /// Ends every rule, as expiry would. Used when the filter stops or restarts.
    public func removeAll() {
        lock.lock()
        defer { lock.unlock() }
        for (target, rule) in rules {
            bury(target, rule.ownership, byReset: false)
        }
        rules.removeAll()
    }

    /// The ticket of the offline rule active for `target` right now, if any.
    public func currentTicket(for target: NetworkRuleTarget) -> NetworkRuleTicket? {
        evaluationSnapshot()?.tickets[target]
    }

    /// Takes only the store lock and never calls out: the shaper may safely
    /// consult this source while holding its own lock.
    public func shapingRule(for target: NetworkRuleTarget) -> ShapingRule? {
        lock.lock()
        defer { lock.unlock() }
        sweep(now: clock.nowNanoseconds())
        guard let rule = rules[target], case let .shaped(profile) = rule.condition else { return nil }
        return ShapingRule(ticket: NetworkRuleTicket(
            target: target, owner: rule.ownership.owner,
            ownerGeneration: rule.ownership.ownerGeneration, revision: rule.ownership.revision
        ), profile: profile)
    }

    // MARK: - Commands (lock held)

    private func apply(
        _ command: NetworkRuleCommand,
        resolution: ShapingResolution?,
        now: UInt64
    )
        -> NetworkRuleResult
    {
        guard let condition = command.condition else { return NetworkRuleResult(outcome: .invalidCommand) }
        guard let lease = Self.validLease(command.leaseMilliseconds) else {
            return NetworkRuleResult(outcome: .invalidLease)
        }
        let target = command.target
        let ownership = command.ownership
        if let refusal = fenced(target, ownership, idempotentReset: false) { return refusal }
        if let existing = rules[target] {
            if existing.ownership.owner != ownership.owner {
                return NetworkRuleResult(outcome: .ownedByAnotherSession)
            }
            if ownership.ownerGeneration < existing.ownership.ownerGeneration {
                return NetworkRuleResult(outcome: .staleGeneration)
            }
            if ownership.ownerGeneration == existing.ownership.ownerGeneration,
               ownership.revision < existing.ownership.revision
            {
                return installedRefusal(.staleRevision, existing, now: now)
            }
            if existing.ownership == ownership, existing.request != condition {
                return NetworkRuleResult(outcome: .invalidCommand)
            }
        } else if rules.count >= Self.maximumRules {
            return NetworkRuleResult(outcome: .capacityExceeded)
        }
        // A re-delivered apply of the installed revision is idempotent; like a
        // renew, it starts a fresh lease.
        let dropped = rules[target].map { $0.ownership == ownership ? $0.droppedFlows : 0 } ?? 0
        let rule = Rule(
            ownership: ownership,
            condition: resolution.map { .shaped($0.profile) } ?? .offline,
            request: condition,
            shaping: resolution,
            expiresAt: now + lease * 1_000_000,
            droppedFlows: dropped
        )
        rules[target] = rule
        return NetworkRuleResult(
            outcome: .applied,
            installedRevision: ownership.revision,
            leaseRemainingMilliseconds: lease,
            shaping: resolution
        )
    }

    private func reset(_ target: NetworkRuleTarget, _ ownership: NetworkRuleOwnership) -> NetworkRuleResult {
        if let refusal = fenced(target, ownership, idempotentReset: true) { return refusal }
        if let existing = rules[target] {
            if existing.ownership.owner != ownership.owner {
                // Never clear another session's rule.
                return NetworkRuleResult(outcome: .ownedByAnotherSession)
            }
            if ownership.ownerGeneration < existing.ownership.ownerGeneration {
                return NetworkRuleResult(outcome: .staleGeneration)
            }
            if ownership.ownerGeneration == existing.ownership.ownerGeneration,
               ownership.revision <= existing.ownership.revision
            {
                return NetworkRuleResult(outcome: .staleRevision, installedRevision: existing.ownership.revision)
            }
            rules.removeValue(forKey: target)
        }
        // Nothing of this owner is installed afterwards, and its tombstone fences
        // any older apply still in flight.
        bury(target, ownership, byReset: true)
        return NetworkRuleResult(outcome: .reset)
    }

    private func renew(_ command: NetworkRuleCommand, now: UInt64) -> NetworkRuleResult {
        guard let lease = Self.validLease(command.leaseMilliseconds) else {
            return NetworkRuleResult(outcome: .invalidLease)
        }
        let ownership = command.ownership
        guard var rule = rules[command.target] else { return NetworkRuleResult(outcome: .notFound) }
        guard rule.ownership.owner == ownership.owner else { return NetworkRuleResult(outcome: .notFound) }
        if ownership.ownerGeneration != rule.ownership.ownerGeneration {
            return NetworkRuleResult(outcome: .staleGeneration)
        }
        // Renew names the revision the host believes is installed; any other
        // revision means the host's view is stale and it must reconcile.
        guard ownership.revision == rule.ownership.revision else {
            return installedRefusal(.staleRevision, rule, now: now)
        }
        rule.expiresAt = now + lease * 1_000_000
        rules[command.target] = rule
        return NetworkRuleResult(
            outcome: .renewed,
            installedRevision: rule.ownership.revision,
            leaseRemainingMilliseconds: lease
        )
    }

    // MARK: - Helpers (lock held)

    private static func validLease(_ milliseconds: UInt64?) -> UInt64? {
        guard let milliseconds, (minimumLeaseMilliseconds ... maximumLeaseMilliseconds).contains(milliseconds)
        else { return nil }
        return milliseconds
    }

    private func installedRefusal(_ outcome: NetworkRuleOutcome, _ rule: Rule, now: UInt64) -> NetworkRuleResult {
        NetworkRuleResult(
            outcome: outcome,
            installedRevision: rule.ownership.revision,
            leaseRemainingMilliseconds: (rule.expiresAt - now) / 1_000_000
        )
    }

    private func fenced(
        _ target: NetworkRuleTarget,
        _ ownership: NetworkRuleOwnership,
        idempotentReset: Bool
    )
        -> NetworkRuleResult?
    {
        guard let tombstone = tombstones[TombstoneKey(target: target, owner: ownership.owner)] else { return nil }
        if ownership.ownerGeneration < tombstone.ownerGeneration {
            return NetworkRuleResult(outcome: .staleGeneration)
        }
        guard ownership.ownerGeneration == tombstone.ownerGeneration else { return nil }
        if idempotentReset, tombstone.byReset, ownership.revision == tombstone.revision {
            return NetworkRuleResult(outcome: .reset)
        }
        return ownership.revision <= tombstone.revision ? NetworkRuleResult(outcome: .staleRevision) : nil
    }

    private func bury(_ target: NetworkRuleTarget, _ ownership: NetworkRuleOwnership, byReset: Bool) {
        let key = TombstoneKey(target: target, owner: ownership.owner)
        if let existing = tombstones[key],
           (existing.ownerGeneration, existing.revision) >= (ownership.ownerGeneration, ownership.revision)
        {
            return
        }
        if tombstones[key] == nil {
            tombstoneOrder.append(key)
        }
        tombstones[key] = Tombstone(
            ownerGeneration: ownership.ownerGeneration,
            revision: ownership.revision,
            byReset: byReset
        )
        while tombstoneOrder.count > Self.maximumTombstones {
            tombstones.removeValue(forKey: tombstoneOrder.removeFirst())
        }
    }

    private func sweep(now: UInt64) {
        for (target, rule) in rules where now >= rule.expiresAt {
            rules.removeValue(forKey: target)
            bury(target, rule.ownership, byReset: false)
        }
    }
}
