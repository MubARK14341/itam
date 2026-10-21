import type { Metadata } from "next";
import { cookies } from "next/headers";
import "./globals.css";
import { AppPreferencesProvider } from "@/components/providers/app-preferences-provider";
import { DemoEnvironmentBadge } from "@/components/demo-environment-badge";
import { RouteDocumentTitle } from "@/components/route-document-title";
import {
  LANG_COOKIE, THEME_COOKIE, getDict, getDir, normalizeLang, normalizeTheme,
} from "@/lib/i18n";
import { shouldBlockIndexing } from "@/lib/deployment-indexing";
import { shouldShowManagerDemo } from "@/lib/manager-demo";

// An explicit local icon avoids the browser's implicit, missing /favicon.ico request.
const STUDIO_ICON = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#2563eb"/><path d="M22 10H13a4 4 0 0 0 0 8h6a2 2 0 0 1 0 4H10" fill="none" stroke="white" stroke-width="3" stroke-linecap="round"/></svg>',
);

// الوصف يتبع لغة الكوكي؛ RouteDocumentTitle يملك عنوان الصفحة وحده.
export async function generateMetadata(): Promise<Metadata> {
  const cookieStore = await cookies();
  const lang = normalizeLang(cookieStore.get(LANG_COOKIE)?.value);
  const t = getDict(lang);
  return {
    description: t.app.description,
    icons: { icon: { url: STUDIO_ICON, type: "image/svg+xml" } },
    ...(shouldBlockIndexing(process.env)
      ? {
          robots: {
            index: false,
            follow: false,
            noarchive: true,
            nosnippet: true,
          },
        }
      : {}),
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // قراءة التفضيلات من الكوكي على الخادم → إصدار html بـ lang/dir/dark صحيحة من أول render
  // (صفر وميض، صفر hydration mismatch). suppressHydrationWarning حماية إضافية.
  const store = await cookies();
  const lang = normalizeLang(store.get(LANG_COOKIE)?.value);
  const theme = normalizeTheme(store.get(THEME_COOKIE)?.value);

  return (
    <html lang={lang} dir={getDir(lang)} className={theme === "dark" ? "dark" : undefined} suppressHydrationWarning>
      <body>
        <AppPreferencesProvider initialLang={lang} initialTheme={theme}>
          <RouteDocumentTitle />
          {shouldShowManagerDemo(process.env) ? <DemoEnvironmentBadge /> : null}
          {children}
        </AppPreferencesProvider>
      </body>
    </html>
  );
}
