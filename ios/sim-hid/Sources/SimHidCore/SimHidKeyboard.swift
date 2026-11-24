/// USB HID keyboard page 7 usages (US layout), as `IndigoHIDMessageForKeyboardArbitrary` takes them.
public enum SimHidKeyboard {
    public static let leftShift: UInt32 = 0xE1

    public static let modifierUsages: [String: UInt32] = [
        "ctrl": 0xE0,
        "shift": 0xE1,
        "alt": 0xE2,
        "meta": 0xE3,
    ]

    /// The raw key names sendKeys accepts, except the IME-only semantic keys.
    public static let namedKeys: [String: UInt32] = [
        "enter": 0x28,
        "escape": 0x29,
        "backspace": 0x2A,
        "tab": 0x2B,
        "delete": 0x4C,
        "arrow_right": 0x4F,
        "arrow_left": 0x50,
        "arrow_down": 0x51,
        "arrow_up": 0x52,
    ]

    public static func usage(forKey name: String) -> UInt32? {
        if let usage = namedKeys[name] { return usage }
        let scalars = Array(name.unicodeScalars)
        guard scalars.count == 1, let letter = letterUsage(scalars[0]) else { return nil }
        return letter
    }

    /// The usage and whether Shift is held for one typed character.
    public static func usage(for character: Character) -> (usage: UInt32, shift: Bool)? {
        let scalars = Array(character.unicodeScalars)
        guard scalars.count == 1 else { return nil }
        let scalar = scalars[0]
        if let letter = letterUsage(scalar) { return (letter, false) }
        if scalar.value >= 0x41, scalar.value <= 0x5A { return (0x04 + scalar.value - 0x41, true) }
        if scalar.value >= 0x31, scalar.value <= 0x39 { return (0x1E + scalar.value - 0x31, false) }
        if scalar == "0" { return (0x27, false) }
        return punctuation[character]
    }

    private static func letterUsage(_ scalar: Unicode.Scalar) -> UInt32? {
        guard scalar.value >= 0x61, scalar.value <= 0x7A else { return nil }
        return 0x04 + scalar.value - 0x61
    }

    private static let punctuation: [Character: (usage: UInt32, shift: Bool)] = [
        " ": (0x2C, false), "\n": (0x28, false), "\t": (0x2B, false), "-": (0x2D, false), "_": (0x2D, true),
        "=": (0x2E, false), "+": (0x2E, true), "[": (0x2F, false), "{": (0x2F, true), "]": (0x30, false),
        "}": (0x30, true), "\\": (0x31, false), "|": (0x31, true), ";": (0x33, false), ":": (0x33, true),
        "'": (0x34, false), "\"": (0x34, true), "`": (0x35, false), "~": (0x35, true), ",": (0x36, false),
        "<": (0x36, true), ".": (0x37, false), ">": (0x37, true), "/": (0x38, false), "?": (0x38, true),
        "!": (0x1E, true), "@": (0x1F, true), "#": (0x20, true), "$": (0x21, true), "%": (0x22, true),
        "^": (0x23, true), "&": (0x24, true), "*": (0x25, true), "(": (0x26, true), ")": (0x27, true),
    ]
}
