# CupFlow

Responsive React + TypeScript + Vite frontend for a one-day futsal tournament.

## Run locally

```bash
npm install
cp .dev.vars.example .dev.vars   # local passwords: superadmin1234 / subadmin1234
npm run dev
```

`npm run dev` starts Vite together with the Cloudflare Worker and its Durable Object in the local
workerd runtime. Tournament data is kept in `.wrangler/state/` (not committed).

## Checks

```bash
npm run lint
npm run format:check
npm run typecheck
npm run test
npm run build
```

## Deploy to Vercel

Connect this repository to Vercel and add a Neon Postgres database (set `DATABASE_URL`). Then set
these Production environment variables in Vercel:

- `SUPERADMIN_PASSWORD`: password for `superadmin`
- `SUBADMIN_PASSWORD`: shared by `subadmin1`–`subadmin6`
- `SESSION_SECRET`: a long random secret (at least 32 random bytes)

The API uses Neon’s official serverless driver over HTTPS for database queries.

Deploy with `npm run deploy` (Vercel CLI) or by pushing to the connected Git repository. API data
and login lockouts are stored in Neon Postgres. Tournament updates are polled every two seconds;
Vercel Functions do not provide the Durable Object WebSocket used by the Cloudflare deployment.

Staff sign in at `/superadmin` (all courts) and `/subadmin` (`subadmin1`–`2` → Court 1,
`3`–`4` → Court 2, `5`–`6` → Court 3). The header links to these pages only in development.
Changing `SESSION_SECRET` signs everyone out.

- Sessions last 12 hours: sign in on the morning of the event, not the night before.
- The session cookie is `Secure`, so testing from a phone against the dev server over
  `http://<LAN IP>` will not keep you signed in; use `localhost` or an https tunnel.

The Vercel deployment serves the Vite SPA and `/api/*` as serverless functions. The legacy
Cloudflare Worker configuration remains available for Cloudflare deployments.
