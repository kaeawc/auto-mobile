// Description toggle for tool tables (docs/tools.md and each tool page).
//
// A tool table is any table with a generated Platforms cell (`.tool-platforms`).
// A "Show descriptions" / "Hide descriptions" button goes above each one and
// hides or shows its "What it does" column. Every button on a page shares one
// state. Descriptions start hidden on narrow screens, where the column pushes
// Platforms and Needs off the edge, and shown everywhere else.

// Material for MkDocs exposes a `document$` observable on `window` for its
// instant-navigation lifecycle; it is not part of the DOM typings, so view it
// through a narrow cast rather than augmenting the global Window.
const mkdocsWindow = window as unknown as {
  document$?: { subscribe(next: () => void): void };
};

/** Material's own phone breakpoint (`md-typeset` tables scroll below it). */
const NARROW_SCREEN = "(max-width: 44.984em)";
const DESCRIPTION_HEADER = "What it does";
const TABLE_SELECTOR = "table:has(.tool-platforms)";
/** Set on a table while its description column is hidden; the stylesheet keys on it. */
const BRIEF_ATTRIBUTE = "data-tool-brief";
const DESCRIPTION_CLASS = "tool-desc";
const TOGGLE_CLASS = "tool-desc-toggle";

function descriptionColumn(table: HTMLTableElement): number {
  const headers = Array.from(table.querySelectorAll("thead th"));
  return headers.findIndex((cell) => cell.textContent?.trim() === DESCRIPTION_HEADER);
}

function markDescriptionCells(table: HTMLTableElement, column: number): void {
  for (const row of Array.from(table.rows)) {
    row.cells[column]?.classList.add(DESCRIPTION_CLASS);
  }
}

function applyState(shown: boolean): void {
  for (const table of Array.from(document.querySelectorAll<HTMLTableElement>(TABLE_SELECTOR))) {
    table.toggleAttribute(BRIEF_ATTRIBUTE, !shown);
  }
  for (const button of Array.from(
    document.querySelectorAll<HTMLButtonElement>("." + TOGGLE_CLASS),
  )) {
    button.textContent = shown ? "Hide descriptions" : "Show descriptions";
    button.setAttribute("aria-expanded", String(shown));
  }
}

/** The element to put the button before: Material's scroll wrapper, or the table itself. */
function anchorFor(table: HTMLTableElement): Element {
  return table.closest(".md-typeset__scrollwrap") ?? table;
}

function init(): void {
  const tables = Array.from(document.querySelectorAll<HTMLTableElement>(TABLE_SELECTOR)).filter(
    (table) => descriptionColumn(table) !== -1,
  );
  if (tables.length === 0) {
    return;
  }
  for (const table of tables) {
    markDescriptionCells(table, descriptionColumn(table));
    const button = document.createElement("button");
    button.type = "button";
    button.className = TOGGLE_CLASS;
    button.addEventListener("click", () => {
      applyState(button.getAttribute("aria-expanded") !== "true");
    });
    anchorFor(table).before(button);
  }
  applyState(!window.matchMedia(NARROW_SCREEN).matches);
}

// Material for MkDocs re-emits `document$` on every page load (including
// instant navigation); fall back to a plain listener if it is unavailable.
if (mkdocsWindow.document$ && typeof mkdocsWindow.document$.subscribe === "function") {
  mkdocsWindow.document$.subscribe(init);
} else if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// A module, so its names stay out of the other docs scripts' shared script scope.
export {};
