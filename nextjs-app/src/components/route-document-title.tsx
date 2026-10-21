"use client";

import { usePathname } from "next/navigation";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { routeDocumentTitle } from "@/lib/route-title";

export function RouteDocumentTitle() {
  const pathname = usePathname();
  const { t } = useAppPreferences();
  const title = routeDocumentTitle(pathname, t);

  // One React owner renders the title on the server and updates it when the
  // route or language changes. Root metadata deliberately omits a second title.
  return <title>{title}</title>;
}
