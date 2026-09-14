import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { SfSymbol } from "./sf-symbol";

export function DetailPropertyPicker<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly {
    value: T;
    label: string;
    icon: ReactNode;
    disabled?: boolean;
    disabledReason?: string | undefined;
  }[];
  readonly disabled: boolean;
  readonly onChange: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const selected = options.find((option) => option.value === value)!;
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return (
    <div
      className="detail-property-picker"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setOpen(false);
          trigger.current?.focus();
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        if (!open) {
          setOpen(true);
          return;
        }
        const buttons = Array.from(
          root.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? [],
        );
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="detail-property-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        {selected.icon}
        <span>{selected.label}</span>
        <SfSymbol name="chevron.right" size={12} />
      </button>
      {open && !disabled && (
        <div id={id} role="listbox" aria-label={`${label}选项`} className="detail-property-menu">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              disabled={option.disabled}
              title={option.disabled ? (option.disabledReason ?? "只能切换到相邻列") : undefined}
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
                onChange(option.value);
              }}
            >
              {option.icon}
              <span>{option.label}</span>
              {value === option.value && <SfSymbol name="checkmark" size={12} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
