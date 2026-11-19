import { defineConfig } from 'vite'

export default defineConfig({
  // Relative base so the build works on GitHub Pages (/FDSS/) or any custom domain.
  base: './',
  // some old browserify-era deps (right-now via 3d-view-controls) read `global`
  // (build uses `define`, the dev pre-bundler needs it via esbuildOptions)
  define: { global: 'globalThis' },
  optimizeDeps: {
    esbuildOptions: { define: { global: 'globalThis' } }
  }
})
