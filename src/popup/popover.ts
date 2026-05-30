// ────────────────────────────────────────────────────────────────────────────
// AccountMenu popover controller — a roving-focus `role="menu"` overlay
// anchored under the avatar trigger. Distinct from dropdown.ts (which mirrors
// a native <select>): this is a menu of heterogeneous rows (link rows + a
// signout row). Owns its own dim overlay + caret pointer.
//
// Behavior:
// - Click trigger: toggle open. While open: trigger.is-open + panel visible.
// - Click any menuitem: invoke caller-provided handler, close, return focus.
// - Click outside (excluding trigger + panel): close.
// - Escape: close + return focus to trigger.
// - Tab from last item: close (let Tab leave normally to next focusable).
// - ArrowDown/ArrowUp/Home/End: roving focus between menuitems.
// ────────────────────────────────────────────────────────────────────────────

export interface PopoverHandle {
  open(): void;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}

export interface PopoverConfig {
  trigger: HTMLElement;
  panel: HTMLElement;
  /** Optional sibling element shown as a dim/blur overlay. */
  dim?: HTMLElement | null;
  /** Called after open completes (so caller can refresh stale data). */
  onOpen?: () => void;
  /** Called after close completes. */
  onClose?: () => void;
}

export function attachPopover(cfg: PopoverConfig): PopoverHandle {
  const { trigger, panel, dim = null } = cfg;
  let open = false;

  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");

  function menuItems(): HTMLElement[] {
    return Array.from(panel.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  }

  function focusItem(idx: number) {
    const items = menuItems();
    if (items.length === 0) return;
    const i = Math.max(0, Math.min(items.length - 1, idx));
    items[i]?.focus();
  }

  function activeIndex(): number {
    const items = menuItems();
    return items.indexOf(document.activeElement as HTMLElement);
  }

  function show() {
    if (open) return;
    open = true;
    cfg.onOpen?.();
    panel.hidden = false;
    if (dim) dim.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    trigger.classList.add("is-open");
    document.addEventListener("mousedown", onDocMousedown, true);
    document.addEventListener("keydown", onDocKeydown, true);
    setTimeout(() => focusItem(0), 0);
  }

  function hide(returnFocus = true) {
    if (!open) return;
    open = false;
    panel.hidden = true;
    if (dim) dim.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    trigger.classList.remove("is-open");
    document.removeEventListener("mousedown", onDocMousedown, true);
    document.removeEventListener("keydown", onDocKeydown, true);
    if (returnFocus) trigger.focus();
    cfg.onClose?.();
  }

  function onDocMousedown(e: MouseEvent) {
    const t = e.target as Node | null;
    if (!t) return;
    if (panel.contains(t)) return;
    if (trigger.contains(t)) return;
    hide(false);
  }

  function onDocKeydown(e: KeyboardEvent) {
    if (!open) return;
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        hide();
        return;
      case "ArrowDown": {
        e.preventDefault();
        const items = menuItems();
        const i = activeIndex();
        focusItem(i < 0 ? 0 : (i + 1) % items.length);
        return;
      }
      case "ArrowUp": {
        e.preventDefault();
        const items = menuItems();
        const i = activeIndex();
        focusItem(i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length);
        return;
      }
      case "Home":
        e.preventDefault();
        focusItem(0);
        return;
      case "End": {
        e.preventDefault();
        const items = menuItems();
        focusItem(items.length - 1);
        return;
      }
      case "Tab":
        // Let Tab close the menu cleanly and yield to the next focusable
        // element in document order.
        hide(false);
        return;
    }
  }

  function onTriggerClick(e: MouseEvent) {
    e.preventDefault();
    if (open) hide();
    else show();
  }
  function onTriggerKeydown(e: KeyboardEvent) {
    if (open) return;
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault();
      show();
    }
  }

  trigger.addEventListener("click", onTriggerClick);
  trigger.addEventListener("keydown", onTriggerKeydown);

  return {
    open: show,
    close: () => hide(false),
    isOpen: () => open,
    destroy: () => {
      hide(false);
      trigger.removeEventListener("click", onTriggerClick);
      trigger.removeEventListener("keydown", onTriggerKeydown);
    },
  };
}
