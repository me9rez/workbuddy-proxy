# workbuddy-proxy

**English** · [简体中文](./README.md)

An OpenAI-compatible HTTP proxy for **Tencent WorkBuddy (CodeBuddy)** models.

Sign in once through the browser, then point any OpenAI-compatible client at
`http://127.0.0.1:8788/v1` — Hermes, dsh, the OpenAI SDK, IDE plugins, shell scripts.

- 🔐 **Browser login** — no API key required; tokens are refreshed automatically
- 👥 **Multiple accounts** — sign in as many times as you like; pick one per request
- 📋 **Live model catalog** — the credential's real model list with context windows
- 🔁 **Streaming *and* non-streaming** — upstream only streams, the proxy folds it back
- 💓 **Keep-alive + truncation detection** — idle streams get SSE comment heartbeats, and a
  dropped upstream connection injects an error event instead of letting the client treat a
  truncated answer as complete
- 🧩 **Zero dependencies** — Node ≥ 22, standard library only
- 🛡️ **Loopback by default** — optional local bearer token for extra safety

> **Unofficial.** This is a third-party adapter. It is not affiliated with, endorsed by, or
> supported by Tencent, WorkBuddy, or CodeBuddy. The upstream API is not a public, stable
> developer API — paths and headers may change with CodeBuddy releases.

## Requirements

- Node.js **≥ 22** (uses the built-in `fetch`)
- A WorkBuddy / CodeBuddy account (China region)

## Install

```bash
# straight from GitHub — no clone, no build step (the package has zero dependencies)
pnpm add -g github:me9rez/workbuddy-proxy   # or: npm i -g github:me9rez/workbuddy-proxy

# or run it without installing anything
npx github:me9rez/workbuddy-proxy models

# or from a clone
git clone https://github.com/me9rez/workbuddy-proxy.git
cd workbuddy-proxy
node bin/workbuddy-proxy.js --help
```

Once published to npm, `npx workbuddy-proxy` works too.

## Quick start

```bash
# 1. Sign in (opens your browser; the URL is printed as a fallback)
node bin/workbuddy-proxy.js login

# 2. See what your account can use
node bin/workbuddy-proxy.js models

# 3. Serve it
node bin/workbuddy-proxy.js serve
# → http://127.0.0.1:8788/v1
```

Then, with any OpenAI-compatible client:

```bash
curl http://127.0.0.1:8788/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"hello"}]}'
```

## CLI

| Command | Description |
|---|---|
| `workbuddy-proxy login [--label <name>]` | Browser sign-in; **adds** an account and makes it active |
| `workbuddy-proxy accounts` | List stored accounts (`*` marks the active one) |
| `workbuddy-proxy use <id\|label\|index>` | Switch the active account |
| `workbuddy-proxy whoami [--account <key>]` | Print an account summary (never the tokens) |
| `workbuddy-proxy models [--refresh] [--account <key>]` | List models with context window / max output / vision / reasoning |
| `workbuddy-proxy models --hermes` | Print a `providers:` snippet for Hermes `config.yaml` |
| `workbuddy-proxy serve [--port 8788] [--host 127.0.0.1] [--token sk-local] [--account <key>] [--fallback] [--heartbeat <seconds>]` | Run the proxy |
| `workbuddy-proxy logout [--account <key>] [--all]` | Remove one account, or all of them |

### Streaming behaviour

Because upstream only speaks streaming, the proxy adds two safety nets while forwarding:

- **Heartbeat** — every **15 s** by default it writes an SSE comment (`: keep-alive`).
  Comments are ignored by clients per the SSE spec, so the connection stays alive without
  polluting the data. Change it with `--heartbeat <seconds>`, disable with `--heartbeat 0`.
- **Truncation detection** — if the upstream connection drops, or the stream ends without a
  terminator (`[DONE]` / a `finish_reason`), the proxy emits an OpenAI-shaped error event:

  ```text
  data: {"error":{"message":"upstream stream interrupted: socket hang up","type":"upstream_error"}}
  ```

  Non-streaming requests are checked too: an incomplete SSE body fails the request instead
  of returning a truncated completion.

## Multiple accounts

```bash
workbuddy-proxy login                 # account A → stored, now active
workbuddy-proxy login --label work    # account B → added, now active
workbuddy-proxy accounts              # list them, * = active
workbuddy-proxy use work              # switch by label (id or 1-based index also work)
workbuddy-proxy logout --account 2    # drop the second account
workbuddy-proxy logout --all          # drop everything
```

Each account is identified by a **digest of its refresh token** (never the token itself),
so signing in again with the same account refreshes it in place instead of duplicating it.
Credentials live in `~/.workbuddy-proxy/session.json` with mode `0600`; a legacy
single-account file is migrated automatically on first read.

**Choosing an account per request** — the `serve` process falls back to the active account,
but any request can override it:

```bash
# by header (id, label or 1-based index)
curl http://127.0.0.1:8788/v1/chat/completions \
  -H 'X-WorkBuddy-Account: work' ...

# or by query string
curl 'http://127.0.0.1:8788/v1/models?account=2'
```

Add `--fallback` to `serve` and a failing account falls through to the remaining ones in
order — useful when one account's quota runs dry.

> Note: HTTP header values are latin-1 by spec, so a non-ASCII label is transmitted as
> mojibake. The proxy re-decodes those bytes as UTF-8, so `X-WorkBuddy-Account: 示例账号` works,
> but IDs and ASCII labels are always the safest choice.

### Environment

| Variable | Meaning |
|---|---|
| `WORKBUDDY_PROXY_HOME` | Where credentials and caches live (default `~/.workbuddy-proxy`) |
| `DEBUG` | Print stack traces on fatal errors |

## HTTP API

| Route | Description |
|---|---|
| `GET /health` | `{ ok, activeId, account, accounts }` |
| `GET /v1/accounts` | Stored accounts (id, label, active flag, expiry — never tokens) |
| `GET /v1/models` | OpenAI model list, plus `context_length`, `max_output_tokens` and a `capabilities` object |
| `GET /v1/models?refresh=1` | Bypass the 10-minute catalog cache |
| `POST /v1/chat/completions` | Chat completion (SSE passthrough with `"stream": true`, otherwise aggregated locally) |

Account selection: `X-WorkBuddy-Account: <id|label|index>` header, or `?account=<key>`;
without either, the store's active account is used.

When `--token` is set, every request must carry `Authorization: Bearer <token>`.

## Use with Hermes

```bash
node bin/workbuddy-proxy.js models --hermes   # prints the snippet
```

```yaml
providers:
  workbuddy-proxy:
    name: WorkBuddy (proxy)
    base_url: http://127.0.0.1:8788/v1
    model: deepseek-v4.1-flash
    discover_models: false
    models:
      hy3:
        context_length: 192000
        supports_vision: true
      # …
```

```bash
hermes --provider workbuddy-proxy -m glm-5.3 -z "hello"
```

## Use with the OpenAI SDK

```js
import OpenAI from 'openai';

const client = new OpenAI({ baseURL: 'http://127.0.0.1:8788/v1', apiKey: 'not-needed' });

const stream = await client.chat.completions.create({
  model: 'deepseek-v4.1-flash',
  messages: [{ role: 'user', content: 'hello' }],
  stream: true,
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
```

## How it works

All traffic goes to `copilot.tencent.com`:

| Step | Request |
|---|---|
| Login state | `POST /v2/plugin/auth/state?platform=CLI` → `{ state, authUrl }` |
| Login (browser) | `GET /v2/plugin/auth/token?state=…` (polled) → access + refresh tokens |
| Account | `GET /v2/plugin/login/account?state=…` |
| Refresh | `POST /v2/plugin/auth/token/refresh` with `X-Refresh-Token` |
| Catalog | `GET /v3/config` — `Authorization: Bearer` (token) or `X-API-Key` (key) |
| Inference | `POST /v2/chat/completions` — **SSE only** |

Two upstream quirks shaped the design:

1. **Non-streaming chat requests are rejected** (`{"code":11101,"msg":"Non-stream chat request
   is currently not supported"}`). The proxy always requests a stream and, when the client
   asked for a non-stream response, reassembles the SSE locally (text, reasoning and
   fragment-wise tool calls).
2. **Model lists are scoped to the credential.** `agents[name="cli"].models` differs per
   account/key, and a model id that another client shows may be rejected server-side. Never
   hardcode the list — read it from `/v3/config`.

## Security & privacy

- Credentials live in `~/.workbuddy-proxy/session.json` with mode `0600` and are **never**
  written to logs; `whoami` prints a summary without tokens.
- The server binds to **loopback** by default. If you bind beyond it, pass `--token` — the
  proxy will then require `Authorization: Bearer <token>`.
- This proxy speaks for *your* account: anything that can reach it can spend your quota.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Browser shows **“登录失败 / 登录链接不完整”** | The auth URL was truncated — usually by a shell that treats `&` specially (`cmd /c start`, older shortcuts). Copy the full URL printed by the CLI and paste it into the browser. The bundled opener uses `rundll32` on Windows for exactly this reason. |
| `code 11101` from the proxy | Upstream rejected a non-stream request. Update the proxy — it always streams upstream and folds the response locally. |
| `尚未登录，请先运行…` | Run `workbuddy-proxy login`. |
| `模型目录 HTTP 401/403` | The credential is invalid or expired; re-run `login`. |
| Hermes picker does not list the provider | The GUI picker only reads `models.dev` + built-in overlays + the `providers:` dict in `config.yaml`. Declare the provider there (see above). |

## Development

```bash
node --test          # 22 unit tests
npm run check        # syntax + tests
```

Layout:

```
bin/workbuddy-proxy.js   executable shim
src/constants.js         endpoints, headers, paths
src/api.js               plugin HTTP client + errors
src/auth.js              browser login flow
src/session.js           credential storage + token refresh
src/catalog.js           /v3/config parsing + cache
src/sse.js               SSE parsing + local aggregation
src/server.js            OpenAI-compatible HTTP surface
src/cli.js               command line
src/index.js             programmatic exports
test/                    node:test suites
```

## Credits

The upstream endpoints and request shapes were mapped with reference to
[`@axiaohungry/dsh-llm-workbuddy`](https://github.com/Axiaohungry/dsh-llm-workbuddy) (MIT) and
its WorkBuddy API notes. This project is an independent implementation.

## License

[MIT](./LICENSE)
