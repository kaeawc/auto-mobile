import type { Raw } from "../prototypeTemplate";
import { el, type WebElement } from "./webNodes";
import type { NodeRenderer, WebRenderKit, WebRenderScope } from "./webRender";
import { textCss } from "./webStyle";

type Css = Record<string, string>;

const px = (value: number): string => `${Number(value.toFixed(3))}px`;

/** An integer state value at a key, clamped to `[0, max]`; anything else reads as 0. */
function stateInt(key: unknown, max: number, scope: WebRenderScope, kit: WebRenderKit): number {
  const value = typeof key === "string" ? scope.condition.state[kit.bound(key, scope)] : undefined;
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(Math.max(Math.trunc(value), 0), max)
    : 0;
}

const twoDigits = (value: number): string => String(value).padStart(2, "0");

/** `is24Hour` when authored, else the hour cycle of the still's locale, as Android follows the device. */
function uses24Hour(node: Raw, scope: WebRenderScope): boolean {
  if (typeof node.is24Hour === "boolean") {
    return node.is24Hour;
  }
  const cycle = new Intl.DateTimeFormat(scope.format.locale, { hour: "numeric" }).resolvedOptions()
    .hourCycle;
  return cycle === "h23" || cycle === "h24";
}

/** Material 3 time-picker geometry, in dp. */
const DIAL = 256;
const OUTER_RADIUS = 101;
const INNER_RADIUS = 69;
const SELECTOR = 48;

/** One 96x80 time box (hour or minute) in `displayLarge`, tinted when it is the selected field. */
function timeBox(text: string, selected: boolean, scope: WebRenderScope, kit: WebRenderKit) {
  return el(
    "span",
    {
      style: {
        display: "inline-flex",
        "align-items": "center",
        "justify-content": "center",
        width: "96px",
        height: "80px",
        "border-radius": "8px",
        ...textCss({ textStyle: "displayLarge" }, scope.style),
        ...kit.roleCss(
          scope,
          selected ? "primaryContainer" : "surfaceContainerHighest",
          selected ? "onPrimaryContainer" : "onSurface",
        ),
      },
    },
    [text],
  );
}

/** The 12-hour AM/PM selector: a 52x80 outlined column, the current period in `tertiaryContainer`. */
function periodSelector(pm: boolean, scope: WebRenderScope, kit: WebRenderKit): WebElement {
  const half = (label: string, selected: boolean) =>
    el(
      "span",
      {
        style: {
          display: "flex",
          flex: "1 1 0",
          "align-items": "center",
          "justify-content": "center",
          ...kit.roleCss(
            scope,
            selected ? "tertiaryContainer" : "transparent",
            selected ? "onTertiaryContainer" : "onSurfaceVariant",
          ),
        },
      },
      [label],
    );
  const outline = kit.roleCss(scope, "transparent", "outline").color ?? "currentColor";
  return el(
    "span",
    {
      attrs: { "data-part": "period" },
      style: {
        display: "flex",
        "flex-direction": "column",
        width: "52px",
        height: "80px",
        "margin-inline-start": "12px",
        overflow: "hidden",
        "box-sizing": "border-box",
        "border-radius": "8px",
        border: `1px solid ${outline}`,
        ...textCss({ textStyle: "titleMedium" }, scope.style),
      },
    },
    [half("AM", !pm), half("PM", pm)],
  );
}

/** A dial label centred `radius` from the dial's centre at `turn` twelfths of a turn clockwise. */
function dialPosition(turn: number, radius: number): Css {
  const angle = (turn / 12) * 2 * Math.PI;
  const x = DIAL / 2 + radius * Math.sin(angle) - SELECTOR / 2;
  const y = DIAL / 2 - radius * Math.cos(angle) - SELECTOR / 2;
  return {
    position: "absolute",
    left: px(x),
    top: px(y),
    width: px(SELECTOR),
    height: px(SELECTOR),
  };
}

interface DialRing {
  readonly labels: readonly string[];
  readonly radius: number;
}

/** The dial's rings: 12 to 11 on 12-hour clocks; 00 to 11 outside and 12 to 23 inside on 24-hour. */
function dialRings(is24: boolean): DialRing[] {
  const turns = Array.from({ length: 12 }, (_, turn) => turn);
  if (!is24) {
    return [{ labels: turns.map((turn) => String(turn === 0 ? 12 : turn)), radius: OUTER_RADIUS }];
  }
  return [
    { labels: turns.map((turn) => (turn === 0 ? "00" : String(turn))), radius: OUTER_RADIUS },
    { labels: turns.map((turn) => String(turn + 12)), radius: INNER_RADIUS },
  ];
}

/**
 * The hour dial: a 256 px `surfaceContainerHighest` disc with the hour labels, a 48 px `primary`
 * selector on the bound hour joined to an 8 px centre dot by a 2 px hand.
 */
function hourDial(hour: number, is24: boolean, scope: WebRenderScope, kit: WebRenderKit) {
  const turn = hour % 12;
  const radius = is24 && hour >= 12 ? INNER_RADIUS : OUTER_RADIUS;
  const primary = kit.roleCss(scope, "primary", "onPrimary");
  const hand = el("span", {
    attrs: { "data-part": "hand" },
    style: {
      position: "absolute",
      left: px(DIAL / 2 - 1),
      top: px(DIAL / 2 - radius),
      width: "2px",
      height: px(radius),
      "transform-origin": "50% 100%",
      transform: `rotate(${turn * 30}deg)`,
      ...primary,
    },
  });
  const selector = el("span", {
    attrs: { "data-part": "selector" },
    style: { ...dialPosition(turn, radius), "border-radius": "50%", ...primary },
  });
  const centre = el("span", {
    style: {
      position: "absolute",
      left: px(DIAL / 2 - 4),
      top: px(DIAL / 2 - 4),
      width: "8px",
      height: "8px",
      "border-radius": "50%",
      ...primary,
    },
  });
  const labels = dialRings(is24).flatMap((ring) =>
    ring.labels.map((label, at) => {
      const chosen = at === turn && ring.radius === radius;
      return el(
        "span",
        {
          style: {
            ...dialPosition(at, ring.radius),
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            ...(chosen ? { color: primary.color ?? "inherit" } : {}),
          },
        },
        [label],
      );
    }),
  );
  return el(
    "div",
    {
      attrs: { "data-part": "dial" },
      style: {
        position: "relative",
        width: px(DIAL),
        height: px(DIAL),
        "border-radius": "50%",
        ...textCss({ textStyle: "bodyLarge" }, scope.style),
        ...kit.roleCss(scope, "surfaceContainerHighest", "onSurface"),
      },
    },
    [hand, selector, centre, ...labels],
  );
}

/**
 * Material 3's time picker as it first appears: the hour and minute boxes (hour selected), the
 * AM/PM selector on a 12-hour clock, and the hour dial below.
 */
const timePickerRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (node, scope) => {
    const hour = stateInt(node.hourKey, 23, scope, kit);
    const minute = stateInt(node.minuteKey, 59, scope, kit);
    const is24 = uses24Hour(node, scope);
    const disabled = kit.disabledState(node, scope);
    const { attrs, style } = kit.base(node, scope, {
      display: "flex",
      "flex-direction": "column",
      "align-items": "center",
      gap: "36px",
      ...kit.roleCss(scope, "transparent", "onSurface"),
      ...disabled.css,
    });
    const shownHour = is24 ? hour : hour % 12 === 0 ? 12 : hour % 12;
    const clock = el(
      "div",
      { attrs: { "data-part": "clock" }, style: { display: "flex", "align-items": "center" } },
      [
        timeBox(twoDigits(shownHour), true, scope, kit),
        el(
          "span",
          {
            style: {
              width: "24px",
              "text-align": "center",
              ...textCss({ textStyle: "displayLarge" }, scope.style),
            },
          },
          [":"],
        ),
        timeBox(twoDigits(minute), false, scope, kit),
        ...(is24 ? [] : [periodSelector(hour >= 12, scope, kit)]),
      ],
    );
    const label = `${twoDigits(hour)}:${twoDigits(minute)}`;
    return el(
      "div",
      { attrs: { "aria-label": label, ...attrs, role: "group", ...disabled.attrs }, style },
      [clock, hourDial(hour, is24, scope, kit)],
    );
  };

interface CalendarDate {
  readonly year: number;
  /** Zero-based, as `Date.UTC` takes it. */
  readonly month: number;
  readonly day: number;
}

/** A bound `YYYY-MM-DD` value as a calendar date, or undefined when it is not one. */
function parseDate(value: unknown): CalendarDate | undefined {
  if (typeof value !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) {
    return undefined;
  }
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? { year, month: month - 1, day }
    : undefined;
}

/** The still's "today" in its time zone, from its fixed clock. */
function today(scope: WebRenderScope): CalendarDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: scope.format.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(scope.format.nowMs);
  return parseDate(parts) ?? { year: 1970, month: 0, day: 1 };
}

const sameDay = (a: CalendarDate | undefined, b: CalendarDate): boolean =>
  a !== undefined && a.year === b.year && a.month === b.month && a.day === b.day;

/** Formats a UTC calendar date in the still's locale. */
function formatDate(
  date: CalendarDate,
  options: Intl.DateTimeFormatOptions,
  scope: WebRenderScope,
) {
  return new Intl.DateTimeFormat(scope.format.locale, { ...options, timeZone: "UTC" }).format(
    Date.UTC(date.year, date.month, date.day),
  );
}

/** A 48 px calendar cell, its 40 px circle filled when selected and ringed when it is today. */
function dayCell(
  day: CalendarDate,
  marks: { selected: boolean; today: boolean },
  scope: WebRenderScope,
  kit: WebRenderKit,
): WebElement {
  const primary = kit.roleCss(scope, "primary", "onPrimary");
  const ring: Css =
    marks.today && !marks.selected
      ? {
          border: `1px solid ${primary["background-color"] ?? "currentColor"}`,
          color: primary["background-color"] ?? "inherit",
        }
      : {};
  const circle = el(
    "span",
    {
      style: {
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
        "box-sizing": "border-box",
        width: "40px",
        height: "40px",
        "border-radius": "50%",
        ...(marks.selected ? primary : {}),
        ...ring,
      },
    },
    [String(day.day)],
  );
  return el(
    "span",
    {
      attrs: { role: "gridcell", "aria-selected": String(marks.selected) },
      style: {
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
        height: "48px",
      },
    },
    [circle],
  );
}

/**
 * The displayed month: a weekday header (Sunday first, the still's `en-US` week) and its days, the
 * first offset to its weekday.
 */
function monthGrid(
  shown: CalendarDate,
  selected: CalendarDate | undefined,
  scope: WebRenderScope,
  kit: WebRenderKit,
): WebElement {
  const first = new Date(Date.UTC(shown.year, shown.month, 1)).getUTCDay();
  const length = new Date(Date.UTC(shown.year, shown.month + 1, 0)).getUTCDate();
  const now = today(scope);
  // 1970-01-04 was a Sunday.
  const weekdays = Array.from({ length: 7 }, (_, at) =>
    el(
      "span",
      {
        style: {
          display: "flex",
          "align-items": "center",
          "justify-content": "center",
          height: "48px",
        },
      },
      [formatDate({ year: 1970, month: 0, day: 4 + at }, { weekday: "narrow" }, scope)],
    ),
  );
  const blanks = Array.from({ length: first }, () => el("span"));
  const days = Array.from({ length }, (_, at) => {
    const day = { year: shown.year, month: shown.month, day: at + 1 };
    return dayCell(day, { selected: sameDay(selected, day), today: sameDay(day, now) }, scope, kit);
  });
  return el(
    "div",
    {
      attrs: { role: "grid", "data-part": "month" },
      style: {
        display: "grid",
        "grid-template-columns": "repeat(7, 48px)",
        "padding-inline": "12px",
        ...textCss({ textStyle: "bodyLarge" }, scope.style),
      },
    },
    [...weekdays, ...blanks, ...days],
  );
}

/** The header: "Select date" and the selected date (or "Selected date") as the headline. */
function dateHeader(selected: CalendarDate | undefined, scope: WebRenderScope, kit: WebRenderKit) {
  const headline = selected
    ? formatDate(selected, { month: "short", day: "numeric", year: "numeric" }, scope)
    : "Selected date";
  return [
    el(
      "span",
      {
        style: {
          padding: "16px 12px 0 24px",
          ...textCss({ textStyle: "labelLarge" }, scope.style),
          ...kit.roleCss(scope, "transparent", "onSurfaceVariant"),
        },
      },
      ["Select date"],
    ),
    el(
      "span",
      {
        attrs: { "data-part": "headline" },
        style: {
          padding: "36px 12px 12px 24px",
          ...textCss({ textStyle: "headlineLarge" }, scope.style),
        },
      },
      [headline],
    ),
    el("span", {
      style: { height: "1px", ...kit.roleCss(scope, "outlineVariant", "onSurface") },
    }),
  ];
}

/** The month row: the month and year with its year-menu arrow, then previous and next buttons. */
function monthRow(shown: CalendarDate, scope: WebRenderScope, kit: WebRenderKit): WebElement {
  const glyph = (name: string) => kit.icon({ type: "icon", name }, scope, "");
  const button = (name: string) =>
    el("span", { attrs: { role: "button", "aria-label": name }, style: { padding: "12px" } }, [
      glyph(name),
    ]);
  return el(
    "div",
    {
      style: {
        display: "flex",
        "align-items": "center",
        height: "56px",
        "padding-inline": "16px 12px",
        ...textCss({ textStyle: "titleSmall" }, scope.style),
        ...kit.roleCss(scope, "transparent", "onSurfaceVariant"),
      },
    },
    [
      el(
        "span",
        { style: { display: "flex", "align-items": "center", gap: "8px", flex: "1 1 auto" } },
        [formatDate(shown, { month: "long", year: "numeric" }, scope), glyph("arrow_drop_down")],
      ),
      button("chevron_left"),
      button("chevron_right"),
    ],
  );
}

/**
 * Material 3's date picker without the mode toggle, as Android draws it: the header and headline,
 * a divider, the month row and the bound date's month (today's when none is bound) with the bound
 * day filled and today ringed, on `surfaceContainerHigh`, 360 px wide.
 */
const datePickerRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (node, scope) => {
    const key = typeof node.stateKey === "string" ? kit.bound(node.stateKey, scope) : undefined;
    const selected = key === undefined ? undefined : parseDate(scope.condition.state[key]);
    const disabled = kit.disabledState(node, scope);
    const { attrs, style } = kit.base(node, scope, {
      display: "flex",
      "flex-direction": "column",
      width: "360px",
      "max-width": "100%",
      "padding-bottom": "8px",
      ...kit.roleCss(scope, "surfaceContainerHigh", "onSurface"),
      ...disabled.css,
    });
    const shown = selected ?? today(scope);
    return el("div", { attrs: { ...attrs, role: "group", ...disabled.attrs }, style }, [
      ...dateHeader(selected, scope, kit),
      monthRow(shown, scope, kit),
      monthGrid(shown, selected, scope, kit),
    ]);
  };

export function webPickerRenderers(kit: WebRenderKit): Record<string, NodeRenderer> {
  return { timePicker: timePickerRenderer(kit), datePicker: datePickerRenderer(kit) };
}
