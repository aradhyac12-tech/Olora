# Environment variables

| Var | Where | Meaning |
|---|---|---|
| `DATABASE_URL`, `DATABASE_SSL`, `API_HOST`, `API_PORT`, `LOG_LEVEL`, `CORS_ORIGINS`, `TRUST_PROXY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` | API runtime | unchanged (see `.env.example`). `TRUST_PROXY=true` is required behind Render or every client shares one IP rate-limit bucket |
| `API_BASE_URL` | web build | https origin of the API |
| **`PUBLIC_APP_URL`** (new) | web build | https URL where this web app is hosted (e.g. `https://olora.example.com/`). Invitation links are built from it. Empty in native builds: links then show as copyable codes that can be pasted into *Invitations → Got a link?* |
| `E2E_PORT`, `E2E_SHOTS` | `npm run test:e2e` | port and screenshot folder |

CORS now allows `GET,POST,PUT,PATCH,DELETE,OPTIONS`.
