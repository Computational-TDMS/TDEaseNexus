# TDEase FrontEnd

The frontend handles workflow editing, result visualization, and lightweight interactive computation. Heavy data processing remains on the backend or local compute nodes; the frontend does not run core batch computation.

## 1. Project Positioning

- Workflow definitions and execution state are persisted by the backend; the frontend renders and interacts with them.
- Result files such as TSV are visualized in the frontend (tables, spectra, linked analysis).
- Lightweight capabilities such as amino acid sequence editing and partial recomputation run in the frontend.
- Supports a "visualization-only workflow" mode for browsing data without triggering backend recomputation.
- Supports two packaging modes:
  - Pure web
  - Electron desktop shell

## 2. Development and Run Modes

### Pure web development

- Default Vite port is `1420`
- `1420` is the only allowed dev server port; if it is occupied, Vite should fail outright instead of drifting to `1421`
- In dev mode, `/api` is proxied by `vite.config.ts` to `http://127.0.0.1:8000`

Common commands:

```bash
pnpm install
pnpm run dev
pnpm run build
pnpm run preview
```

### Electron desktop development

Electron only replaces the desktop window shell layer; it does not change the main Vue frontend logic.

Common commands:

```bash
pnpm run desktop:dev
pnpm run desktop:build
pnpm run desktop:dist
```

Notes:

- `desktop:dev` only manages the build, Vite, and Electron; Electron's `BackendManager` handles the local API and dedicated workers
- `desktop:build` / `desktop:dist` rely on an existing `dist/` artifact
- Setting `TDEASE_BACKEND_URL` switches to server-connection mode and does not start the local backend

## 3. Frontend-Backend Connection Configuration

Currently `src/services/api/client.ts` uses these rules:

- When `VITE_API_BASE_URL` is unset, use relative paths
- If `VITE_API_BASE_URL` mistakenly points at HMR port `1421`, it is automatically reset to empty to avoid requests hitting the frontend HMR service

Recommended environment variables:

```env
VITE_API_BASE_URL=
VITE_WS_URL=ws://localhost:8000
VITE_TUS_UPLOAD_ENDPOINT=
```

Notes:

- In development, keep `VITE_API_BASE_URL` empty and let the proxy handle it
- In production it can be set to a reverse proxy address such as `https://api.example.com`
- File upload uses Uppy by default; setting `VITE_TUS_UPLOAD_ENDPOINT` switches to Tus

## 4. Authentication and Multi-User Access

Aligned with current backend conventions:

- `TDEASE_AUTH_MODE=off`: default on the main branch, no API key validation
- `TDEASE_AUTH_MODE=api_key`: API key required, with user-scope validation
- `TDEASE_DEPLOYMENT_MODE=personal`: default on the main branch, local single-user oriented
- `TDEASE_DEPLOYMENT_MODE=lab`: shared lab deployment, requires API key

In multi-user scenarios, frontend calls must follow:

- The `user_id` in `/api/users/{user_id}/...` paths must match the authenticated identity (for non-admins)
- Execution endpoints in authenticated mode require `user_id + workspace_id + sample_ids`
- The `workspace` context is read uniformly from `useWorkspaceStore()` to avoid pages passing inconsistent users

## 5. Batch Execution Requests

Batch execution endpoint:

- `POST /api/workflows/{workflow_id}/execute-batch`

Requests must at minimum include:

- `user_id`
- `workspace_id`
- `sample_ids`

Otherwise they will be rejected in `api_key` mode.

## 6. Troubleshooting

The backend generates or forwards an `X-Request-ID` for every request and writes it to the access log.

Recommendations:

1. Attach `X-Request-ID` to requests
2. If a `500` response contains a `correlation_id`, surface that ID in the UI error message
3. Support staff use `X-Request-ID` or `correlation_id` to look up backend logs

Common errors:

- `401 Missing/Invalid API key`
- `403 Access denied for user_id`
- `400 Authenticated mode requires user_id, workspace_id and sample_ids`

## 7. Security Recommendations

- Do not hardcode API keys in source code or commit them to the repository
- In browser scenarios, prefer injecting auth headers via a reverse proxy
- If the desktop app needs to store credentials, integrate the OS credential vault later
- Avoid printing raw keys, full absolute file paths, and sensitive parameters in frontend logs
