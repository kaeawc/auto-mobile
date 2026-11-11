import { describe, expect, test } from "bun:test";
import {
  closestNames,
  formatUnknownToolMessage,
  nameEditDistance,
} from "../../src/utils/unknownToolMessage";

const TOOLS = ["observe", "tapOn", "swipeOn", "sendKeys", "displayConfig", "launchApp"];

describe("unknown tool message (#18024)", () => {
  test("edit distance is case-insensitive Levenshtein", () => {
    expect(nameEditDistance("tapOn", "tapon")).toBe(0);
    expect(nameEditDistance("tapOn", "tapIn")).toBe(1);
    expect(nameEditDistance("", "abc")).toBe(3);
    expect(nameEditDistance("kitten", "sitting")).toBe(3);
  });

  test("closest names rank by distance and include substrings", () => {
    expect(closestNames("tapOm", TOOLS)).toEqual(["tapOn"]);
    expect(closestNames("observeScreen", TOOLS)).toEqual(["observe"]);
    expect(closestNames("launch", TOOLS)).toEqual(["launchApp"]);
    expect(closestNames("zzzzzz", TOOLS)).toEqual([]);
    expect(closestNames("ab", ["ac", "xy", "ad"], 1)).toEqual(["ac"]);
  });

  test("names an observe result field without suggesting a restart", () => {
    const message = formatUnknownToolMessage("screenSize", TOOLS, ["screenSize", "elements"]);
    expect(message).toBe(
      'Unknown tool "screenSize". No tool with this name exists. screenSize is a field of the observe result; call observe and read screenSize.',
    );
    expect(message.toLowerCase()).not.toContain("restart");
  });

  test("lists the closest registered tools", () => {
    expect(formatUnknownToolMessage("sendKey", TOOLS)).toBe(
      'Unknown tool "sendKey". No tool with this name exists. Closest tools: sendKeys.',
    );
    expect(formatUnknownToolMessage("Observe", TOOLS)).toContain("Closest tools: observe.");
  });

  test("states only that the tool does not exist when nothing is close", () => {
    expect(formatUnknownToolMessage("qqqqqqqq", TOOLS)).toBe(
      'Unknown tool "qqqqqqqq". No tool with this name exists.',
    );
  });
});
