"use client";

import { useEffect, useState } from "react";
import { Field, Select } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { listEmployeeApprovalOptions, type EmployeeApprovalOption } from "@/lib/queries";

/** Selection is always explicit; approval revalidates active status/link ownership. */
export function EmployeeApprovalSelect({ value, onChange, disabled }: {
  value: string; onChange: (value: string) => void; disabled?: boolean;
}) {
  const { t, lang } = useAppPreferences();
  const [rows, setRows] = useState<EmployeeApprovalOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    setLoading(true); setFailed(false);
    void listEmployeeApprovalOptions().then(({ rows, error }) => {
      if (!current) return;
      setRows(rows); setFailed(!!error); setLoading(false);
    }, () => { if (current) { setFailed(true); setLoading(false); } });
    return () => { current = false; };
  }, [revision]);
  return <div><Field label={t.usersAdmin.employeeRecord} hint={t.usersAdmin.employeeRecordHint} required>
    <Select label={t.usersAdmin.employeeRecord} value={value} onChange={onChange} disabled={disabled || loading || failed}
      placeholder={loading ? t.common.loading : t.usersAdmin.employeePlaceholder}
      options={rows.map((employee) => ({ value: employee.id,
        label: `${lang === "ar" ? employee.full_name_ar || employee.full_name : employee.full_name}${employee.employee_no ? ` · ${employee.employee_no}` : ""}` }))} />
  </Field>
    {failed ? <div role="alert" className="mt-2 text-sm text-bad">
      {t.usersAdmin.loadError}<Button size="sm" variant="ghost" disabled={disabled}
        onClick={() => { onChange(""); setRevision((n) => n + 1); }}>{t.usersAdmin.refresh}</Button>
    </div> : !loading && rows.length === 0 ? <p className="mt-2 text-sm text-muted">{t.usersAdmin.noActiveEmployees}</p> : null}
  </div>;
}
