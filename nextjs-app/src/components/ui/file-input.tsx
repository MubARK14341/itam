"use client";

import { Upload } from "lucide-react";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";

// حقل رفع ملف بواجهة عربية — يُخفي نصّ المتصفح الأصلي (Choose file / No file chosen)
// ويعرض «اختر ملف» + اسم الملف المُختار أو «لم يتم اختيار ملف». لا يغيّر منطق الرفع.
export function FileInput({
  accept, file, onPick, disabled, id, required, ...accessibilityProps
}: {
  accept?: string;
  file: File | null;
  onPick: (f: File | null) => void;
  disabled?: boolean;
  id?: string;
  required?: boolean;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}) {
  const { t } = useAppPreferences();
  return (
    <label
      className={`flex min-h-[38px] w-full items-center gap-2 rounded-control border border-dashed border-line-strong bg-surface px-2 py-1.5 text-[13.5px] max-md:min-h-11 ${
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:border-brand"
      }`}
    >
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-sunk px-2.5 py-1 text-xs font-medium text-fg-2">
        <Upload className="h-3.5 w-3.5" />{t.common.chooseFile}
      </span>
      <span className={`min-w-0 flex-1 truncate ${file ? "text-fg" : "text-muted"}`}>
        {file ? file.name : t.common.noFileChosen}
      </span>
      <input
        id={id} type="file" accept={accept} className="hidden" disabled={disabled} required={required}
        {...accessibilityProps}
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
      />
    </label>
  );
}
