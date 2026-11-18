import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useEscCloseTopmost } from "../hooks/useEscClose";
import { Check, ChevronDown, GripVertical } from "lucide-react";
import "./SingleSelectDropdown.css";
import { dropdownLayer, dropdownPlacement, type DropdownPlacement } from "../utils/dropdownPlacement";

const ENABLED_OPTION_SELECTOR = '[role="option"]:not(:disabled)';

export interface SingleSelectOption {
  value: string;
  label: string;
  badge?: ReactNode;
  disabled?: boolean;
}

interface SingleSelectDropdownProps {
  value: string;
  options: SingleSelectOption[];
  onChange: (value: string) => void;
  className?: string;
  menuClassName?: string;
  disabled?: boolean;
  ariaLabel?: string;
  placeholder?: string;
  search?: { label: string; emptyLabel: string };
  menuPlacement?: "down" | "up";
  menuWidth?: number;
  menuMaxHeight?: number;
  reorder?: { onMove: (from: string, to: string) => void; handleLabel: string };
}

export function SingleSelectDropdown({
  value,
  options,
  onChange,
  className,
  menuClassName,
  disabled = false,
  ariaLabel,
  placeholder,
  search,
  menuPlacement = "down",
  menuWidth,
  menuMaxHeight = 280,
  reorder,
}: SingleSelectDropdownProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [menuStyle, setMenuStyle] = useState<DropdownPlacement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const drag = useRef<{ value: string; pointerId: number; x: number; y: number } | null>(null);
  const dragFrame = useRef<number | null>(null);
  const deferredMenuPosition = useRef<(() => void) | null>(null);
  const [dropTarget, setDropTarget] = useState<{ value: string; edge: "before" | "after" } | null>(null);
  const listId = useId();

  const finishDrag = () => {
    drag.current = null;
    if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current);
    dragFrame.current = null;
    setDropTarget(null);
    deferredMenuPosition.current?.();
    deferredMenuPosition.current = null;
  };

  useEffect(() => () => {
    if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current);
  }, []);

  function pointerTarget(x: number, y: number) {
    const row = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-option-value]");
    return row && menuRef.current?.contains(row) ? row.dataset.optionValue : undefined;
  }

  function updateDrag() {
    const current = drag.current;
    const menu = menuRef.current;
    if (!current || !menu) return;
    const rect = menu.getBoundingClientRect();
    if (current.x >= rect.left && current.x < rect.right && current.y >= rect.top && current.y < rect.bottom) {
      const edge = 28;
      const top = current.y - rect.top;
      const bottom = rect.bottom - current.y;
      if (top < edge) menu.scrollTop -= Math.ceil((edge - top) / 4);
      else if (bottom < edge) menu.scrollTop += Math.ceil((edge - bottom) / 4);
    }
    const to = pointerTarget(current.x, current.y);
    if (!to || to === current.value) setDropTarget(null);
    else {
      const edge = options.findIndex(item => item.value === current.value) < options.findIndex(item => item.value === to) ? "after" : "before";
      setDropTarget(previous => previous?.value === to && previous.edge === edge ? previous : { value: to, edge });
    }
    dragFrame.current = requestAnimationFrame(updateDrag);
  }

  const closeMenu = () => { setOpen(false); triggerRef.current?.focus(); };
  useEscCloseTopmost(open, closeMenu, menuRef);
  useEffect(() => {
    if (open && menuStyle) {
      (searchRef.current
        ?? menuRef.current?.querySelector<HTMLElement>(`${ENABLED_OPTION_SELECTOR}[aria-selected="true"]`)
        ?? menuRef.current?.querySelector<HTMLElement>(ENABLED_OPTION_SELECTOR))?.focus();
    }
  }, [open, Boolean(menuStyle)]);
  useEffect(() => {
    if (!open) {
      setQuery("");
      finishDrag();
    }
  }, [open]);

  const selectedOption = useMemo(
    () => options.find((option) => option.value === value) ?? null,
    [options, value],
  );

  useEffect(() => {
    if (!open) return;

    const updateMenuPosition = (event?: Event) => {
      const eventTarget = event?.target;
      if (
        event?.type === "scroll" &&
        eventTarget instanceof Node &&
        menuRef.current?.contains(eventTarget)
      ) {
        return;
      }
      // Keep the rows under the pointer when WebView2 scrolls the outer form.
      if (drag.current) {
        deferredMenuPosition.current = () => updateMenuPosition();
        return;
      }
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const layers: string[] = [];
      for (let ancestor: Element | null = triggerRef.current; ancestor; ancestor = ancestor.parentElement) {
        layers.push(window.getComputedStyle(ancestor).zIndex);
      }
      const nextStyle = dropdownPlacement(rect, { width: window.innerWidth, height: window.innerHeight },
        menuPlacement, menuWidth, menuMaxHeight, dropdownLayer(layers));
      setMenuStyle((prev) =>
        prev &&
        prev.top === nextStyle.top &&
        prev.bottom === nextStyle.bottom &&
        prev.left === nextStyle.left &&
        prev.width === nextStyle.width &&
        prev.maxHeight === nextStyle.maxHeight &&
        prev.zIndex === nextStyle.zIndex
          ? prev
          : nextStyle,
      );
    };

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (rootRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };

    updateMenuPosition();
    // 延迟绑定，避免与打开触发器同一次 pointer/click 立刻关掉菜单。
    const timer = window.setTimeout(() => {
      document.addEventListener("mousedown", handlePointerDown);
    }, 0);
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);

    return () => {
      deferredMenuPosition.current = null;
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [menuMaxHeight, menuPlacement, menuWidth, open]);

  useEffect(() => {
    if (!disabled) return;
    setOpen(false);
  }, [disabled]);

  const currentLabel = selectedOption?.label ?? placeholder ?? "";
  const normalizedQuery = search ? query.trim().toLowerCase() : "";
  const visibleOptions = normalizedQuery
    ? options.filter((option) => option.label.toLowerCase().includes(normalizedQuery))
    : options;
  const activeReorder = normalizedQuery ? undefined : reorder;

  return (
    <div
      ref={rootRef}
      className={[
        "single-select-dropdown",
        disabled ? "disabled" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`single-select-dropdown-trigger${open ? " open" : ""}`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open && menuStyle ? listId : undefined}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        onClick={() => {
          if (disabled) return;
          setOpen((prev) => !prev);
        }}
        disabled={disabled}
      >
        <span className="single-select-dropdown-value" title={currentLabel}>
          {currentLabel}
        </span>
        {selectedOption?.badge}
        <span className="single-select-dropdown-arrow">
          <ChevronDown size={16} />
        </span>
      </button>

      {open && menuStyle
        ? createPortal(
            <div
              ref={menuRef}
              className={[
                "single-select-dropdown-menu",
                search ? "searchable" : "",
                menuClassName ?? "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{
                position: "fixed",
                top: menuStyle.top !== undefined ? `${menuStyle.top}px` : "auto",
                bottom: menuStyle.bottom !== undefined ? `${menuStyle.bottom}px` : "auto",
                left: `${menuStyle.left}px`,
                width: `${menuStyle.width}px`,
                maxHeight: `${menuStyle.maxHeight}px`,
                zIndex: menuStyle.zIndex,
              }}
              onKeyDown={(event) => {
                const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>(ENABLED_OPTION_SELECTOR) ?? []);
                if (event.key === "Tab") { event.preventDefault(); closeMenu(); return; }
                const active = document.activeElement;
                if (searchRef.current && active === searchRef.current) {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === "Enter") event.preventDefault();
                  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                }
                if (!items.length) return;
                const index = items.indexOf(active as HTMLElement);
                if (activeReorder && index >= 0 && event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                  event.preventDefault();
                  const from = items[index].dataset.optionValue;
                  const to = items[index + (event.key === "ArrowUp" ? -1 : 1)]?.dataset.optionValue;
                  if (from && to) {
                    activeReorder.onMove(from, to);
                    requestAnimationFrame(() => items[index].focus());
                  }
                  return;
                }
                if (searchRef.current && (
                  (event.key === "ArrowUp" && index === 0) ||
                  (event.key === "ArrowDown" && index === items.length - 1)
                )) {
                  event.preventDefault();
                  searchRef.current.focus();
                  return;
                }
                const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
                  : event.key === "ArrowDown" ? (index + 1) % items.length
                  : event.key === "ArrowUp" ? (index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length) : -1;
                if (next >= 0) { event.preventDefault(); items[next].focus(); }
              }}
            >
              {search && (
                <div className="single-select-dropdown-search">
                  <input
                    ref={searchRef}
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={search.label}
                    aria-label={search.label}
                    aria-controls={listId}
                  />
                </div>
              )}
              <div id={listId} role="listbox" aria-label={ariaLabel}>
                {visibleOptions.map((option) => {
                  const active = option.value === value;
                  const reorderable = activeReorder && !option.disabled;
                  const dropClass = dropTarget?.value === option.value ? ` drop-${dropTarget.edge}` : "";
                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={`single-select-dropdown-item${active ? " active" : ""}${dropClass}`}
                      data-option-value={reorderable ? option.value : undefined}
                      disabled={option.disabled}
                      onClick={() => {
                        if (option.disabled) return;
                        onChange(option.value);
                        closeMenu();
                      }}
                      role="option"
                      aria-selected={active}
                      aria-disabled={option.disabled || undefined}
                      aria-keyshortcuts={reorderable ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
                      tabIndex={search ? -1 : undefined}
                    >
                      {reorderable && <span className="single-select-dropdown-drag-handle" title={activeReorder.handleLabel}
                        aria-hidden="true" onClick={event => event.stopPropagation()}
                        onPointerDown={event => {
                          if (event.button !== 0 || !event.isPrimary || drag.current) return;
                          event.preventDefault();
                          event.currentTarget.setPointerCapture(event.pointerId);
                          drag.current = { value: option.value, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
                        }}
                        onPointerMove={event => {
                          const current = drag.current;
                          if (current?.pointerId !== event.pointerId) return;
                          current.x = event.clientX;
                          current.y = event.clientY;
                          if (dragFrame.current === null) updateDrag();
                        }}
                        onPointerUp={event => {
                          const current = drag.current;
                          if (current?.pointerId !== event.pointerId) return;
                          const to = pointerTarget(event.clientX, event.clientY);
                          finishDrag();
                          if (to && to !== current.value) activeReorder.onMove(current.value, to);
                        }}
                        onLostPointerCapture={event => {
                          if (drag.current?.pointerId === event.pointerId) finishDrag();
                        }}>
                        <GripVertical size={15} />
                      </span>}
                      <span
                        className="single-select-dropdown-item-label"
                        title={option.label}
                      >
                        {option.label}
                      </span>
                      {option.badge}
                      <span className="single-select-dropdown-item-check">
                        {active ? <Check size={15} /> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
              {search && visibleOptions.length === 0 && (
                <div className="single-select-dropdown-empty" role="status">{search.emptyLabel}</div>
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
