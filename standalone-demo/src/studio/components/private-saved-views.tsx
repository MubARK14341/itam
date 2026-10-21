"use client";

import { useEffect, useState } from "react";
import { Bookmark, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/form";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { PRIVATE_VIEW_LIMIT, privateViewStorageKey, readPrivateViews, encodePrivateViews, type FilterValues, type PrivateView } from "@/lib/view-filters";

export function PrivateSavedViews({ actorId, surface, identityKey, filters, normalize, onApply }: {
  actorId: string | null; surface: "reports" | "portal-requests"; identityKey: string;
  filters: FilterValues; normalize: (values: FilterValues) => FilterValues; onApply: (values: FilterValues) => void;
}) {
  const { t } = useAppPreferences();
  const labels = t.privateViews;
  const scope = privateViewStorageKey(actorId, surface);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [views, setViews] = useState<PrivateView[]>([]);
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [storageAvailable, setStorageAvailable] = useState(true);
  const currentScope = scope ? `${scope}|${identityKey}` : null;
  useEffect(() => {
    setSelected(""); setName(""); setMessage(""); setViews([]); setStorageAvailable(true);
    if (!scope) { setLoadedScope(null); return; }
    try { setViews(readPrivateViews(window.localStorage.getItem(scope), normalize)); }
    catch { setStorageAvailable(false); }
    setLoadedScope(currentScope);
  }, [scope, currentScope, normalize]);
  if (!scope || loadedScope !== currentScope) return null;
  function store(next: PrivateView[]) {
    try { window.localStorage.setItem(scope!, encodePrivateViews(next, normalize)); setViews(next); return true; }
    catch { setMessage(labels.unavailable); return false; }
  }
  function save() {
    const label = name.trim();
    if (!label) return;
    const existing = views.find((view) => view.name === label);
    if (!existing && views.length >= PRIVATE_VIEW_LIMIT) { setMessage(labels.limit); return; }
    const view = { id: existing?.id ?? crypto.randomUUID(), name: label, filters: normalize(filters) };
    const next = existing ? views.map((row) => row.id === existing.id ? view : row) : [...views, view];
    if (store(next)) { setSelected(view.id); setName(""); setMessage(labels.saved); }
  }
  function apply() {
    const view = views.find((row) => row.id === selected);
    if (view) { onApply(normalize(view.filters)); setMessage(labels.applied); }
  }
  function remove() {
    if (selected && store(views.filter((view) => view.id !== selected))) { setSelected(""); setMessage(labels.deleted); }
  }
  return (
    <section aria-label={labels.title} className="ui-surface flex flex-col gap-3 p-4 print:hidden sm:p-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="inline-flex items-center gap-2 text-sm font-semibold text-fg"><Bookmark aria-hidden="true" className="h-4 w-4" />{labels.title}</h2>
        <p className="text-xs text-muted">{labels.hint}</p>
      </div>
      {storageAvailable ? <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-40 flex-1 flex-col gap-1.5 text-xs text-fg-2">{labels.select}
          <select className={inputClass} value={selected} onChange={(event) => { setSelected(event.target.value); setMessage(""); }}>
            <option value="">{labels.choose}</option>
            {views.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}
          </select>
        </label>
        <Button size="sm" variant="outline" onClick={apply} disabled={!selected}>{labels.apply}</Button>
        <Button size="sm" variant="ghost" aria-label={labels.delete} onClick={remove} disabled={!selected}><Trash2 aria-hidden="true" className="h-4 w-4" />{labels.delete}</Button>
        <label className="flex min-w-40 flex-1 flex-col gap-1.5 text-xs text-fg-2">{labels.name}
          <input className={inputClass} value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />
        </label>
        <Button size="sm" onClick={save} disabled={!name.trim()}>{labels.save}</Button>
      </div> : <p role="status" className="text-xs text-muted">{labels.unavailable}</p>}
      {message && <p role="status" className="text-xs text-fg-2">{message}</p>}
    </section>
  );
}
