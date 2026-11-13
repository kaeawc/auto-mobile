import { ActionableError } from "../../models/ActionableError";
import type { CarAppProjectedTemplates } from "../../models/CarAppTemplates";
import { HEAD_UNIT_DISPLAY } from "./HeadUnitInteraction";

/**
 * `tapOn` by text on the projected head unit (#17842). The Car App Library template snapshot names
 * the rows and actions an app built, but not where the host drew them, so a match is reported with
 * where it sits instead of being tapped.
 */

type ProjectedSession = CarAppProjectedTemplates["projected"][number]["sessions"][number];
type TopTemplate = NonNullable<ProjectedSession["screens"][number]["template"]>;
/** The fields a text selector reads, shared by a top template and a tab's content. */
type TemplateFields = Pick<
  TopTemplate,
  "type" | "title" | "items" | "tabs" | "headerActions" | "actions" | "actionStrips"
>;

/** One labelled thing on a projected top template that a text selector can name. */
export interface HeadUnitTemplateTarget {
  packageName: string;
  screenClass: string;
  templateType: string;
  templateTitle?: string;
  kind: "item" | "action" | "tab";
  /** The item's title, or the action's or tab's title. */
  label: string;
  /** The item's secondary lines. */
  texts: string[];
  /** 1-based position among the template's items, absent for actions and tabs. */
  position?: number;
  itemCount?: number;
}

function actionTargets(template: TemplateFields): Pick<HeadUnitTemplateTarget, "kind" | "label">[] {
  return [
    ...template.headerActions,
    ...template.actions,
    ...template.actionStrips.flatMap((strip) => strip.actions),
  ].flatMap((action) =>
    action.title === undefined ? [] : [{ kind: "action" as const, label: action.title }],
  );
}

function templateTargets(
  template: TemplateFields,
  where: Pick<HeadUnitTemplateTarget, "packageName" | "screenClass">,
): HeadUnitTemplateTarget[] {
  const base = {
    ...where,
    templateType: template.type,
    ...(template.title === undefined ? {} : { templateTitle: template.title }),
  };
  const items = template.items.map((item, index) => ({
    ...base,
    kind: "item" as const,
    label: item.title ?? item.texts[0] ?? "",
    texts: item.title === undefined ? item.texts.slice(1) : item.texts,
    position: index + 1,
    itemCount: template.items.length,
  }));
  const tabs = template.tabs.flatMap((tab) =>
    tab.title === undefined ? [] : [{ ...base, kind: "tab" as const, label: tab.title, texts: [] }],
  );
  const actions = actionTargets(template).map((target) => ({ ...base, ...target, texts: [] }));
  return [...items, ...tabs, ...actions];
}

/** Every labelled row, tab and action on each projected session's top template, in block order. */
export function headUnitTemplateTargets(
  templates: CarAppProjectedTemplates,
): HeadUnitTemplateTarget[] {
  return templates.projected.flatMap((app) =>
    app.sessions.flatMap((session) => {
      const top = session.screens.at(-1);
      if (!top?.template) {
        return [];
      }
      const where = { packageName: app.packageName, screenClass: top.screenClass };
      const tabContent = top.template.tabContent;
      return [
        ...templateTargets(top.template, where),
        ...(tabContent ? templateTargets(tabContent, where) : []),
      ];
    }),
  );
}

function textMatches(candidate: string, text: string, exact: boolean): boolean {
  const a = candidate.toLowerCase();
  const b = text.toLowerCase();
  return exact ? a === b : a.includes(b);
}

/** Targets whose label or secondary lines match `text`, case-insensitive. */
export function matchHeadUnitTemplateTargets(
  targets: readonly HeadUnitTemplateTarget[],
  text: string,
  exact = false,
): HeadUnitTemplateTarget[] {
  return targets.filter((target) =>
    [target.label, ...target.texts].some((candidate) => textMatches(candidate, text, exact)),
  );
}

function shortClass(screenClass: string): string {
  return screenClass.split(".").at(-1) ?? screenClass;
}

/** Where a match sits, in words: `row 1 of 5 in ListTemplate "Menu" on MenuScreen`. */
export function describeHeadUnitTarget(target: HeadUnitTemplateTarget): string {
  const kind =
    target.kind === "item" ? `row ${target.position} of ${target.itemCount}` : target.kind;
  const template = `${target.templateType}${target.templateTitle === undefined ? "" : ` "${target.templateTitle}"`}`;
  return `"${target.label}" (${kind} in ${template} on ${shortClass(target.screenClass)}, ${target.packageName})`;
}

const USE_INSTEAD = `Use tapAt display "${HEAD_UNIT_DISPLAY}" at head-unit pixels, or pressButton display "${HEAD_UNIT_DISPLAY}" (up, down, select) to move focus to it and select it.`;

const MAX_LISTED = 10;

/**
 * Resolves `tapOn` text against the projected templates and always throws: with the match and
 * where it is, with the labels on screen when nothing matched, or when there is no snapshot.
 */
export function refuseHeadUnitTapOn(
  templates: CarAppProjectedTemplates | undefined,
  texts: readonly string[],
  exact = false,
): never {
  const targets = templates ? headUnitTemplateTargets(templates) : [];
  if (targets.length === 0) {
    throw new ActionableError(
      `tapOn display "${HEAD_UNIT_DISPLAY}" resolves text against a projected app's Car App Library templates, and no projected app reported one (enable the AutoMobile template route in the app). ${USE_INSTEAD}`,
    );
  }
  const matches = texts.flatMap((text) => matchHeadUnitTemplateTargets(targets, text, exact));
  if (matches.length === 0) {
    const labels = [...new Set(targets.map((target) => `"${target.label}"`))];
    const shown = labels.slice(0, MAX_LISTED).join(", ");
    const more = labels.length > MAX_LISTED ? `, and ${labels.length - MAX_LISTED} more` : "";
    throw new ActionableError(
      `tapOn display "${HEAD_UNIT_DISPLAY}" found no row, tab or action matching ${texts.map((text) => `"${text}"`).join(" or ")} on the projected top templates. On them: ${shown}${more}.`,
    );
  }
  const found = matches.map(describeHeadUnitTarget).join("; ");
  throw new ActionableError(
    `tapOn display "${HEAD_UNIT_DISPLAY}" found ${found}, but the template snapshot does not say where the head unit draws it, so tapOn cannot tap it. ${USE_INSTEAD}`,
  );
}
