/**
 * 命令行界面。
 *
 *   workbuddy-proxy login [--label 名称]           浏览器登录;新增一个账号
 *   workbuddy-proxy accounts                       列出已保存账号
 *   workbuddy-proxy use <id|名称|序号>             切换当前账号
 *   workbuddy-proxy whoami [--account <key>]       查看某个账号的摘要
 *   workbuddy-proxy models [--refresh] [--account <key>] [--hermes]
 *   workbuddy-proxy serve [--port] [--host] [--token] [--account <key>] [--fallback]
 *   workbuddy-proxy logout [--account <key>] [--all]
 */

import { DEFAULT_HOST, DEFAULT_PORT } from './constants.js';
import { login, accountLabel } from './auth.js';
import {
  ensureFreshSession,
  findSession,
  loadStore,
  saveStore,
  removeSession,
  setActiveSession,
  listAccounts,
  sessionSummary,
  clearStore,
} from './session.js';
import { fetchModels, clearCache, sessionCredential } from './catalog.js';
import { startServer } from './server.js';
import { HEARTBEAT_INTERVAL_MS } from './constants.js';

const HELP = `workbuddy-proxy —— 把腾讯 WorkBuddy(CodeBuddy)模型代理成 OpenAI 兼容接口

用法:
  workbuddy-proxy login [--label <名称>]      浏览器登录;新增账号并设为当前
  workbuddy-proxy accounts                    列出已保存账号(* 标记当前账号)
  workbuddy-proxy use <id|名称|序号>          切换当前账号
  workbuddy-proxy whoami [--account <key>]    查看某个账号的摘要
  workbuddy-proxy models [--refresh] [--account <key>]
  workbuddy-proxy models --hermes             生成 Hermes config.yaml 的 providers 片段
  workbuddy-proxy serve [--port 8788] [--host 127.0.0.1] [--token sk-local]
                        [--account <key>] [--fallback] [--heartbeat <秒>]
  workbuddy-proxy logout [--account <key>] [--all]
  workbuddy-proxy help

启动参数说明:
  --account       所有请求的默认账号(单个请求可用
                  "X-WorkBuddy-Account: <id|名称|序号>" header 或 "?account=" query 覆盖)
  --fallback      某个账号失败时,按顺序尝试剩余账号
  --heartbeat     SSE 心跳间隔秒数(默认 ${HEARTBEAT_INTERVAL_MS / 1000};0 表示关闭)

环境变量:
  WORKBUDDY_PROXY_HOME    凭据与缓存目录(默认 ~/.workbuddy-proxy)
`;

/** 解析 `--标志 值` 与位置参数。 */
export function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out.flags[name] = next;
        i++;
      } else {
        out.flags[name] = true;
      }
    } else {
      out._.push(arg);
    }
  }
  return out;
}

/** 人类可读的模型列表。 */
export function formatModels(models) {
  const lines = [`共 ${models.length} 个模型:`, ''];
  for (const model of models) {
    lines.push(
      `  ${model.id.padEnd(22)} ${String(model.name).padEnd(20)} ` +
        `上下文=${String(model.contextWindow).padStart(9)} 输出=${String(model.maxTokens).padStart(7)}` +
        `${model.images ? '  图片' : ''}${model.reasoning ? '  思考' : ''}`,
    );
  }
  return lines.join('\n');
}

/** 人类可读的账号列表。 */
export function formatAccounts(accounts) {
  if (!accounts.length) return '还没有账号。请先运行:workbuddy-proxy login';
  const lines = [`共 ${accounts.length} 个账号:`, ''];
  accounts.forEach((account, index) => {
    lines.push(
      `  ${account.active ? '*' : ' '} ${String(index + 1).padStart(2)}  ` +
        `${account.id}  ${String(account.label ?? '').padEnd(16)}  ` +
        `过期时间 ${account.expiresAt ?? '未知'}`,
    );
  });
  return lines.join('\n');
}

/** 根据实时模型目录生成 Hermes `providers:` 片段。 */
export function formatHermesSnippet(models, { name = 'workbuddy-proxy', baseUrl = 'http://127.0.0.1:8788/v1' } = {}) {
  const lines = [
    '# 粘贴到 Hermes config.yaml 的 providers: 段下',
    "#   hermes config set providers.workbuddy-proxy '<json>' --force",
    '',
    `  ${name}:`,
    '    name: WorkBuddy (proxy)',
    `    base_url: ${baseUrl}`,
    `    model: ${models[0]?.id ?? ''}`,
    '    discover_models: false',
    '    models:',
  ];
  for (const model of models) {
    lines.push(`      ${model.id}:`);
    lines.push(`        context_length: ${model.contextWindow}`);
    if (model.images) lines.push('        supports_vision: true');
  }
  return lines.join('\n');
}

/** 运行 CLI。@returns {Promise<number>} 退出码 */
export async function run(argv, io = console) {
  const { _: positional, flags } = parseArgs(argv);
  const command = positional[0] ?? 'help';

  switch (command) {
    case 'login': {
      const session = await login({
        onAuthUrl: (url, opened) => {
          io.log('\n请在浏览器中完成登录:');
          if (!opened) io.log('  (未能自动打开浏览器 —— 请手动复制下面的链接)');
          io.log(`\n  ${url}\n`);
        },
      });
      if (flags.label) {
        const store = loadStore();
        const target = findSession(store, session.id);
        if (target) {
          target.label = String(flags.label);
          saveStore(store);
        }
      }
      io.log(`✅ 已登录:${accountLabel(session.account) ?? '未知账号'}(id ${session.id})`);
      io.log('   该账号现在是当前账号。运行 "workbuddy-proxy accounts" 查看全部。');
      return 0;
    }

    case 'accounts': {
      io.log(formatAccounts(listAccounts(loadStore())));
      return 0;
    }

    case 'use': {
      const key = positional[1];
      if (!key) {
        io.error('用法:workbuddy-proxy use <id|名称|序号>');
        return 1;
      }
      const store = loadStore();
      const target = setActiveSession(store, key);
      if (!target) {
        io.error(`找不到账号「${key}」。运行 workbuddy-proxy accounts 查看。`);
        return 1;
      }
      saveStore(store);
      io.log(`当前账号已切换为:${target.label}(${target.id})`);
      return 0;
    }

    case 'whoami': {
      const store = loadStore();
      const session = findSession(store, flags.account);
      const summary = sessionSummary(session);
      if (!summary) {
        io.log('尚未登录。');
        return 1;
      }
      io.log(JSON.stringify({ ...summary, active: session.id === store.activeId }, null, 2));
      return 0;
    }

    case 'logout': {
      const store = loadStore();
      if (flags.all) {
        const count = store.sessions.length;
        clearStore();
        clearCache();
        io.log(count ? `已删除 ${count} 个账号。` : '没有可删除的账号。');
        return 0;
      }
      const removed = removeSession(store, flags.account);
      if (!removed) {
        io.log('没有可删除的账号。');
        return 0;
      }
      saveStore(store);
      clearCache();
      io.log(`已删除账号:${removed.label}(${removed.id})。`);
      if (store.activeId) io.log(`当前账号已切换为 ${store.activeId}。`);
      return 0;
    }

    case 'models': {
      const session = await ensureFreshSession({ account: flags.account });
      const models = await fetchModels(sessionCredential(session), { force: flags.refresh === true });
      io.log(flags.hermes ? formatHermesSnippet(models) : formatModels(models));
      return 0;
    }

    case 'serve': {
      const port = Number(flags.port ?? DEFAULT_PORT);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        io.error(`--port 无效:${flags.port}`);
        return 1;
      }
      let heartbeatMs = HEARTBEAT_INTERVAL_MS;
      if (flags.heartbeat !== undefined) {
        const seconds = Number(flags.heartbeat);
        if (!Number.isFinite(seconds) || seconds < 0) {
          io.error(`--heartbeat 无效:${flags.heartbeat}(应为秒数,0 表示关闭)`);
          return 1;
        }
        heartbeatMs = Math.round(seconds * 1000);
      }
      startServer({
        port,
        host: String(flags.host ?? DEFAULT_HOST),
        localToken: String(flags.token ?? ''),
        allowFallthrough: flags.fallback === true,
        heartbeatMs,
        logger: io,
      });
      return 0;
    }

    case 'help':
    default:
      io.log(HELP);
      return command === 'help' ? 0 : 1;
  }
}
