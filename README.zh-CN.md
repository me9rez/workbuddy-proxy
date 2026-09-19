# workbuddy-proxy

[English](./README.md) · **简体中文**

把 **腾讯 WorkBuddy(CodeBuddy)** 的模型代理成本地 **OpenAI 兼容** HTTP 接口。

浏览器登录一次,然后把任何 OpenAI 兼容客户端指向 `http://127.0.0.1:8788/v1` ——
Hermes、dsh、OpenAI SDK、IDE 插件、shell 脚本都能用。

- 🔐 **浏览器登录** —— 不需要 API Key,令牌自动刷新
- 👥 **多账号** —— 登录多个账号,可按请求指定用哪个
- 📋 **实时模型目录** —— 按凭据返回真实模型列表,含上下文窗口
- 🔁 **流式 + 非流式** —— 上游只支持流式,代理在本地把它折回完整响应
- 🧩 **零依赖** —— Node ≥ 22,只用标准库
- 🛡️ **默认只监听本机** —— 需要时可用本地令牌加固

> **非官方项目。** 这是第三方适配器,与腾讯 / WorkBuddy / CodeBuddy 无隶属、背书或支持关系。
> 上游接口不是公开、稳定承诺的开发者 API,路径和 Header 可能随 CodeBuddy 版本变化。

## 环境要求

- Node.js **≥ 22**(用到内置 `fetch`)
- WorkBuddy / CodeBuddy 账号(中国区)

## 安装

```bash
# 直接从 GitHub 安装 —— 不用 clone、不用 build(本项目零依赖)
pnpm add -g github:me9rez/workbuddy-proxy   # 或 npm i -g github:me9rez/workbuddy-proxy

# 连装都不用,直接跑
npx github:me9rez/workbuddy-proxy models

# 或者从 clone 的仓库跑
git clone https://github.com/me9rez/workbuddy-proxy.git
cd workbuddy-proxy
node bin/workbuddy-proxy.js --help
```

发布到 npm 之后,`npx workbuddy-proxy` 也能用。

## 快速开始

```bash
# 1. 登录(会尝试自动打开浏览器;URL 也会打印出来，可手动粘贴)
node bin/workbuddy-proxy.js login

# 2. 看看这个账号能用哪些模型
node bin/workbuddy-proxy.js models

# 3. 起服务
node bin/workbuddy-proxy.js serve
# → http://127.0.0.1:8788/v1
```

然后:

```bash
curl http://127.0.0.1:8788/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"你好"}]}'
```

## 命令

| 命令 | 说明 |
|---|---|
| `workbuddy-proxy login [--label <名称>]` | 浏览器登录;**新增**一个账号并设为当前 |
| `workbuddy-proxy accounts` | 列出所有账号(`*` 标记当前账号) |
| `workbuddy-proxy use <id\|label\|序号>` | 切换当前账号 |
| `workbuddy-proxy whoami [--account <key>]` | 查看某个账号(**不会打印令牌**) |
| `workbuddy-proxy models [--refresh] [--account <key>]` | 列出模型(含上下文窗口 / 最大输出 / 图片 / 思考) |
| `workbuddy-proxy models --hermes` | 生成 Hermes `config.yaml` 的 `providers:` 片段 |
| `workbuddy-proxy serve [--port 8788] [--host 127.0.0.1] [--token sk-local] [--account <key>] [--fallback]` | 启动代理 |
| `workbuddy-proxy logout [--account <key>] [--all]` | 删除一个账号,或全部 |

## 多账号

```bash
workbuddy-proxy login                 # 账号 A → 已保存,成为当前账号
workbuddy-proxy login --label work    # 账号 B → 追加,成为当前账号
workbuddy-proxy accounts              # 查看列表,* 是当前账号
workbuddy-proxy use work              # 按名称切换(id、序号也可以)
workbuddy-proxy logout --account 2    # 删除第 2 个账号
workbuddy-proxy logout --all          # 全部删除
```

每个账号用**刷新令牌的摘要**作为标识(不是令牌本身),所以用同一个账号再次登录会在原地刷新,
而不会产生重复条目。凭据存放于 `~/.workbuddy-proxy/session.json`(权限 `0600`);
旧版单账号格式在第一次读取时**自动迁移**。

**按请求选择账号** —— `serve` 默认用当前账号,任何请求都可以覆盖:

```bash
# 用 header(支持 id、名称、从 1 开始的序号)
curl http://127.0.0.1:8788/v1/chat/completions \
  -H 'X-WorkBuddy-Account: work' ...

# 或者用 query
curl 'http://127.0.0.1:8788/v1/models?account=2'
```

给 `serve` 加 `--fallback`,某个账号失败时会按顺序自动尝试其余账号 —— 适合某个账号额度用尽的场景。

> 注意:HTTP header 规范是 latin-1,非 ASCII 名称会被误解码。代理会把这类字节重新按 UTF-8
> 解码,所以 `X-WorkBuddy-Account: 示例账号` 也能用;**但 id 和 ASCII 名称永远是最稳妥的选择**。

### 环境变量

| 变量 | 含义 |
|---|---|
| `WORKBUDDY_PROXY_HOME` | 凭据与缓存目录(默认 `~/.workbuddy-proxy`) |
| `DEBUG` | 出错时打印堆栈 |

## HTTP 接口

| 路由 | 说明 |
|---|---|
| `GET /health` | `{ ok, activeId, account, accounts }` |
| `GET /v1/accounts` | 已保存账号(id、名称、是否当前、过期时间 —— 不含令牌) |
| `GET /v1/models` | OpenAI 模型列表,附 `context_length`、`max_output_tokens`、`capabilities` |
| `GET /v1/models?refresh=1` | 绕过 10 分钟目录缓存 |
| `POST /v1/chat/completions` | 对话补全(`"stream": true` 直接透传 SSE,否则本地聚合) |

账号选择:`X-WorkBuddy-Account: <id|名称|序号>` header,或 `?account=<key>`;都不给则用当前账号。

设置 `--token` 后,所有请求都必须带 `Authorization: Bearer <token>`。

## 接入 Hermes

```bash
node bin/workbuddy-proxy.js models --hermes   # 打印片段
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
hermes --provider workbuddy-proxy -m glm-5.3 -z "你好"
```

## 工作原理

所有请求都发往 `copilot.tencent.com`:

| 步骤 | 请求 |
|---|---|
| 创建登录会话 | `POST /v2/plugin/auth/state?platform=CLI` → `{ state, authUrl }` |
| 浏览器登录 | 轮询 `GET /v2/plugin/auth/token?state=…` → access + refresh token |
| 账号信息 | `GET /v2/plugin/login/account?state=…` |
| 刷新令牌 | `POST /v2/plugin/auth/token/refresh`(Header `X-Refresh-Token`) |
| 模型目录 | `GET /v3/config` —— 令牌模式用 `Authorization: Bearer`,Key 模式用 `X-API-Key` |
| 推理 | `POST /v2/chat/completions` —— **只支持流式** |

设计被上游的两个特性塑造:

1. **非流式请求会被拒绝**(`{"code":11101,"msg":"Non-stream chat request is currently not
   supported"}`)。代理一律用 `stream: true` 请求上游;客户端要非流式时,在本地把 SSE
   聚合成一个完整响应(文本、思考、以及分片到达的工具调用)。
2. **模型列表按凭据返回**。`agents[name="cli"].models` 因账号/Key 而异,别的客户端能看到
   的模型 id 在你这里可能被服务端拒绝。**不要硬编码模型列表**,从 `/v3/config` 读。

## 安全与隐私

- 凭据存放于 `~/.workbuddy-proxy/session.json`,权限 `0600`,**绝不写入日志**;`whoami`
  只输出摘要,不含令牌。
- 服务**默认只绑定回环地址**。如果要对局域网开放,请传 `--token`,代理会强制校验
  `Authorization: Bearer <token>`。
- 这个代理代表**你的账号**说话:任何能访问它的人都能消耗你的额度。

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 浏览器显示 **“登录失败 / 登录链接不完整”** | 授权链接被截断 —— 通常是 shell 把 `&` 当成了特殊字符(`cmd /c start`、旧快捷方式)。复制 CLI 打印的完整 URL 粘贴到浏览器即可。本项目在 Windows 上使用 `rundll32` 正是为了避开这个坑。 |
| 代理返回 `code 11101` | 上游拒绝了非流式请求。更新代理 —— 它现在一律流式请求上游、本地聚合。 |
| `尚未登录，请先运行…` | 执行 `workbuddy-proxy login`。 |
| `模型目录 HTTP 401/403` | 凭据无效或过期,重新 `login`。 |
| Hermes 模型选择器里看不到这个 provider | GUI 选择器只读 `models.dev` + 内置 overlay + `config.yaml` 的 `providers:` 段。把 provider 声明在那里(见上)。 |

## 开发

```bash
node --test          # 22 个单元测试
npm run check        # 语法 + 测试
```

目录结构:

```
bin/workbuddy-proxy.js   可执行入口
src/constants.js         端点、Header、路径
src/api.js               插件 HTTP 客户端 + 错误类型
src/auth.js              浏览器登录流程
src/session.js           凭据存储 + 令牌刷新
src/catalog.js           /v3/config 解析 + 缓存
src/sse.js               SSE 解析 + 本地聚合
src/server.js            OpenAI 兼容 HTTP 层
src/cli.js               命令行
src/index.js             编程接口导出
test/                    node:test 测试
```

## 致谢

上游端点与请求形态的梳理参考了
[`@axiaohungry/dsh-llm-workbuddy`](https://github.com/Axiaohungry/dsh-llm-workbuddy)(MIT)
及其 WorkBuddy API 文档。本项目是独立实现。

## 许可

[MIT](./LICENSE)
