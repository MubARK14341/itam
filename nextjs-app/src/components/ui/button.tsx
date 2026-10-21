import { forwardRef } from "react";

type Variant = "primary" | "outline" | "danger" | "ghost" | "danger-ghost";
type Size = "sm" | "md" | "icon" | "icon-sm";

const VARIANTS: Record<Variant, string> = {
  primary: "ui-button-primary",
  outline: "ui-button-outline",
  danger: "ui-button-danger",
  ghost: "ui-button-ghost",
  "danger-ghost": "ui-button-danger-ghost",
};
const SIZES: Record<Size, string> = {
  sm: "ui-button-sm",
  md: "ui-button-md",
  icon: "ui-button-md ui-button-icon",
  "icon-sm": "ui-button-sm ui-button-icon",
};

/** Class string for links styled as buttons (`<Link className={buttonClass(...)}>`). */
export function buttonClass(variant: Variant = "outline", size: Size = "md", className = "") {
  return `ui-button ${VARIANTS[variant]} ${SIZES[size]} ${className}`;
}

export const Button = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }
>(function Button({ variant = "primary", size = "md", className = "", ...props }, ref) {
  return (
    <button
      ref={ref}
      className={buttonClass(variant, size, className)}
      {...props}
    />
  );
});
