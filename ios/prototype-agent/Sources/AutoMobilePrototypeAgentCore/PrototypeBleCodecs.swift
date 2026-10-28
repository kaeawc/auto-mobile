import Foundation

/// BLE value codecs (#14266), the Swift twin of `src/features/prototype/prototypeBleCodecs.ts`.
/// Both replay `test/fixtures/prototype-spec/ble/codecs.json`.
enum PrototypeBleCodecs {
    /// ATT attribute values are at most 512 bytes.
    static let maxValueBytes = 512

    static let codecs = [
        "utf8", "hex", "base64", "uint8", "uint16le", "int16le", "uint32le", "float32le",
        "gatt.battery_level", "gatt.heart_rate_measurement",
    ]

    /// `length` and `range` are about the bytes or number; `format` is a value of the wrong shape.
    enum Failure: String, Error, Equatable {
        case unknown, length, range, format
        case decodeOnly
    }

    private struct Width { let bytes: Int; let min: Double; let max: Double }

    private static let integers: [String: Width] = [
        "uint8": Width(bytes: 1, min: 0, max: 0xFF),
        "uint16le": Width(bytes: 2, min: 0, max: 0xFFFF),
        "int16le": Width(bytes: 2, min: -0x8000, max: 0x7FFF),
        "uint32le": Width(bytes: 4, min: 0, max: 0xFFFF_FFFF),
    ]

    static func decode(_ codec: String, _ bytes: [UInt8]) -> Result<JSONValue, Failure> {
        guard codecs.contains(codec) else { return .failure(.unknown) }
        guard bytes.count <= maxValueBytes else { return .failure(.length) }
        switch codec {
        case "utf8":
            // Invalid UTF-8 decodes to replacement characters, so it does not round-trip.
            let text = String(decoding: bytes, as: UTF8.self)
            return Array(text.utf8) == bytes ? .success(.string(text)) : .failure(.format)
        case "hex": return .success(.string(bytes.map { String(format: "%02x", $0) }.joined()))
        case "base64": return .success(.string(Data(bytes).base64EncodedString()))
        case "float32le":
            guard bytes.count == 4 else { return .failure(.length) }
            let value = Float(bitPattern: uint32(bytes, 0))
            return value.isFinite ? .success(.number(Double(value))) : .failure(.range)
        case "gatt.battery_level":
            guard bytes.count == 1 else { return .failure(.length) }
            return bytes[0] > 100 ? .failure(.range) : .success(.number(Double(bytes[0])))
        case "gatt.heart_rate_measurement": return heartRate(bytes)
        default: return integer(codec, bytes)
        }
    }

    private static func uint16(_ bytes: [UInt8], _ offset: Int) -> UInt16 {
        UInt16(bytes[offset]) | UInt16(bytes[offset + 1]) << 8
    }

    private static func uint32(_ bytes: [UInt8], _ offset: Int) -> UInt32 {
        (0 ..< 4).reduce(UInt32(0)) { $0 | UInt32(bytes[offset + $1]) << (8 * UInt32($1)) }
    }

    private static func integer(_ codec: String, _ bytes: [UInt8]) -> Result<JSONValue, Failure> {
        guard let width = integers[codec], bytes.count == width.bytes else { return .failure(.length) }
        let value: Double = switch codec {
        case "uint8": Double(bytes[0])
        case "uint16le": Double(uint16(bytes, 0))
        case "int16le": Double(Int16(bitPattern: uint16(bytes, 0)))
        default: Double(uint32(bytes, 0))
        }
        return .success(.number(value))
    }

    private static func heartRate(_ bytes: [UInt8]) -> Result<JSONValue, Failure> {
        guard bytes.count >= 2 else { return .failure(.length) }
        let flags = bytes[0]
        let wide = flags & 0x01 != 0
        var offset = wide ? 3 : 2
        guard bytes.count >= offset else { return .failure(.length) }
        var result: [String: JSONValue] = [
            "heartRate": .number(Double(wide ? uint16(bytes, 1) : UInt16(bytes[1]))),
            "sensorContact": .string(flags & 0x04 == 0 ? "unsupported" : flags & 0x02 != 0 ? "detected" :
                "notDetected"),
        ]
        if flags & 0x08 != 0 {
            guard bytes.count >= offset + 2 else { return .failure(.length) }
            result["energyExpended"] = .number(Double(uint16(bytes, offset)))
            offset += 2
        }
        let rest = bytes.count - offset
        let intervals = flags & 0x10 != 0
        guard intervals ? rest % 2 == 0 : rest == 0 else { return .failure(.length) }
        if intervals {
            // RR intervals are in 1/1024 s; report whole milliseconds.
            result["rrIntervalsMs"] = .array((0 ..< rest / 2).map {
                .number((Double(uint16(bytes, offset + $0 * 2)) * 1000 / 1024).rounded())
            })
        }
        return .success(.object(result))
    }

    static func encode(_ codec: String, _ value: JSONValue) -> Result<[UInt8], Failure> {
        guard codecs.contains(codec) else { return .failure(.unknown) }
        let result = encodeKnown(codec, value)
        if case let .success(bytes) = result, bytes.count > maxValueBytes { return .failure(.length) }
        return result
    }

    private static func encodeKnown(_ codec: String, _ value: JSONValue) -> Result<[UInt8], Failure> {
        if codec.hasPrefix("gatt.") { return .failure(.decodeOnly) }
        if ["utf8", "hex", "base64"].contains(codec) {
            guard case let .string(text) = value else { return .failure(.format) }
            return encodeText(codec, text)
        }
        guard case let .number(number) = value else { return .failure(.format) }
        return encodeNumber(codec, number)
    }

    private static func encodeText(_ codec: String, _ text: String) -> Result<[UInt8], Failure> {
        switch codec {
        case "utf8":
            return .success(Array(text.utf8))
        case "hex":
            let digits = Array(text.utf8)
            guard digits.count.isMultiple(of: 2), digits.allSatisfy({ $0 < 0x80 && isHexDigit($0) }) else {
                return .failure(.format)
            }
            return .success(stride(from: 0, to: digits.count, by: 2).map {
                UInt8(String(decoding: digits[$0 ..< $0 + 2], as: UTF8.self), radix: 16) ?? 0
            })
        default:
            guard text.range(of: base64Pattern, options: .regularExpression) != nil,
                  let data = Data(base64Encoded: text)
            else { return .failure(.format) }
            return .success(Array(data))
        }
    }

    private static let base64Pattern = "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$"

    private static func isHexDigit(_ byte: UInt8) -> Bool {
        (0x30 ... 0x39).contains(byte) || (0x41 ... 0x46).contains(byte) || (0x61 ... 0x66).contains(byte)
    }

    private static func encodeNumber(_ codec: String, _ value: Double) -> Result<[UInt8], Failure> {
        if codec == "float32le" {
            let float = Float(value)
            guard value.isFinite, float.isFinite else { return .failure(.range) }
            return .success(littleEndian(UInt64(float.bitPattern), count: 4))
        }
        guard let width = integers[codec], value.rounded() == value, value >= width.min, value <= width.max else {
            return .failure(.range)
        }
        return .success(littleEndian(UInt64(bitPattern: Int64(value)), count: width.bytes))
    }

    private static func littleEndian(_ value: UInt64, count: Int) -> [UInt8] {
        (0 ..< count).map { UInt8(truncatingIfNeeded: value >> (8 * UInt64($0))) }
    }
}
