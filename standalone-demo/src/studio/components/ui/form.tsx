import { Search, X } from "lucide-react";
import {
  cloneElement,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";

const inputBaseClass =
  "min-h-[42px] w-full rounded-control border border-line-strong bg-surface py-2.5 text-[13px] text-fg outline-none transition-colors hover:border-muted focus:border-brand-ink focus:ring-2 focus:ring-brand-ink/15 disabled:cursor-not-allowed disabled:bg-sunk disabled:opacity-70 aria-[invalid=true]:border-bad max-md:min-h-11 dark:[color-scheme:dark]";

export const inputClass = `${inputBaseClass} px-3`;

export function SearchInput({
  label,
  clearLabel,
  onClear,
  containerClassName = "",
  className = "",
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "aria-label"> & {
  label: string;
  clearLabel?: string;
  onClear?: () => void;
  containerClassName?: string;
}) {
  const hasValue = typeof props.value === "string" && props.value.length > 0;
  return (
    <div className={`relative ${containerClassName}`}>
      <Search aria-hidden="true" className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
      <input
        type="search"
        aria-label={label}
        className={`${inputBaseClass} ps-9 ${onClear ? "pe-11" : "pe-3"} ${className}`}
        {...props}
      />
      {onClear && hasValue ? (
        <button
          type="button"
          onClick={onClear}
          aria-label={clearLabel ?? label}
          className="absolute inset-y-0 end-0 inline-flex w-10 items-center justify-center rounded-e-control text-muted transition-colors hover:bg-sunk hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-ink"
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}

export function Field({
  label, required, error, children, hint,
}: {
  label: string; required?: boolean; error?: string; hint?: string; children: ReactNode;
}) {
  const generatedId = useId();
  const validChild = isValidElement<Record<string, unknown>>(children);
  const providedId = validChild && typeof children.props.id === "string"
    ? children.props.id
    : undefined;
  const controlId = providedId ?? `${generatedId}-control`;
  const hintId = `${generatedId}-hint`;
  const errorId = `${generatedId}-error`;
  const describedBy = error ? errorId : hint ? hintId : undefined;
  const child = validChild
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        id: controlId,
        ...(required ? { required: true } : {}),
        ...(describedBy ? { "aria-describedby": describedBy } : {}),
        ...(error ? { "aria-invalid": true } : {}),
      })
    : children;

  return (
    <div>
      <label htmlFor={controlId} className="ui-label">
        {label} {required && <span aria-hidden="true" className="text-bad">*</span>}
      </label>
      {child}
      {hint && !error && <p id={hintId} className="ui-hint">{hint}</p>}
      {error && <p id={errorId} role="alert" className="mt-1.5 text-xs font-medium text-bad">{error}</p>}
    </div>
  );
}

export function Select({
  value, onChange, options, placeholder, disabled, label, ...accessibilityProps
}: {
  id?: string; value: string; onChange: (v: string) => void; disabled?: boolean; required?: boolean;
  options: { value: string; label: string }[]; placeholder?: string;
  label?: string; "aria-label"?: string; "aria-describedby"?: string; "aria-invalid"?: boolean;
}) {
  const accessibleName = accessibilityProps["aria-label"] ?? label ?? placeholder;
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={inputClass}
      {...accessibilityProps}
      aria-label={accessibleName}
    >
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}
