import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// This app deliberately reuses `../src/api/client.ts` and `../src/domain/*`
// by relative import rather than duplicating already-tested logic (autosave,
// lock, taxonomy, seo, paste sanitization) — see the plan this app was built
// from. Vite's dev server restricts serving files outside the project root
// by default; `fs.allow` widens that to the monorepo root those imports need.
export default defineConfig({
  plugins: [react()],
  root: here,
  server: {
    fs: {
      allow: [path.resolve(here, '..')],
    },
  },
  build: {
    outDir: 'dist',
  },
});
