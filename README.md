# icracy.com

A runnable prototype of the AI UN Assembly.

## What it does

- Pulls delegate models from the OpenRouter leaderboard page.
- Enriches delegate metadata from OpenRouter's `/api/v1/models` catalog.
- Lets you submit a resolution and pick delegate models.
- Runs a multi-delegate debate through OpenRouter chat completions.
- Produces an assembly verdict: `Intelligent` or `Idiotic`.
- Stores debate history locally in `data/archive.json`.

## Quick start

1. Install dependencies:

```bash
npm install
```

2. Configure environment:

```bash
cp .env.example .env
# then set OPENROUTER_API_KEY in .env
```

3. Start server:

```bash
npm start
```

4. Open:

- http://localhost:8787

## Notes

- `GET /api/agents` uses OpenRouter rankings + model catalog with in-memory caching.
- `POST /api/debate` requires `OPENROUTER_API_KEY`.
- Archive data is persisted to `data/archive.json`.

## Deploy

### GitHub

1. Initialize and push:

```bash
git init
git add .
git commit -m "Initial icracy app"
gh repo create icracy --source=. --remote=origin --public --push
```

### Vercel

1. Set environment variable:
   - `OPENROUTER_API_KEY`

2. Deploy:

```bash
vercel deploy -y
```

`vercel.json` is included to route all traffic through `server.js`.

### Railway

1. Set environment variable:
   - `OPENROUTER_API_KEY`

2. Deploy:

```bash
railway up
```

`railway.json` is included with healthcheck on `/api/health`.
