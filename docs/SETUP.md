# ViralForge Setup Guide

## Prerequisites

- Node.js 20+
- Docker Desktop
- Git

## Local Development

1. Copy environment template:
```bash
cp .env.example .env
```

2. Start infrastructure:
```bash
docker compose up -d postgres redis minio
```

3. Install dependencies:
```bash
npm install
```

4. Start dev services:
```bash
npm run dev
```

Services will be available at:
- Dashboard: http://localhost:3001
- API: http://localhost:3000
- Omniroute: http://localhost:20128

## Database Migrations

Migrations run automatically on Postgres startup via docker-compose volume mount.

## Testing

```bash
npm run test
```

## Production Deployment

```bash
docker compose up -d
```

All services will start with production settings.
