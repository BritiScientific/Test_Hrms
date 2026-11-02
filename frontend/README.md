# HRMS tenant portal (frontend)

React 19 + TypeScript + Tailwind CSS 4 + React Router + TanStack Query.

```bash
npm install
npm run dev        # http://localhost:5173, proxies /api -> http://localhost:4000 (HRMS_API_URL to change)
npm run build      # typecheck + production bundle in dist/
npm test           # Vitest + React Testing Library
npm run test:e2e   # Playwright flows + responsive matrix (needs API + dev server + fresh `npm run db:reset`)
```

Structure: `src/app` (router, providers, guards) · `src/layouts` (auth, portal, settings shells) ·
`src/components` (ui, navigation, feedback) · `src/modules/*` (screens per feature) ·
`src/services` (typed API clients) · `src/types`, `src/utils`, `src/hooks`.

Serve the built app from the same origin as the API (reverse-proxy `/api` to the backend): the
session is an HttpOnly SameSite=Strict cookie and no CORS is configured.
