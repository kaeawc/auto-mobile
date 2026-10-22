// Generated from schemas/prototype-spec-contract.json; do not edit.
// Regenerate: bun scripts/prototype/generate-prototype-spec-models.ts

struct Offset: Decodable, Encodable {
    let x: Double
    let y: Double
}

struct Padding: Decodable, Encodable {
    let top: Double?
    let bottom: Double?
    let start: Double?
    let end: Double?
}
