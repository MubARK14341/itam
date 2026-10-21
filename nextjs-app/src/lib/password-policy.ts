export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

export type PasswordPolicyError =
  | "required"
  | "too_short"
  | "too_long"
  | "insufficient_variety";

export function passwordPolicyError(password: string): PasswordPolicyError | null {
  if (!password) return "required";
  const characters = Array.from(password);
  if (characters.length < MIN_PASSWORD_LENGTH) return "too_short";
  if (characters.length > MAX_PASSWORD_LENGTH) return "too_long";
  const groups = [
    /\p{L}/u.test(password),
    /\p{N}/u.test(password),
    /[^\p{L}\p{N}\s]/u.test(password),
    /\p{Ll}/u.test(password) && /\p{Lu}/u.test(password),
  ].filter(Boolean).length;
  if (groups < 3) return "insufficient_variety";
  return null;
}
