# Kanb frontend

React 19 + Vite + TypeScript single-page app. See the [main README](../README.md#development) for how to run it with the backend.

```bash
npm install
npm run dev      # http://localhost:5173, proxies /api and WebSockets to the backend on :8080
npm run build    # production build in dist/, served by the backend (STATIC_DIR)
npx tsc -b       # type check
```
