import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { forbidNodeOnlyModules } from './build/forbid-node-only-modules.js';

export default defineConfig({
  plugins: [react(), forbidNodeOnlyModules()],
  server: {
    port: 5173,
  },
  build: {
    // The deployable artifact lives at the repository root, not inside the
    // package. This is the only app in the workspace, and putting it here makes
    // the host's default output directory ("dist" beside vercel.json) already
    // correct, so the build does not depend on an outputDirectory override
    // being honoured. Resolved relative to this package.
    outDir: '../../dist',
    // Required because outDir sits outside the package root; without it Vite
    // refuses to clear the directory and stale assets from an earlier build
    // would be served alongside the new ones.
    emptyOutDir: true,
  },
});
