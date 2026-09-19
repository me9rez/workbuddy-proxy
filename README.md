# workbuddy-proxy

**简体中文** · [English](./README.en.md)

把 **腾讯 WorkBuddy(CodeBuddy)** 的模型代理成本地 **OpenAI 兼容** HTTP 接口。

浏览器登录一次,然后把任何 OpenAI 兼容客户端指向 `http://127.0.0.1:8788/v1` ——
Hermes、dsh、OpenAI SDK、IDE 插件、shell 脚本都能直接用。

- 🔐 **浏览器登录** —— 不需要 API Key,访问令牌自动刷新
- 👥 **多账号** —— 可以登录多个账号,按请求指定用哪个
- 📋 **实时模型目录** —— 按凭据返回真实模型列表,含上下文窗口和模态
- 🔁 **流式 + 非流式** —— 上游只支持流式,代理会在本地把它折回完整响应
- 💓 **可选的心跳与断流检测** —— 心跳防止长连接被超时断开;断流检测在流被截断时补发错误事件。**两者默认关闭**,用 `--heartbeat <秒>` / `--detect-truncation` 显式开启
- 🧩 **零依赖** —— Node ≥ 22,只用标准库
- 🛡️ **默认只监听本机** —— 需要对外时可加本地 API Key 加固(`--token` / `--token-file` / 环境变量)

> **非官方项目。** 这是第三方适配器,与腾讯 / WorkBuddy / CodeBuddy 无隶属、背书或支持关系。
> 上游接口不是公开、稳定承诺的开发者 API,路径和 Header 可能随 CodeBuddy 版本变化。

## 环境要求

- Node.js **≥ 22**(用到内置 `fetch` 与 `node:test`)
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
# 1. 登录(会尝试自动打开浏览器;完整 URL 也会打印出来，可手动粘贴)
workbuddy-proxy login

# 2. 看看这个账号能用哪些模型
workbuddy-proxy models

# 3. 启动代理
workbuddy-proxy serve
# → http://127.0.0.1:8788/v1
```

然后随便用:

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
| `workbuddy-proxy serve [--port 8788] [--host 127.0.0.1] [--token sk-local] [--token-file <路径>] [--account <key>] [--fallback] [--heartbeat <秒>] [--detect-truncation]` | 启动代理 |
| `workbuddy-proxy logout [--account <key>] [--all]` | 删除一个账号,或全部 |

### 流式行为(两个可选开关,**默认都关闭**)

默认情况下代理是**纯透传**:上游怎么写就怎么转发,不插入任何内容、不改结束方式。

需要时用这两个开关加固,**都必须显式开启**:

**心跳保活** —— `--heartbeat <秒>`

定期往流里写一行 SSE 注释(`: keep-alive`)。注释行按规范会被客户端忽略,所以不会污染数据,
但能防止客户端或中间层在长时间没有数据时把连接判为超时。建议设为比你链路的最短超时略小,
例如 `--heartbeat 15`。

**断流检测** —— `--detect-truncation`

上游中途断线,或流结束时**没有**出现结束标记(`[DONE]` / `finish_reason`)时,补发一个
OpenAI 风格的错误事件:

```text
data: {"error":{"message":"上游流中断:socket hang up","type":"upstream_error"}}
```

否则客户端会把截断的输出当成正常结束。非流式请求也会一并校验:SSE 不完整时直接报错,
而不是返回残缺的 completion。

```bash
# 两个都开
workbuddy-proxy serve --heartbeat 15 --detect-truncation
```

### 环境变量

| 变量 | 含义 |
|---|---|
| `WORKBUDDY_PROXY_HOME` | 凭据与缓存目录(默认 `~/.workbuddy-proxy`) |
| `DEBUG` | 出错时打印堆栈 |

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

## HTTP 接口

| 路由 | 说明 |
|---|---|
| `GET /health` | `{ ok, activeId, account, accounts }` |
| `GET /v1/accounts` | 已保存账号(id、名称、是否当前、过期时间 —— 不含令牌) |
| `GET /v1/models` | OpenAI 模型列表,附 `context_length`、`max_output_tokens`、`capabilities` |
| `GET /v1/models?refresh=1` | 绕过 10 分钟目录缓存 |
| `POST /v1/chat/completions` | 对话补全(`"stream": true` 直接透传 SSE,否则本地聚合) |

账号选择:`X-WorkBuddy-Account: <id|名称|序号>` header,或 `?account=<key>`;都不给则用当前账号。

### 本地 API Key(鉴权)

给代理加一道门。**默认不鉴权**,显式传参才启用(与心跳/断流检测同一原则)。

| 来源 | 用法 | 适用场景 |
|---|---|---|
| `--token <key>` | `serve --token sk-local` | 手工调试 |
| `--token-file <路径>` | `serve --token-file ~/.workbuddy-proxy/api-key.txt` | **计划任务/容器**(Key 不会出现在进程命令行里) |
| `WORKBUDDY_PROXY_API_KEY` | 环境变量 | CI、容器编排 |

优先级:`--token` > `--token-file` > 环境变量。

启用后:

- 所有 `/v1/*` 请求必须带 `Authorization: Bearer <key>`,否则返回 `401` 且带
  `WWW-Authenticate: Bearer realm="workbuddy-proxy"`
- Key 用**常量时间比较**(`crypto.timingSafeEqual`),不会因响应耗时被逐字符猜出来
- **`GET /healthz` 和 `GET /ping` 免鉴权**,只回 `{"ok":true}` —— 方便监控和隧道探活,
  且**不泄露账号信息**(`/health` 会显示账号,所以它仍需要鉴权)

客户端带上它:

```python
client = OpenAI(base_url="http://127.0.0.1:8788/v1", api_key="sk-local")   # 原样放进 api_key
```

```bash
curl -H "Authorization: Bearer sk-local" http://127.0.0.1:8788/v1/models
```

用安装脚本时可以直接生成一个:

```powershell
pwsh -File scripts/install-service.ps1 -GenerateApiKey -StartNow
# 🔑 已生成 API Key: sk-wb-xxxxxxxx…
#    保存在 ~/.workbuddy-proxy/api-key.txt(仅当前用户可读,用 icacls 收窄了权限)
```

之后用 `Get-Content "$HOME\.workbuddy-proxy\api-key.txt"` 取出来填给客户端即可。

## 接入 Hermes

```bash
workbuddy-proxy models --hermes   # 打印片段
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

> Hermes 的模型选择器只读 `models.dev` 映射表、内置 overlay 和 `config.yaml` 的 `providers:` 段,
> 所以自定义 provider **必须**写进配置才能在选择器里看到。

## 接入 OpenAI SDK

```js
import OpenAI from 'openai';

const client = new OpenAI({ baseURL: 'http://127.0.0.1:8788/v1', apiKey: 'not-needed' });

const stream = await client.chat.completions.create({
  model: 'deepseek-v4.1-flash',
  messages: [{ role: 'user', content: '你好' }],
  stream: true,
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
```

Python 等其他语言同理 —— 只要是 OpenAI 兼容客户端,把 `base_url` 指过来即可。

## 作为常驻服务运行

代理要常驻,客户端才能随时用。下面是把它做成开机/登录自启的几种方式。

### Windows:计划任务(推荐,仓库自带脚本)

```powershell
# 登录时自动启动,隐藏窗口,监听 8788
pwsh -File scripts/install-service.ps1 -StartNow

# 顺带开启心跳与断流检测
pwsh -File scripts/install-service.ps1 -HeartbeatSeconds 15 -DetectTruncation -StartNow

# 对外暴露时请加本地令牌
pwsh -File scripts/install-service.ps1 -BindHost 0.0.0.0 -LocalToken sk-local -StartNow

# PATH 里没有 node(mise/nvm 等)时显式指定
pwsh -File scripts/install-service.ps1 -NodePath "$env:LOCALAPPDATA\mise\installs\node\24.21.0\node.exe" -StartNow
```

脚本做的事:

1. 在 `%USERPROFILE%\.workbuddy-proxy` 生成两个包装文件
   - `service.cmd` —— 真正的启动命令,并把 stdout/stderr 追加到 `proxy.log`
   - `service.vbs` —— 用 `WScript.Shell.Run(..., 0, ...)` **隐藏窗口**拉起 `service.cmd`
2. 注册名为 **WorkBuddy Proxy** 的计划任务:
   - 触发器:当前用户**登录时**
   - 动作:`wscript.exe <service.vbs>`
   - 设置:允许电池、不限执行时长、**失败后每分钟重启,最多 3 次**
   - 身份:当前用户(交互式,**不需要管理员**)

常用操作:

| 操作 | 命令 |
|---|---|
| 查看状态 | `Get-ScheduledTask -TaskName 'WorkBuddy Proxy' \| Get-ScheduledTaskInfo` |
| 手动启动 | `Start-ScheduledTask -TaskName 'WorkBuddy Proxy'` |
| 手动停止 | `Stop-ScheduledTask -TaskName 'WorkBuddy Proxy'` |
| 看日志 | `Get-Content "$HOME\.workbuddy-proxy\proxy.log" -Tail 50` |
| 卸载 | `pwsh -File scripts/uninstall-service.ps1`(加 `-Purge` 连包装文件和日志一起删) |

改端口/参数后重新跑一次安装脚本即可(它会覆盖包装文件和任务)。

**不想用脚本?** 等价的手工做法:

```powershell
$exe  = (Get-Command node).Source
$root = 'D:\workspace\workbuddy-proxy'          # 换成你的路径
$dir  = "$HOME\.workbuddy-proxy"
New-Item -ItemType Directory -Force $dir | Out-Null

# 1. 启动命令(重定向日志)
"`"$exe`" `"$root\bin\workbuddy-proxy.js`" serve --port 8788 >> `"$dir\proxy.log`" 2>&1" |
    Set-Content "$dir\service.cmd" -Encoding OEM

# 2. 注册任务
$action   = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$dir\service.cmd`""
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'WorkBuddy Proxy' -Action $action -Trigger $trigger -Settings $settings -Force

# 3. 启动
Start-ScheduledTask -TaskName 'WorkBuddy Proxy'
```

> ⚠️ 上面这种直接跑 `cmd.exe` 的写法会在登录时**弹出一个控制台窗口**。仓库脚本额外用
> `wscript` + `.vbs` 把窗口隐藏,所以更推荐用脚本。
>
> ⚠️ 想改启动参数,**重新运行安装脚本**,不要手改 `service.cmd` —— 下次安装会覆盖它。

### Linux / macOS:systemd user unit

```ini
# ~/.config/systemd/user/workbuddy-proxy.service
[Unit]
Description=WorkBuddy OpenAI-compatible proxy
After=network-online.target

[Service]
ExecStart=%h/.local/bin/workbuddy-proxy serve --port 8788
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now workbuddy-proxy
loginctl enable-linger "$USER"   # 未登录也保持运行
```

macOS 也可以直接用 launchd,或把上面换成 `brew services` 管理的包装脚本。

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

1. **非流式请求会被拒绝**(`{"code":11101,"msg":"Non-stream chat request is currently not supported"}`)。
   代理一律用 `stream: true` 请求上游;客户端要非流式时,在本地把 SSE 聚合成一个完整响应
   (文本、思考、以及分片到达的工具调用)。
2. **模型列表按凭据返回**。`agents[name="cli"].models` 因账号/Key 而异,别的客户端能看到
   的模型 id 在你这里可能被服务端拒绝。**不要硬编码模型列表**,从 `/v3/config` 读。

## 安全与隐私

- 凭据存放于 `~/.workbuddy-proxy/session.json`,权限 `0600`,**绝不写入日志**;`whoami` 只输出
  摘要(账号名、id、过期时间),不含令牌。
- 服务**默认只绑定回环地址**。如果要对局域网开放,请传 `--token`,代理会强制校验
  `Authorization: Bearer <token>`。
- 这个代理代表**你的账号**说话:任何能访问它的人都能消耗你的额度。
- 仓库本身不含任何个人信息 —— 示例与测试数据一律使用中性占位名。

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 浏览器显示 **“登录失败 / 登录链接不完整”** | 授权链接被截断 —— 通常是 shell 把 `&` 当成了特殊字符(`cmd /c start`、旧快捷方式)。复制 CLI 打印的完整 URL 粘贴到浏览器即可。本项目在 Windows 上使用 `rundll32` 正是为了避开这个坑。 |
| 代理返回 `code 11101` | 上游拒绝了非流式请求。更新代理 —— 它现在一律流式请求上游、本地聚合。 |
| `尚未登录，请先运行…` | 执行 `workbuddy-proxy login`。 |
| `找不到账号「xxx」` | 账号 key 写错了。跑 `workbuddy-proxy accounts` 看 id / 名称 / 序号。 |
| `模型目录 HTTP 401/403` | 凭据无效或过期,重新 `login`。 |
| Hermes 模型选择器里看不到这个 provider | GUI 选择器只读 `models.dev` + 内置 overlay + `config.yaml` 的 `providers:` 段。把 provider 声明在那里(见上)。 |
| 装了但命令找不到 | pnpm 全局 bin 目录可能不在 PATH;Windows 上请用 `.cmd`/`.ps1` shim 或 PowerShell,git-bash 下 pnpm 的 bash shim 有已知的 MSYS 路径问题。 |

## 开发

```bash
node --test          # 42 个单元测试
npm run check        # 语法检查 + 测试
```

CI 在 Node 22 / 24 上跑同样的检查(`.github/workflows/ci.yml`)。

目录结构:

```
bin/workbuddy-proxy.js   可执行入口
src/constants.js         端点、Header、路径
src/api.js               插件 HTTP 客户端 + 错误类型
src/auth.js              浏览器登录流程
src/session.js           凭据存储(多账号)+ 令牌刷新
src/catalog.js           /v3/config 解析 + 缓存
src/sse.js               SSE 解析 + 本地聚合
src/server.js            OpenAI 兼容 HTTP 层
src/browser.js           跨平台打开浏览器
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
