# ViralForge

Content automation platform for Hindi/Hinglish Instagram and Facebook content.

## Local development

ViralForge uses the official local Supabase stack for PostgreSQL, REST, Auth, and Storage. Redis remains the BullMQ transport. The project Compose file does not run a second PostgreSQL or MinIO instance.

### Prerequisites

- Node.js 22+
- npm 10+
- Docker Desktop with the daemon running

### Start the stack

```bash
npm install
```

```bash
npm run supabase:start
```

Copy `.env.example` to `.env`, then copy the local anon and service-role keys reported by:

```bash
npm run supabase:status
```

Apply all migrations and recreate local data:

```bash
npm run supabase:reset
```

Start Redis:

```bash
docker compose up -d redis
```

Start API, workers, and dashboard:

```bash
npm run dev
```

- Dashboard: http://localhost:3001
- API: http://localhost:3000
- Supabase API: http://127.0.0.1:54321
- Supabase Studio: http://127.0.0.1:54323
- Omniroute: http://localhost:20128

## Safe publishing

`PUBLISHING_DISABLED=true` is the required local default. Signed URLs from the local Supabase stack are not reachable by Meta's servers, so real Meta publishing must use externally reachable storage in a production environment.

## Checks

```bash
npm test -- --runInBand
```

```bash
npm run build
```

```bash
npm run supabase:test
```

## Stop the stack

```bash
npm run infra:down
```
