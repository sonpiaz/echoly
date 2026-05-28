// ────────────────────────────────────────────────────────────────────────────
// Glassmorphic dropdown — a custom <listbox> overlay that replaces the native
// browser select popup. The native <select> stays in the DOM (hidden, visually
// invisible) so the existing TS keeps reading `.value` and the form contract
// is untouched; this controller mirrors picks into the select and dispatches
// a `change` event so all the existing event listeners fire as before.
//
// Why: native select popups can't be CSS-styled (they're drawn by the OS), so
// the design's Glassmorphic surfaces only worked for the trigger row, not the
// dropdown panel itself. With a real custom listbox we own both.
//
// Accessibility: trigger is role="combobox" + aria-expanded/aria-controls;
// panel is role="listbox"; options are role="option" with aria-selected.
// Keyboard: Enter/Space/ArrowDown open, ArrowUp/Down move active, Home/End
// jump, Enter/Space pick, Escape closes (focus returns to trigger), Tab closes.
// ────────────────────────────────────────────────────────────────────────────

export interface DropdownItem {
  value: string;
  primary: string;
  secondary?: string;
  /** Inline SVG / text rendered as the leading icon. The renderer wraps it
   *  in a `.dropdown-option-icon` slot. */
  iconHtml?: string;
  disabled?: boolean;
}

export interface DropdownConfig {
  /** The visible row the user clicks to open the panel. */
  trigger: HTMLElement;
  /** The hidden native <select> we mirror our pick into. */
  select: HTMLSelectElement;
  /** Lazy item supplier — called whenever the panel opens so option lists that
   *  change (e.g. voice list swaps with tier) stay in sync. */
  items: () => DropdownItem[];
  /** Optional: where to anchor the panel relative to the trigger row. */
  align?: "left" | "right" | "stretch";
  /** Optional: extra CSS class on the panel root (e.g. "dropdown-panel--lang"). */
  panelClass?: string;
}

export interface DropdownHandle {
  open(): void;
  close(): void;
  destroy(): void;
}

/** Attach a Glassmorphic dropdown to a trigger row. Returns a handle so the
 *  caller can imperatively open/close (used by the language picker's "swap"
 *  shortcut, for example). */
export function attachDropdown(cfg: DropdownConfig): DropdownHandle {
  const { trigger, select } = cfg;

  // Lazily-created panel — appended to <body> on first open so its position
  // isn't clipped by an ancestor with `overflow: hidden`.
  let panel: HTMLDivElement | null = null;
  let activeIndex = -1;
  let isOpen = false;
  let items: DropdownItem[] = [];

  // Mark the trigger as a combobox for screen readers. The native select
  // is hidden but kept focusable=false so the keyboard tab order goes
  // through the trigger only.
  trigger.setAttribute("role", "combobox");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.tabIndex = 0;
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");

  function buildPanel(): HTMLDivElement {
    const el = document.createElement("div");
    el.className = "dropdown-panel" + (cfg.panelClass ? ` ${cfg.panelClass}` : "");
    el.setAttribute("role", "listbox");
    el.hidden = true;
    el.tabIndex = -1;
    return el;
  }

  function positionPanel() {
    if (!panel) return;
    const rect = trigger.getBoundingClientRect();
    const align = cfg.align ?? "stretch";
    panel.style.position = "fixed";
    panel.style.top = `${rect.bottom + 4}px`;
    // Floor the "space below" arg so a near-bottom trigger doesn't collapse
    // the panel to 0px. The visual ceiling stays at 280px (design choice);
    // the floor keeps the panel usable even when scrolled near the edge.
    const below = Math.max(120, window.innerHeight - rect.bottom - 16);
    panel.style.maxHeight = `min(280px, ${below}px)`;
    if (align === "right") {
      panel.style.right = `${window.innerWidth - rect.right}px`;
      panel.style.left = "auto";
      panel.style.minWidth = `${Math.max(rect.width, 160)}px`;
    } else if (align === "left") {
      panel.style.left = `${rect.left}px`;
      panel.style.right = "auto";
      panel.style.minWidth = `${Math.max(rect.width, 160)}px`;
    } else {
      panel.style.left = `${rect.left}px`;
      panel.style.width = `${rect.width}px`;
    }
  }

  function render() {
    if (!panel) return;
    items = cfg.items();
    const fragment = document.createDocumentFragment();
    activeIndex = items.findIndex((it) => it.value === select.value);
    if (activeIndex < 0) activeIndex = 0;
    items.forEach((it, i) => {
      const opt = document.createElement("div");
      opt.className = "dropdown-option";
      opt.setAttribute("role", "option");
      opt.dataset.value = it.value;
      opt.id = `${select.id}-opt-${i}`;
      if (it.disabled) {
        opt.setAttribute("aria-disabled", "true");
        opt.classList.add("is-disabled");
      }
      const selected = it.value === select.value;
      opt.setAttribute("aria-selected", selected ? "true" : "false");
      if (selected) opt.classList.add("is-selected");
      if (i === activeIndex) opt.classList.add("is-active");

      if (it.iconHtml) {
        const ico = document.createElement("span");
        ico.className = "dropdown-option-icon";
        ico.innerHTML = it.iconHtml;
        opt.appendChild(ico);
      }
      const text = document.createElement("span");
      text.className = "dropdown-option-text";
      const p = document.createElement("span");
      p.className = "dropdown-option-primary";
      p.textContent = it.primary;
      text.appendChild(p);
      if (it.secondary) {
        const s = document.createElement("span");
        s.className = "dropdown-option-secondary";
        s.textContent = it.secondary;
        text.appendChild(s);
      }
      opt.appendChild(text);

      if (selected) {
        const check = document.createElement("span");
        check.className = "dropdown-option-check";
        check.setAttribute("aria-hidden", "true");
        check.innerHTML =
          '<svg viewBox="0 0 12 12"><path d="M2.5 6.5l2.5 2.5 4.5-5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        opt.appendChild(check);
      }

      opt.addEventListener("mousedown", (e) => {
        // mousedown fires before document-click-outside which would close
        // the panel from a re-rendered DOM node; pick here.
        e.preventDefault();
        if (it.disabled) return;
        pick(i);
      });
      opt.addEventListener("mouseenter", () => {
        setActive(i);
      });
      fragment.appendChild(opt);
    });
    panel.replaceChildren(fragment);
  }

  function setActive(i: number) {
    if (!panel) return;
    activeIndex = Math.max(0, Math.min(items.length - 1, i));
    const opts = panel.children;
    for (let k = 0; k < opts.length; k++) {
      const el = opts[k] as HTMLElement;
      el.classList.toggle("is-active", k === activeIndex);
    }
    const ae = opts[activeIndex] as HTMLElement | undefined;
    if (ae) {
      trigger.setAttribute("aria-activedescendant", ae.id);
      ae.scrollIntoView({ block: "nearest" });
    }
  }

  function pick(i: number) {
    const it = items[i];
    if (!it || it.disabled) return;
    if (select.value !== it.value) {
      select.value = it.value;
      // Dispatch a real change event so the existing popup listeners (which
      // call pushSettings + render helpers) fire as if the user used the
      // native control.
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    close();
  }

  function open() {
    if (isOpen) return;
    if (!panel) {
      panel = buildPanel();
      document.body.appendChild(panel);
    }
    isOpen = true;
    render();
    panel.hidden = false;
    positionPanel();
    trigger.setAttribute("aria-expanded", "true");
    trigger.classList.add("is-open");
    document.addEventListener("mousedown", onDocMousedown, true);
    document.addEventListener("keydown", onDocKeydown, true);
    window.addEventListener("resize", positionPanel);
    window.addEventListener("scroll", positionPanel, true);
    // Activate selected option for screen readers + keyboard.
    setActive(activeIndex);
  }

  function close(returnFocus = true) {
    if (!isOpen) return;
    isOpen = false;
    if (panel) panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    trigger.removeAttribute("aria-activedescendant");
    trigger.classList.remove("is-open");
    document.removeEventListener("mousedown", onDocMousedown, true);
    document.removeEventListener("keydown", onDocKeydown, true);
    window.removeEventListener("resize", positionPanel);
    window.removeEventListener("scroll", positionPanel, true);
    if (returnFocus) trigger.focus();
  }

  function onDocMousedown(e: MouseEvent) {
    const t = e.target as Node | null;
    if (!t) return;
    if (panel && panel.contains(t)) return;
    if (trigger.contains(t)) return;
    close(false);
  }

  function onDocKeydown(e: KeyboardEvent) {
    if (!isOpen) return;
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        close();
        return;
      case "ArrowDown":
        e.preventDefault();
        moveActive(1);
        return;
      case "ArrowUp":
        e.preventDefault();
        moveActive(-1);
        return;
      case "Home":
        e.preventDefault();
        setActive(0);
        return;
      case "End":
        e.preventDefault();
        setActive(items.length - 1);
        return;
      case "Enter":
      case " ":
        e.preventDefault();
        pick(activeIndex);
        return;
      case "Tab":
        close(false);
        return;
    }
  }

  function moveActive(delta: number) {
    if (items.length === 0) return;
    let i = activeIndex;
    for (let step = 0; step < items.length; step++) {
      i = (i + delta + items.length) % items.length;
      if (!items[i]?.disabled) break;
    }
    setActive(i);
  }

  // Trigger interactions
  function onTriggerMousedown(e: MouseEvent) {
    e.preventDefault();
    if (isOpen) close();
    else open();
  }
  function onTriggerKeydown(e: KeyboardEvent) {
    if (isOpen) return; // doc-level handler owns the open case
    switch (e.key) {
      case "Enter":
      case " ":
      case "ArrowDown":
      case "ArrowUp":
        e.preventDefault();
        open();
        return;
    }
  }

  trigger.addEventListener("mousedown", onTriggerMousedown);
  trigger.addEventListener("keydown", onTriggerKeydown);

  return {
    open,
    close: () => close(false),
    destroy: () => {
      close(false);
      trigger.removeEventListener("mousedown", onTriggerMousedown);
      trigger.removeEventListener("keydown", onTriggerKeydown);
      if (panel) {
        panel.remove();
        panel = null;
      }
    },
  };
}
