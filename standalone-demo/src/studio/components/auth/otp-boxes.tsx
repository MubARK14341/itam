"use client";

import type { InputHTMLAttributes } from "react";

const LENGTH = 6;

/**
 * Six single-digit boxes backed by ONE real text input. The input is laid
 * transparently over the boxes, so typing, paste, password-manager / SMS
 * one-time-code autofill and all input semantics (id, autocomplete,
 * inputMode, label) stay on the real field; the boxes are aria-hidden visuals.
 */
export function OtpBoxes({
  value, invalid, className = "", ...inputProps
}: Omit<InputHTMLAttributes<HTMLInputElement>, "value"> & { value: string; invalid?: boolean }) {
  const current = Math.min(value.length, LENGTH - 1);
  const keepCaretAtEnd = (input: HTMLInputElement) => {
    const end = input.value.length;
    input.setSelectionRange(end, end);
  };
  return (
    <div dir="ltr" className={`group relative grid grid-cols-6 gap-2 sm:gap-2.5 ${className}`}>
      {Array.from({ length: LENGTH }, (_, index) => {
        const digit = value[index] ?? "";
        const isCurrent = index === current;
        return (
          <span
            key={index}
            aria-hidden="true"
            className={[
              "flex h-14 items-center justify-center rounded-xl border font-mono text-2xl font-medium tabular-nums transition-colors",
              invalid
                ? "border-bad bg-bad-soft text-bad"
                : `border-line-strong text-fg group-hover:border-muted ${digit ? "bg-surface-2" : "bg-surface"}`,
              isCurrent && !invalid ? "group-focus-within:border-brand group-focus-within:ring-[3px] group-focus-within:ring-brand-soft" : "",
            ].join(" ")}
          >
            {digit || (isCurrent ? <span className="hidden h-6 w-0.5 animate-pulse rounded-sm bg-brand group-focus-within:block" /> : null)}
          </span>
        );
      })}
      <input
        {...inputProps}
        value={value}
        aria-invalid={invalid ? true : undefined}
        onFocus={(event) => { keepCaretAtEnd(event.currentTarget); inputProps.onFocus?.(event); }}
        onClick={(event) => { keepCaretAtEnd(event.currentTarget); inputProps.onClick?.(event); }}
        className="absolute inset-0 m-0 h-full w-full cursor-text border-0 p-0 text-base opacity-0"
      />
    </div>
  );
}
