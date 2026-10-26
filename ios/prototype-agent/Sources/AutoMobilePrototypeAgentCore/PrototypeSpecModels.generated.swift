// Generated from schemas/prototype-spec-contract.json; do not edit.
// Regenerate: bun scripts/prototype/generate-prototype-spec-models.ts

struct Offset: Codable, Equatable, Sendable {
    let x: Double
    let y: Double
}

struct Padding: Codable, Equatable, Sendable {
    let top: Double?
    let bottom: Double?
    let start: Double?
    let end: Double?
}

struct SafeAreaPadding: Codable, Equatable, Sendable {
    let edges: [String]
    let types: [String]
}

/// A fixed y axis for a chart; `max` is above `min`.
struct PrototypeChartRange: Codable, Equatable, Sendable {
    let min: Double
    let max: Double
}
