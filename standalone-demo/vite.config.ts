import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';
const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^next\/navigation$/, replacement: path('./src/demo/adapters/navigation.tsx') },
      { find: /^next\/link$/, replacement: path('./src/demo/adapters/link.tsx') },
      { find: /^next\/image$/, replacement: path('./src/demo/adapters/image.tsx') },
      { find: /^next\/script$/, replacement: path('./src/demo/adapters/script.tsx') },
      { find: /^@\/lib\/supabase\/client$/, replacement: path('./src/demo/client.ts') },
      { find: /^@\/lib\/supabase\/read-prefetch$/, replacement: path('./src/demo/read-prefetch.ts') },
      { find: /^@\/components\/auth\/captcha-field$/, replacement: path('./src/demo/adapters/captcha.tsx') },
      { find: /^@\/lib\/safe-url$/, replacement: path('./src/demo/adapters/safe-url.ts') },
      { find: '@', replacement: path('./src/studio') },
    ],
    dedupe: ['react', 'react-dom'],
  },
  define: { 'process.env': '{}' },
  oxc: { jsx: { runtime: 'automatic' } },
  plugins: [{
    name: 'independent-demo-boundary',
    resolveId(id) {
      if (['next/headers', 'next/server', 'server-only', '@/lib/supabase/server'].includes(id)) {
        throw new Error(`Server-only application dependency is forbidden in the demo: ${id}`);
      }
    },
  }],
  server: { host: '127.0.0.1', port: 4173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  build: { outDir: '.demo-client', sourcemap: false, target: 'es2022', assetsInlineLimit: 0 },
});
