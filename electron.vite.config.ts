import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

/**
 * The renderer never talks to the network, so the production build gets a
 * strict CSP. Dev is left alone because Vite needs its HMR websocket.
 */
function cspPlugin(): Plugin {
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: {
            'http-equiv': 'Content-Security-Policy',
            content:
              "default-src 'self' file:; script-src 'self' file:; style-src 'self' file: 'unsafe-inline'; img-src 'self' data: file:; font-src 'self' file:; connect-src 'none'"
          },
          injectTo: 'head-prepend'
        }
      ]
    }
  }
}

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: { plugins: [react(), cspPlugin()] }
})
