"use client";

import { useState } from "react";
import { Info, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/form";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import {
  BarRows, ReportCard, ReportEmpty, ReportKpiBand, TabToolbar, type AssetGroup,
} from "@/components/reports/report-ui";

const initialsOf = (name: string) => name.trim().split(/\s+/).slice(0, 2).map((p) => p[0] ?? "").join("");

export function CustodyTab({ custodyCount, byEmployee }: { custodyCount: number; byEmployee: AssetGroup[] }) {
  const { t } = useAppPreferences();
  const rep = t.reports;
  const L = rep.ledger;
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const rows = needle ? byEmployee.filter((g) => g.label.toLowerCase().includes(needle)) : byEmployee;

  return (
    <div className="space-y-[18px]">
      <TabToolbar note={<span className="inline-flex items-center gap-1.5"><Info aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />{L.scope.custody}</span>} />

      <ReportKpiBand
        label={L.kpiLabel}
        items={[
          { key: "assigned", label: rep.custodyTab.assignedAssets, value: custodyCount, tone: "res" },
          { key: "employees", label: rep.custodyTab.employeesWithCustody, value: byEmployee.length },
        ]}
      />

      {byEmployee.length === 0 ? (
        <section aria-label={rep.custodyTab.mostCustody} className="ui-surface">
          <ReportEmpty icon={UserCheck} title={rep.custodyTab.noAssigned} />
        </section>
      ) : (
        <div className="grid grid-cols-1 items-start gap-[18px] lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
          <ReportCard id="rep-cus-top" title={rep.custodyTab.mostCustody}>
            <BarRows
              rows={byEmployee.slice(0, 8).map((g) => ({ key: g.label, label: g.label, n: g.items.length }))}
              tone="res"
              ariaLabel={rep.custodyTab.mostCustody}
              emptyText={rep.custodyTab.noAssigned}
              labelWidth="9rem"
            />
          </ReportCard>

          <ReportCard
            id="rep-cus-table"
            title={L.custodyPerEmployee}
            description={<><span className="tabular-nums">{rows.length}</span> {L.employeesUnit}</>}
            flush
            actions={
              <SearchInput
                label={L.custodySearchLabel}
                placeholder={L.custodySearch}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onClear={() => setQ("")}
                clearLabel={L.clearSearch}
                containerClassName="w-full sm:w-60 print:hidden"
              />
            }
          >
            {rows.length === 0 ? (
              <ReportEmpty
                title={L.custodyNoMatch}
                description={L.custodyNoMatchHint}
                action={<Button variant="outline" size="sm" onClick={() => setQ("")}>{L.clearSearch}</Button>}
              />
            ) : (
              <div tabIndex={0} className="overflow-x-auto">
                <table className="ui-table">
                  <caption className="sr-only">{L.custodyPerEmployee}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{rep.custodyTab.employee}</th>
                      <th scope="col">{rep.custodyTab.custodyCount}</th>
                      <th scope="col">{L.assetsCol}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((g) => {
                      const tags = g.items.map((a) => a.asset_tag).filter(Boolean) as string[];
                      return (
                        <tr key={g.label}>
                          <td>
                            <span className="flex items-center gap-2.5">
                              <span aria-hidden="true" className="ui-avatar">{initialsOf(g.label)}</span>
                              <span className="font-semibold text-fg">{g.label}</span>
                            </span>
                          </td>
                          <td className="font-semibold tabular-nums">{g.items.length}</td>
                          <td>
                            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                              {tags.slice(0, 3).map((tag) => <span key={tag} className="tag text-[12.5px] text-fg-2">{tag}</span>)}
                              {tags.length > 3 && <span className="text-xs tabular-nums text-muted" dir="ltr">+{tags.length - 3}</span>}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </ReportCard>
        </div>
      )}
    </div>
  );
}
