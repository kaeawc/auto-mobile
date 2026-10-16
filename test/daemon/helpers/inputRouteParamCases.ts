/**
 * Parameter matrices for the control socket's `input/*` routes (#11813): the valid shapes and each
 * way a param can be invalid, in the order the parser checks them. The goldens in
 * `test/fixtures/input-route-params/golden.json` were captured from the hand-written parsers; the
 * route schemas must reproduce them byte for byte.
 */

export interface ParamCase {
  route: string;
  label: string;
  params: unknown;
}

const BASE = { platform: "android" } as const;
const FINITE_BAD: ReadonlyArray<[string, unknown]> = [
  ["string", "1"],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["-Infinity", Number.NEGATIVE_INFINITY],
  ["null", null],
];
const NOT_OBJECT: ReadonlyArray<[string, unknown]> = [
  ["undefined", undefined],
  ["null", null],
  ["array", []],
  ["string", "x"],
  ["number", 3],
];
const BAD_STRING: ReadonlyArray<[string, unknown]> = [
  ["number", 5],
  ["null", null],
  ["object", {}],
];
const BAD_FRAME: ReadonlyArray<[string, unknown]> = [
  ["empty", ""],
  ["number", 5],
  ["null", null],
];

function common(route: string, valid: Record<string, unknown>): ParamCase[] {
  const cases: ParamCase[] = [];
  for (const [label, params] of NOT_OBJECT) {
    cases.push({ route, label: `params ${label}`, params });
  }
  for (const platform of [undefined, "web", "", 1, "iOS"]) {
    cases.push({
      route,
      label: `platform ${String(platform)}`,
      params: { ...valid, platform },
    });
  }
  for (const [label, value] of BAD_STRING) {
    cases.push({ route, label: `deviceId ${label}`, params: { ...valid, deviceId: value } });
  }
  cases.push({ route, label: "deviceId valid", params: { ...valid, deviceId: "emulator-5554" } });
  for (const [label, value] of BAD_FRAME) {
    cases.push({
      route,
      label: `frameContext ${label}`,
      params: { ...valid, frameContext: value },
    });
  }
  cases.push({ route, label: "frameContext valid", params: { ...valid, frameContext: "ctx-1" } });
  return cases;
}

export function inputRouteParamCases(): ParamCase[] {
  const cases: ParamCase[] = [];

  const tap = { ...BASE, x: 10, y: 20 };
  cases.push({ route: "input/tap", label: "valid", params: tap });
  cases.push({ route: "input/tap", label: "valid ios", params: { ...tap, platform: "ios" } });
  cases.push({
    route: "input/tap",
    label: "extra keys",
    params: { ...tap, extra: 1, sessionUuid: "s" },
  });
  cases.push({
    route: "input/tap",
    label: "negative zero decimals",
    params: { ...BASE, x: -0.5, y: 0 },
  });
  cases.push(...common("input/tap", tap));
  for (const key of ["x", "y"]) {
    cases.push({
      route: "input/tap",
      label: `${key} missing`,
      params: { ...tap, [key]: undefined },
    });
    for (const [label, value] of FINITE_BAD) {
      cases.push({
        route: "input/tap",
        label: `${key} ${label}`,
        params: { ...tap, [key]: value },
      });
    }
  }
  for (const duration of [100, 0, -5, 1.5, "100", null, Number.NaN, Number.POSITIVE_INFINITY]) {
    cases.push({
      route: "input/tap",
      label: `duration ${String(duration)}`,
      params: { ...tap, duration },
    });
  }
  cases.push({
    route: "input/tap",
    label: "first failure wins",
    params: { platform: "x", x: "a", duration: 1.5, deviceId: 3 },
  });
  cases.push({
    route: "input/tap",
    label: "coords before duration",
    params: { ...BASE, x: "a", duration: 1.5 },
  });
  cases.push({
    route: "input/tap",
    label: "duration before deviceId",
    params: { ...tap, duration: 1.5, deviceId: 3 },
  });
  cases.push({
    route: "input/tap",
    label: "deviceId before frameContext",
    params: { ...tap, deviceId: 3, frameContext: "" },
  });

  const swipe = { ...BASE, startX: 1, startY: 2, endX: 3, endY: 4 };
  cases.push({ route: "input/swipe", label: "valid", params: swipe });
  cases.push({
    route: "input/swipe",
    label: "valid full",
    params: { ...swipe, durationMs: 500, deviceId: "d", frameContext: "f" },
  });
  cases.push(...common("input/swipe", swipe));
  for (const key of ["startX", "startY", "endX", "endY"]) {
    cases.push({
      route: "input/swipe",
      label: `${key} missing`,
      params: { ...swipe, [key]: undefined },
    });
    for (const [label, value] of FINITE_BAD) {
      cases.push({
        route: "input/swipe",
        label: `${key} ${label}`,
        params: { ...swipe, [key]: value },
      });
    }
  }
  for (const durationMs of [1, 60000, 0, 60001, -1, 1.5, "300", null, Number.NaN]) {
    cases.push({
      route: "input/swipe",
      label: `durationMs ${String(durationMs)}`,
      params: { ...swipe, durationMs },
    });
  }
  cases.push({
    route: "input/swipe",
    label: "coords before duration",
    params: { ...swipe, startX: "a", durationMs: 0 },
  });
  cases.push({
    route: "input/swipe",
    label: "duration before deviceId",
    params: { ...swipe, durationMs: 0, deviceId: 3 },
  });

  const typeText = { ...BASE, text: "hello" };
  cases.push({ route: "input/typeText", label: "valid", params: typeText });
  cases.push({
    route: "input/typeText",
    label: "valid full",
    params: {
      ...typeText,
      submit: true,
      mode: "append",
      deviceId: "d",
      frameContext: "f",
      sessionUuid: "s",
    },
  });
  cases.push({
    route: "input/typeText",
    label: "submit false",
    params: { ...typeText, submit: false },
  });
  cases.push(...common("input/typeText", typeText));
  for (const text of [undefined, "", 5, null, " "]) {
    cases.push({
      route: "input/typeText",
      label: `text ${JSON.stringify(text)}`,
      params: { ...typeText, text },
    });
  }
  for (const submit of ["true", 1, null]) {
    cases.push({
      route: "input/typeText",
      label: `submit ${JSON.stringify(submit)}`,
      params: { ...typeText, submit },
    });
  }
  for (const mode of ["replace", "", 1, null, "APPEND"]) {
    cases.push({
      route: "input/typeText",
      label: `mode ${JSON.stringify(mode)}`,
      params: { ...typeText, mode },
    });
  }
  cases.push({
    route: "input/typeText",
    label: "unsupported one",
    params: { ...typeText, bogus: 1 },
  });
  cases.push({
    route: "input/typeText",
    label: "unsupported many",
    params: { ...typeText, zeta: 1, alpha: 2 },
  });
  cases.push({
    route: "input/typeText",
    label: "unsupported before platform",
    params: { platform: "web", text: "", bogus: 1 },
  });
  cases.push({
    route: "input/typeText",
    label: "text before deviceId",
    params: { ...typeText, text: "", deviceId: 3 },
  });
  cases.push({
    route: "input/typeText",
    label: "frameContext before mode",
    params: { ...typeText, frameContext: "", mode: "x" },
  });
  cases.push({
    route: "input/typeText",
    label: "submit before deviceId",
    params: { ...typeText, submit: 1, deviceId: 3 },
  });

  const press = { ...BASE, button: "home" };
  cases.push({ route: "input/pressButton", label: "valid", params: press });
  for (const button of [
    "home",
    "back",
    "menu",
    "power",
    "volume_up",
    "volume_down",
    "recent",
    "app_switch",
  ]) {
    cases.push({
      route: "input/pressButton",
      label: `button ${button}`,
      params: { ...press, button },
    });
  }
  cases.push(...common("input/pressButton", press));
  for (const button of [undefined, 5, null, "", "HOME", "enter"]) {
    cases.push({
      route: "input/pressButton",
      label: `button ${JSON.stringify(button)}`,
      params: { ...press, button },
    });
  }
  cases.push({
    route: "input/pressButton",
    label: "extra keys allowed",
    params: { ...press, bogus: 1 },
  });
  cases.push({
    route: "input/pressButton",
    label: "button before deviceId",
    params: { ...press, button: "x", deviceId: 3 },
  });

  const key = { ...BASE, key: "enter" };
  cases.push({ route: "input/key", label: "valid", params: key });
  cases.push({
    route: "input/key",
    label: "valid full",
    params: { ...key, deviceId: "d", frameContext: "f", sessionUuid: "s" },
  });
  cases.push(...common("input/key", key));
  for (const k of [undefined, 5, null, "", "nope", "ENTER"]) {
    cases.push({
      route: "input/key",
      label: `key ${JSON.stringify(k)}`,
      params: { ...key, key: k },
    });
  }
  cases.push({ route: "input/key", label: "unsupported one", params: { ...key, bogus: 1 } });
  cases.push({
    route: "input/key",
    label: "unsupported many",
    params: { ...key, zeta: 1, alpha: 2 },
  });
  cases.push({
    route: "input/key",
    label: "unsupported before platform",
    params: { platform: "web", bogus: 1 },
  });
  cases.push({
    route: "input/key",
    label: "key before deviceId",
    params: { ...key, key: "nope", deviceId: 3 },
  });

  for (const method of ["input/gestureStart", "input/gestureMove", "input/gestureEnd"]) {
    const gesture = { platform: "android", gestureId: "g1", x: 5, y: 6 };
    cases.push({ route: method, label: "valid", params: gesture });
    cases.push({
      route: method,
      label: "valid full",
      params: { ...gesture, deviceId: "d", cancel: true },
    });
    cases.push({ route: method, label: "cancel false", params: { ...gesture, cancel: false } });
    for (const [label, params] of NOT_OBJECT) {
      cases.push({ route: method, label: `params ${label}`, params });
    }
    for (const platform of [undefined, "ios", "web", 1]) {
      cases.push({
        route: method,
        label: `platform ${String(platform)}`,
        params: { ...gesture, platform },
      });
    }
    for (const gestureId of [undefined, "", 5, null]) {
      cases.push({
        route: method,
        label: `gestureId ${JSON.stringify(gestureId)}`,
        params: { ...gesture, gestureId },
      });
    }
    for (const axis of ["x", "y"]) {
      cases.push({
        route: method,
        label: `${axis} missing`,
        params: { ...gesture, [axis]: undefined },
      });
      for (const [label, value] of FINITE_BAD) {
        cases.push({
          route: method,
          label: `${axis} ${label}`,
          params: { ...gesture, [axis]: value },
        });
      }
    }
    for (const [label, value] of BAD_STRING) {
      cases.push({
        route: method,
        label: `deviceId ${label}`,
        params: { ...gesture, deviceId: value },
      });
    }
    for (const cancel of ["true", 1, null]) {
      cases.push({
        route: method,
        label: `cancel ${JSON.stringify(cancel)}`,
        params: { ...gesture, cancel },
      });
    }
    cases.push({
      route: method,
      label: "gestureId before coords",
      params: { ...gesture, gestureId: "", x: "a" },
    });
    cases.push({ route: method, label: "x before y", params: { ...gesture, x: "a", y: "b" } });
    cases.push({
      route: method,
      label: "y before deviceId",
      params: { ...gesture, y: "b", deviceId: 3 },
    });
    cases.push({
      route: method,
      label: "deviceId before cancel",
      params: { ...gesture, deviceId: 3, cancel: 1 },
    });
  }
  return cases;
}
