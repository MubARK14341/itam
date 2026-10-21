"use client";

import { Check, Minus } from "lucide-react";
import { MIN_PASSWORD_LENGTH, passwordPolicyError } from "@/lib/password-policy";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";

type Level = 0 | 1 | 2 | 3;

/**
 * Live strength meter for registration forms. Driven only by the shared
 * `passwordPolicyError` helper — it adds no rule of its own. Variety is read by
 * asking the same helper about the password repeated to the minimum length
 * (repetition keeps the same character groups), so hints update while typing.
 */
function evaluate(password: string) {
  const error = passwordPolicyError(password);
  if (error === "required") return { level: 0 as Level, lengthOk: false, varietyOk: false, tooLong: false };
  if (error === "too_long") return { level: 1 as Level, lengthOk: true, varietyOk: true, tooLong: true };
  const lengthOk = error !== "too_short";
  const varietyOk = error === null
    || (error === "too_short" && passwordPolicyError(password.padEnd(MIN_PASSWORD_LENGTH, password)) !== "insufficient_variety");
  const level: Level = error === null ? 3 : lengthOk || varietyOk ? 2 : 1;
  return { level, lengthOk, varietyOk, tooLong: false };
}

export function PasswordStrength({ id, password }: { id: string; password: string }) {
  const { t } = useAppPreferences();
  const tr = t.registration;
  const { level, lengthOk, varietyOk, tooLong } = evaluate(password);
  const tone = level === 3 ? "bg-ok" : level === 2 ? "bg-warn" : "bg-bad";
  const text = level === 3 ? "text-ok" : level === 2 ? "text-warn" : level === 1 ? "text-bad" : "text-muted";
  const label = level === 0 ? t.common.dash
    : tooLong ? tr.strengthTooLong
    : level === 3 ? tr.strengthGood
    : level === 2 ? tr.strengthFair
    : tr.strengthWeak;
  const rules = [
    { ok: lengthOk, text: tr.ruleLength.replace("{n}", String(MIN_PASSWORD_LENGTH)) },
    { ok: varietyOk, text: tr.ruleVariety },
  ];

  return (
    <div id={id} className="space-y-1.5">
      <div className="flex items-center gap-3">
        <span className="whitespace-nowrap text-xs text-muted">{tr.strengthLabel}</span>
        <span aria-hidden="true" className="grid flex-1 grid-cols-3 gap-1">
          {[1, 2, 3].map((bar) => (
            <span key={bar} className={`h-[5px] rounded-full transition-colors ${level >= bar ? tone : "bg-line-strong"}`} />
          ))}
        </span>
        <span aria-live="polite" className={`min-w-14 text-end text-xs font-semibold ${text}`}>{label}</span>
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {rules.map((rule) => (
          <li key={rule.text} className={`inline-flex items-center gap-1.5 ${rule.ok ? "text-ok" : "text-muted"}`}>
            {rule.ok ? <Check aria-hidden="true" className="h-3.5 w-3.5" /> : <Minus aria-hidden="true" className="h-3.5 w-3.5" />}
            {rule.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
