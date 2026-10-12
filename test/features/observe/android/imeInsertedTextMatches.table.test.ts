import { expect, test } from "bun:test";
import { imeInsertedTextMatches } from "../../../../src/features/observe/android/CtrlProxyText";

const rows = [
  {
    why: "mask hyphen before a kept opener preserves its pair",
    sent: "*a*",
    inserted: "-*a*",
    expected: true,
  },
  {
    why: "mask space before a kept opener preserves its pair",
    sent: "*a*",
    inserted: " *a*",
    expected: true,
  },
  {
    why: "mask parentheses around a kept span preserve its pair",
    sent: "*a*",
    inserted: "(*a*)",
    expected: true,
  },
  {
    why: "mask hyphen before a kept closer preserves its pair",
    sent: "*a*",
    inserted: "*a-*",
    expected: true,
  },
  {
    why: "mask parentheses around kept code preserve its pair",
    sent: "`c`",
    inserted: "(`c`)",
    expected: true,
  },
  {
    why: "mask parentheses around converted content preserve following text",
    sent: "*a* b",
    inserted: "(a) b",
    expected: true,
  },
  {
    why: "mask quotes around kept italics preserve their pair",
    sent: "_a_",
    inserted: '"_a_"',
    expected: true,
  },
  {
    why: "mask hyphen before a kept nested pair permits outer conversion",
    sent: "*_x_*",
    inserted: "-_x_",
    expected: true,
  },
  {
    why: "mask space before kept double markers preserves both counts",
    sent: "**x**",
    inserted: " **x**",
    expected: true,
  },
  {
    why: "extra mask space before a kept middle span preserves its pair",
    sent: "say *hi* now",
    inserted: "say  *hi* now",
    expected: true,
  },
  {
    why: "ambiguous mask-added span marker remains rejected by pairing",
    sent: "*a*",
    inserted: "a*",
    expected: false,
  },
  {
    why: "converted code keeps inner non-code markers literal",
    sent: "`x *a* y`",
    inserted: "x *a* y",
    expected: true,
  },
  {
    why: "kept code keeps inner non-code markers literal",
    sent: "`x *a* y`",
    inserted: "`x *a* y`",
    expected: true,
  },
  {
    why: "code content cannot lose literal non-code markers",
    sent: "`x *a* y`",
    inserted: "x a y",
    expected: false,
  },
  {
    why: "code nested inside bold may convert with its enclosing span",
    sent: "*a `b` c*",
    inserted: "a b c",
    expected: true,
  },
  {
    why: "converted italic closer permits NFC recomposition with a following mark",
    sent: "_a_\u0301",
    inserted: "á",
    expected: true,
  },
  {
    why: "converted code closer permits NFC recomposition with a following mark",
    sent: "`e`\u0301",
    inserted: "é",
    expected: true,
  },
  {
    why: "NFC recomposition cannot remove a lone intraword underscore",
    sent: "a_b\u0301",
    inserted: "ab\u0301",
    expected: false,
  },
  {
    why: "recomposition cannot forgive a retained italic opener without its closer",
    sent: "_a_\u0301",
    inserted: "_á",
    expected: false,
  },
  {
    why: "recomposition cannot forgive a retained code closer without its opener",
    sent: "`e`\u0301",
    inserted: "é`",
    expected: false,
  },
  {
    why: "non-code opener inside code makes both of its markers literal",
    sent: "`x *a` y*",
    inserted: "x a y",
    expected: false,
  },
  {
    why: "non-code closer inside code makes both of its markers literal",
    sent: "*x `a* y`",
    inserted: "x a y",
    expected: false,
  },
  {
    why: "crossing non-code spans retain their existing conversion behavior",
    sent: "*a _b* c_",
    inserted: "a b c",
    expected: true,
  },
  {
    why: "lone underscore in an email address must be inserted",
    sent: "john_doe@example.com",
    inserted: "johndoe@example.com",
    expected: false,
  },
  {
    why: "lone underscore in a username must be inserted",
    sent: "user_name",
    inserted: "username",
    expected: false,
  },
  {
    why: "home-directory tilde must be inserted",
    sent: "~/Downloads",
    inserted: "/Downloads",
    expected: false,
  },
  { why: "intraword backtick must be inserted", sent: "it`s", inserted: "its", expected: false },
  {
    why: "multiplication asterisk must be inserted",
    sent: "2 * 3",
    inserted: "2  3",
    expected: false,
  },
  {
    why: "both snake-case underscores must be inserted",
    sent: "snake_case_name",
    inserted: "snakecasename",
    expected: false,
  },
  {
    why: "second snake-case underscore must be inserted",
    sent: "snake_case_name",
    inserted: "snake_casename",
    expected: false,
  },
  {
    why: "private variable underscores are literal",
    sent: "_private_var",
    inserted: "privatevar",
    expected: false,
  },
  {
    why: "double underscore runs are not delimiters",
    sent: "__init__",
    inserted: "init",
    expected: false,
  },
  { why: "intraword asterisks are not a span", sent: "a*b*c", inserted: "abc", expected: false },
  {
    why: "digit-adjacent asterisks are not a span",
    sent: "2*3*4",
    inserted: "234",
    expected: false,
  },
  {
    why: "triple asterisk runs are not delimiters",
    sent: "***x***",
    inserted: "x",
    expected: false,
  },
  {
    why: "edge whitespace prevents a format span",
    sent: "* a *",
    inserted: " a ",
    expected: false,
  },
  {
    why: "a format span cannot cross a newline",
    sent: "*a\nb*",
    inserted: "a\nb",
    expected: false,
  },
  {
    why: "unclosed double asterisk is literal",
    sent: "**kwargs",
    inserted: "kwargs",
    expected: false,
  },
  {
    why: "unclosed price tilde is literal",
    sent: "price ~5",
    inserted: "price 5",
    expected: false,
  },
  {
    why: "intraword underscores across words stay literal",
    sent: "a_b c_d",
    inserted: "ab cd",
    expected: false,
  },
  {
    why: "exact email underscore is accepted",
    sent: "john_doe@example.com",
    inserted: "john_doe@example.com",
    expected: true,
  },
  {
    why: "exact snake-case underscores are accepted",
    sent: "snake_case_name",
    inserted: "snake_case_name",
    expected: true,
  },
  {
    why: "exact multiplication asterisk is accepted",
    sent: "2 * 3",
    inserted: "2 * 3",
    expected: true,
  },
  {
    why: "exact home-directory tilde is accepted",
    sent: "~/Downloads",
    inserted: "~/Downloads",
    expected: true,
  },
  { why: "exact intraword backtick is accepted", sent: "it`s", inserted: "it`s", expected: true },
  {
    why: "exact double underscore runs are accepted",
    sent: "__init__",
    inserted: "__init__",
    expected: true,
  },
  {
    why: "single-asterisk bold delimiters may be consumed",
    sent: "*bold*",
    inserted: "bold",
    expected: true,
  },
  {
    why: "italic delimiters may be consumed",
    sent: "_italic_",
    inserted: "italic",
    expected: true,
  },
  {
    why: "single-tilde strike delimiters may be consumed",
    sent: "~strike~",
    inserted: "strike",
    expected: true,
  },
  { why: "code delimiters may be consumed", sent: "`code`", inserted: "code", expected: true },
  {
    why: "double-asterisk bold delimiters may be consumed",
    sent: "**bold**",
    inserted: "bold",
    expected: true,
  },
  {
    why: "double-tilde strike delimiters may be consumed",
    sent: "~~strike~~",
    inserted: "strike",
    expected: true,
  },
  {
    why: "formatting inside a sentence may be consumed",
    sent: "say *hi* now",
    inserted: "say hi now",
    expected: true,
  },
  { why: "different delimiter kinds can nest", sent: "*_x_*", inserted: "x", expected: true },
  {
    why: "independent spans can both be consumed",
    sent: "*a* and _b_",
    inserted: "a and b",
    expected: true,
  },
  {
    why: "one span can convert while another stays literal",
    sent: "*a* and _b_",
    inserted: "a and _b_",
    expected: true,
  },
  {
    why: "parentheses are valid span boundaries",
    sent: "(*bold*)",
    inserted: "(bold)",
    expected: true,
  },
  {
    why: "trailing punctuation is a valid span boundary",
    sent: "*bold*!",
    inserted: "bold!",
    expected: true,
  },
  {
    why: "double delimiters may each retain one marker",
    sent: "**x**",
    inserted: "*x*",
    expected: true,
  },
  {
    why: "a plain editor may keep bold markers",
    sent: "*bold*",
    inserted: "*bold*",
    expected: true,
  },
  {
    why: "a plain editor may keep italic markers",
    sent: "_italic_",
    inserted: "_italic_",
    expected: true,
  },
  {
    why: "a plain editor may keep code markers",
    sent: "`code`",
    inserted: "`code`",
    expected: true,
  },
  {
    why: "keeping only the opening bold delimiter fails pairing",
    sent: "*bold*",
    inserted: "*bold",
    expected: false,
  },
  {
    why: "keeping only the closing bold delimiter fails pairing",
    sent: "*bold*",
    inserted: "bold*",
    expected: false,
  },
  {
    why: "keeping only the opening italic delimiter fails pairing",
    sent: "_italic_",
    inserted: "_italic",
    expected: false,
  },
  {
    why: "converted bold preserves an adjacent literal underscore",
    sent: "*bold* john_doe",
    inserted: "bold john_doe",
    expected: true,
  },
  {
    why: "converted bold cannot forgive an adjacent lost underscore",
    sent: "*bold* john_doe",
    inserted: "bold johndoe",
    expected: false,
  },
  {
    why: "converted italic cannot forgive an adjacent lost underscore",
    sent: "_a_ b_c",
    inserted: "a bc",
    expected: false,
  },
  {
    why: "NFC normalization composes with formatting",
    sent: "*cafe\u0301*",
    inserted: "café",
    expected: true,
  },
  {
    why: "uppercase filtering preserves literal underscores",
    sent: "*bold* a_b",
    inserted: "BOLD A_B",
    expected: true,
  },
  {
    why: "uppercase filtering cannot forgive lost underscores",
    sent: "*bold* a_b",
    inserted: "BOLD AB",
    expected: false,
  },
  {
    why: "decimal-digit folding composes with formatting",
    sent: "_١٢_",
    inserted: "12",
    expected: true,
  },
  {
    why: "input masks may add punctuation after a literal underscore",
    sent: "a_b",
    inserted: "a_b!",
    expected: true,
  },
  {
    why: "a mask hyphen cannot replace a required underscore",
    sent: "a_b",
    inserted: "a-b",
    expected: false,
  },
  {
    why: "block shortcut removal composes with spans and literals",
    sent: "- *x* y_z",
    inserted: "• x y_z",
    expected: true,
  },
  {
    why: "block shortcut removal cannot forgive lost underscores",
    sent: "- *x* y_z",
    inserted: "• x yz",
    expected: false,
  },
  {
    why: "a bullet asterisk cannot pair with a trailing asterisk",
    sent: "* a*",
    inserted: "a",
    expected: false,
  },
  {
    why: "a bullet shortcut alone may be consumed",
    sent: "* item",
    inserted: "item",
    expected: true,
  },
  {
    why: "mention fallback accepts a consumed mention marker with the underscore kept",
    sent: "hi @name there_x",
    inserted: "hi name there_x",
    expected: true,
  },
  {
    why: "mention fallback keeps its looser in-order check so a lost underscore is not detected",
    sent: "hi @name there_x",
    inserted: "hi name therex",
    expected: true,
  },
  {
    why: "mention fallback still rejects a lost letter",
    sent: "hi @name there_x",
    inserted: "hi name there",
    expected: false,
  },
  {
    why: "code-fence fallback retains its looser subsequence check",
    sent: "```a_b```",
    inserted: "ab",
    expected: true,
  },
  { why: "marker-only requests remain unverifiable", sent: "*", inserted: "", expected: true },
  {
    why: "device success forgives one final newline after formatting",
    sent: "*bold*\n",
    inserted: "bold",
    expected: true,
  },
  {
    why: "forgiven final newline cannot forgive a lost underscore",
    sent: "john_doe\n",
    inserted: "johndoe",
    expected: false,
  },
  {
    why: "device success forgives one final newline after a literal underscore",
    sent: "john_doe\n",
    inserted: "john_doe",
    expected: true,
  },
  {
    why: "device failure cannot forgive a missing final newline",
    sent: "john_doe\n",
    inserted: "john_doe",
    deviceSucceeded: false,
    expected: false,
  },
  {
    why: "two final newlines cannot both disappear after formatting",
    sent: "*bold*\n\n",
    inserted: "bold",
    expected: false,
  },
  {
    why: "one of two final newlines may disappear after formatting",
    sent: "*bold*\n\n",
    inserted: "bold\n",
    expected: true,
  },
  {
    why: "double backtick runs are literal outside code fences",
    sent: "``x``",
    inserted: "x",
    expected: false,
  },
  {
    why: "opening delimiters cannot follow a Unicode letter",
    sent: "é*x*",
    inserted: "éx",
    expected: false,
  },
  {
    why: "closing delimiters cannot precede a Unicode digit",
    sent: "*x*١",
    inserted: "x1",
    expected: false,
  },
  {
    why: "astral Unicode letters prevent intraword formatting",
    sent: "𐐀_x_",
    inserted: "𐐀x",
    expected: false,
  },
  {
    why: "astral Unicode letters after a closing marker prevent formatting",
    sent: "_x_𐐀",
    inserted: "x𐐀",
    expected: false,
  },
  {
    why: "astral punctuation permits a span boundary",
    sent: "😀_x_",
    inserted: "😀x",
    expected: true,
  },
  {
    why: "invalid edge whitespace does not consume the next valid opener",
    sent: "say * a *b*",
    inserted: "say * a b",
    expected: true,
  },
  { why: "leading tab prevents a code span", sent: "`\tx`", inserted: "\tx", expected: false },
  { why: "trailing tab prevents an italic span", sent: "_x\t_", inserted: "x\t", expected: false },
  {
    why: "internal whitespace is permitted inside a span",
    sent: "*two words*",
    inserted: "two words",
    expected: true,
  },
  {
    why: "double-asterisk pairing rejects unequal retained counts",
    sent: "**x**",
    inserted: "**x*",
    expected: false,
  },
  {
    why: "double-tilde pairing rejects only one retained side",
    sent: "~~x~~",
    inserted: "x~~",
    expected: false,
  },
  {
    why: "separate spans cannot balance each other's unpaired delimiters",
    sent: "*a* *b*",
    inserted: "*a b*",
    expected: false,
  },
  {
    why: "nested spans may keep only the inner pair",
    sent: "*_x_*",
    inserted: "_x_",
    expected: true,
  },
  {
    why: "nested spans may keep only the outer pair",
    sent: "*_x_*",
    inserted: "*x*",
    expected: true,
  },
  {
    why: "mask additions may include inline markers",
    sent: "bold code",
    inserted: "*bold* _code_",
    expected: true,
  },
  {
    why: "uppercase expansions preserve span delimiter positions",
    sent: "*straße* a_b",
    inserted: "STRASSE A_B",
    expected: true,
  },
  {
    why: "same-kind spans are scanned independently left to right",
    sent: "_a_ _b_",
    inserted: "a b",
    expected: true,
  },
].map((row) => ({ deviceSucceeded: true, ...row }));

test.each(rows)("$why", ({ sent, inserted, deviceSucceeded, expected }) => {
  expect(imeInsertedTextMatches(inserted, sent, { deviceSucceeded })).toBe(expected);
});

const maskRequests = [
  { sent: "*a*", converted: "a" },
  { sent: "_it_ x", converted: "it x" },
  { sent: "`c` d", converted: "c d" },
  { sent: "**b** c", converted: "b c" },
  { sent: "~s~", converted: "s" },
  { sent: "*_x_*", converted: "x" },
  { sent: "a *b* c_d", converted: "a b c_d" },
  { sent: "(*p*) q", converted: "(p) q" },
];

for (const { sent, converted } of maskRequests) {
  test(`every mask position preserves kept and converted spans in ${sent}`, () => {
    for (const form of [sent, converted]) {
      for (const mask of [" ", "-", "(", ")", "!", ".", "/"]) {
        for (let position = 0; position <= form.length; position++) {
          const inserted = form.slice(0, position) + mask + form.slice(position);
          expect({ inserted, matches: imeInsertedTextMatches(inserted, sent) }).toEqual({
            inserted,
            matches: true,
          });
        }
      }
    }
  });
}

test("20,000-character request with spans and lone markers matches itself", () => {
  const sent = "a_b *c* ".repeat(2500);
  const exactMatches = imeInsertedTextMatches(sent, sent, { deviceSucceeded: true });
  expect(exactMatches).toBe(true);
});

test("20,000-character request rejects a lost lone underscore", () => {
  const sent = "a_b *c* ".repeat(2500);
  const missingUnderscore = sent.replace("_", "");
  const missingMatches = imeInsertedTextMatches(missingUnderscore, sent, { deviceSucceeded: true });
  expect(missingMatches).toBe(false);
});

test("repeated converted italic spans preserve every required space", () => {
  const sent = "_a_ ".repeat(2500);
  expect(imeInsertedTextMatches("a ".repeat(2500), sent)).toBe(true);
});

test("20,000 literal asterisks cannot disappear beside required content", () => {
  const sent = "*".repeat(20000) + "x";
  expect(imeInsertedTextMatches("x", sent)).toBe(false);
});

test("20,000 mask parentheses before a kept span preserve its pair", () => {
  expect(imeInsertedTextMatches("(".repeat(20000) + "*a*", "*a*")).toBe(true);
});

test("a long varied mask prefix permits a kept inner pair and converted outer pair", () => {
  expect(imeInsertedTextMatches("(-!./)".repeat(2000) + "_x_", "*_x_*")).toBe(true);
});
