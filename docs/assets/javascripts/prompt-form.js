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
(function () {
  var COPY_ICON =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M19 21H8V7h11m0-2H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2m-3-4H4a2 2 0 0 0-2 2v14h2V3h12z"/></svg>';
  var DONE_ICON =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M21 7 9 19l-5.5-5.5 1.41-1.41L9 16.17 19.59 5.59z"/></svg>';

  function updateVar(key, value) {
    var spans = document.querySelectorAll(
      '.prompt-var[data-prompt-var="' + key + '"]'
    );
    for (var i = 0; i < spans.length; i++) {
      var span = spans[i];
      span.textContent = value || span.getAttribute("data-default") || "";
    }
  }

  function wireInputs() {
    var inputs = document.querySelectorAll(
      "input[data-prompt-var], textarea[data-prompt-var]"
    );
    for (var i = 0; i < inputs.length; i++) {
      (function (input) {
        var key = input.getAttribute("data-prompt-var");
        input.addEventListener("input", function () {
          updateVar(key, input.value.trim());
        });
        updateVar(key, input.value.trim());
      })(inputs[i]);
    }
  }

  function legacyCopy(text) {
    return new Promise(function (resolve, reject) {
      var area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.top = "0";
      area.style.left = "0";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.focus();
      area.select();
      var ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (err) {
        ok = false;
      }
      document.body.removeChild(area);
      ok ? resolve() : reject(new Error("execCommand copy failed"));
    });
  }

  function copyText(text) {
    // The async Clipboard API needs a focused document and can reject even
    // after a real click; fall back to the legacy path when it does.
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () {
        return legacyCopy(text);
      });
    }
    return legacyCopy(text);
  }

  function wireCopyButtons() {
    var blocks = document.querySelectorAll(".copyable-prompt");
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      if (block.querySelector(":scope > .copy-prompt")) {
        continue; // already wired (document$ may re-run init)
      }
      var source = block.querySelector("blockquote") || block;
      var button = document.createElement("button");
      button.type = "button";
      button.className = "copy-prompt md-icon";
      button.title = "Copy prompt";
      button.setAttribute("aria-label", "Copy prompt");
      button.innerHTML = COPY_ICON;
      (function (button, source) {
        button.addEventListener("click", function () {
          copyText(source.innerText.trim()).then(
            function () {
              flash(button, true);
            },
            function () {
              flash(button, false);
            }
          );
        });
      })(button, source);
      block.appendChild(button);
    }
  }

  function flash(button, ok) {
    button.classList.add(ok ? "copy-prompt--done" : "copy-prompt--error");
    button.innerHTML = ok ? DONE_ICON : COPY_ICON;
    button.title = ok ? "Copied!" : "Copy failed";
    window.setTimeout(function () {
      button.classList.remove("copy-prompt--done", "copy-prompt--error");
      button.innerHTML = COPY_ICON;
      button.title = "Copy prompt";
    }, 1600);
  }

  function init() {
    wireInputs();
    wireCopyButtons();
  }

  // Material for MkDocs re-emits `document$` on every page load (including
  // instant navigation); fall back to a plain listener if it is unavailable.
  if (window.document$ && typeof window.document$.subscribe === "function") {
    window.document$.subscribe(init);
  } else if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
