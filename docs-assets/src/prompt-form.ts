// Prompt enhancements for example prompts.
//
// 1. Live placeholders. Any page can add an input that fills a named variable
//    into example prompts:
//
//      <input data-prompt-var="app" placeholder="e.g. Acme Shopping">
//      ...
//      > Open my <code class="prompt-var" data-prompt-var="app"
//      >   data-default="your app">your app</code> app and explore it.
//
//    Every `.prompt-var` whose `data-prompt-var` matches an input's updates as
//    the user types, falling back to its `data-default` when the input is empty.
//
// 2. One-click copy. Wrap a prompt in `<div class="copyable-prompt" markdown>`
//    and a copy button is added that copies the prompt's current text (with any
//    live placeholders already substituted).

// Material for MkDocs exposes a `document$` observable on `window` for its
// instant-navigation lifecycle; it is not part of the DOM typings, so view it
// through a narrow cast rather than augmenting the global Window.
const mkdocsWindow = window as unknown as {
  document$?: { subscribe(next: () => void): void };
};

const COPY_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M19 21H8V7h11m0-2H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2m-3-4H4a2 2 0 0 0-2 2v14h2V3h12z"/></svg>';
const DONE_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M21 7 9 19l-5.5-5.5 1.41-1.41L9 16.17 19.59 5.59z"/></svg>';

function updateVar(key: string, value: string): void {
  const spans = document.querySelectorAll<HTMLElement>(
    '.prompt-var[data-prompt-var="' + key + '"]',
  );
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    span.textContent = value || span.getAttribute("data-default") || "";
  }
}

function wireInputs(): void {
  const inputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    "input[data-prompt-var], textarea[data-prompt-var]",
  );
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const key = input.getAttribute("data-prompt-var") || "";
    input.addEventListener("input", function () {
      updateVar(key, input.value.trim());
    });
    updateVar(key, input.value.trim());
  }
}

function legacyCopy(text: string): Promise<void> {
  return new Promise(function (resolve, reject) {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.top = "0";
    area.style.left = "0";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.focus();
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    document.body.removeChild(area);
    if (ok) {
      resolve();
    } else {
      reject(new Error("execCommand copy failed"));
    }
  });
}

function copyText(text: string): Promise<void> {
  // The async Clipboard API needs a focused document and can reject even
  // after a real click; fall back to the legacy path when it does.
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(function () {
      return legacyCopy(text);
    });
  }
  return legacyCopy(text);
}

function wireCopyButtons(): void {
  const blocks = document.querySelectorAll<HTMLElement>(".copyable-prompt");
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.querySelector(":scope > .copy-prompt")) {
      continue; // already wired (document$ may re-run init)
    }
    const source = block.querySelector<HTMLElement>("blockquote") || block;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "copy-prompt md-icon";
    button.title = "Copy prompt";
    button.setAttribute("aria-label", "Copy prompt");
    button.innerHTML = COPY_ICON;
    button.addEventListener("click", function () {
      copyText(source.innerText.trim()).then(
        function () {
          flash(button, true);
        },
        function () {
          flash(button, false);
        },
      );
    });
    block.appendChild(button);
  }
}

function flash(button: HTMLButtonElement, ok: boolean): void {
  button.classList.add(ok ? "copy-prompt--done" : "copy-prompt--error");
  button.innerHTML = ok ? DONE_ICON : COPY_ICON;
  button.title = ok ? "Copied!" : "Copy failed";
  window.setTimeout(function () {
    button.classList.remove("copy-prompt--done", "copy-prompt--error");
    button.innerHTML = COPY_ICON;
    button.title = "Copy prompt";
  }, 1600);
}

function init(): void {
  wireInputs();
  wireCopyButtons();
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
