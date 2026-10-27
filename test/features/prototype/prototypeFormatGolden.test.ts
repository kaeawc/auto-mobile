import { expect, test } from "bun:test";
import fixture from "../../fixtures/prototype-spec/derive/formatters.json";
import { formatPrototypeValue } from "../../../src/features/prototype/prototypeFormat";
import type { PrototypeFormat } from "../../../src/features/prototype/prototypeFormatSchema";
import { FakeTimer } from "../../fakes/FakeTimer";
const normalize = (value: string) => value.replace(/[\u202F\u00A0]/g, " ");
for (const entry of fixture.cases) {
  test(entry.name, () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(fixture.environment.nowMs);
    const result = normalize(
      formatPrototypeValue(entry.format as PrototypeFormat, entry.of, {
        ...fixture.environment,
        ...("locale" in entry ? { locale: entry.locale } : {}),
        ...("timeZone" in entry ? { timeZone: entry.timeZone } : {}),
        nowMs: timer.now(),
      }) ?? "",
    );
    if (entry.exact) {
      expect(result).toBe(normalize(entry.expected));
    } else if ("matches" in entry && typeof entry.matches === "string") {
      expect(result).toMatch(new RegExp(entry.matches));
    } else {
      expect("nonEmpty" in entry && entry.nonEmpty).toBe(true);
      expect(result.length).toBeGreaterThan(0);
    }
  });
}
