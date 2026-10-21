import { cookies, headers } from "next/headers";
import { LANG_COOKIE, getDict, normalizeLang } from "@/lib/i18n";
import { checkSchemaCompatibility } from "@/lib/schema-compatibility";
import { createClient } from "@/lib/supabase/server";
import { decodeInitialContext, INITIAL_CONTEXT_HEADER, schemaCompatibilityFromInitialContext } from "@/lib/initial-context-header";

export async function SchemaCompatibilityGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const context = decodeInitialContext((await headers()).get(INITIAL_CONTEXT_HEADER));
  const handedOff = schemaCompatibilityFromInitialContext(context);
  const result = handedOff ?? await checkSchemaCompatibility(await createClient());
  if (result.ok) return children;

  const store = await cookies();
  const lang = normalizeLang(store.get(LANG_COOKIE)?.value);
  const t = getDict(lang).schemaCompatibility;

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <section
        className="w-full max-w-xl rounded-card border border-line bg-surface p-6"
        data-schema-compatible="false"
        data-schema-reason={result.reason}
        role="alert"
      >
        <p className="ui-chip tone-warn">
          {t.eyebrow}
        </p>
        <h1 className="mt-3 font-display text-2xl font-semibold text-fg">
          {t.title}
        </h1>
        <p className="mt-3 leading-7 text-fg-2">
          {t.description}
        </p>
        <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="font-medium text-muted">{t.expected}</dt>
          <dd className="font-mono tabular-nums text-fg">
            {result.expectedVersion}
          </dd>
          <dt className="font-medium text-muted">{t.detected}</dt>
          <dd className="font-mono tabular-nums text-fg">
            {result.actualVersion ?? t.unavailable}
          </dd>
        </dl>
        <p className="mt-5 text-sm text-fg-2">
          {t.action}
        </p>
      </section>
    </main>
  );
}
