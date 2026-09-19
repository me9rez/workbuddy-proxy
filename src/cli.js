/**
 * Command line interface.
 *
 *   workbuddy-proxy login [--label name]           browser login; adds an account
 *   workbuddy-proxy accounts                       list stored accounts
 *   workbuddy-proxy use <id|label|index>           switch the active account
 *   workbuddy-proxy whoami [--account <key>]       print one account's summary
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

const HELP = `workbuddy-proxy — OpenAI-compatible proxy for Tencent WorkBuddy (CodeBuddy) models

Usage:
  workbuddy-proxy login [--label <name>]      Sign in; adds an account and makes it active
  workbuddy-proxy accounts                    List stored accounts (* marks the active one)
  workbuddy-proxy use <id|label|index>        Switch the active account
  workbuddy-proxy whoami [--account <key>]    Print an account summary
  workbuddy-proxy models [--refresh] [--account <key>]
  workbuddy-proxy models --hermes             Print a Hermes config.yaml providers snippet
  workbuddy-proxy serve [--port 8788] [--host 127.0.0.1] [--token sk-local]
                        [--account <key>] [--fallback]
  workbuddy-proxy logout [--account <key>] [--all]
  workbuddy-proxy help

Serving notes:
  --account       default account for every request (per-request override:
                  "X-WorkBuddy-Account: <id|label|index>" header or "?account=" query)
  --fallback      when an account fails, try the remaining accounts in order

Environment:
  WORKBUDDY_PROXY_HOME    Directory for credentials and caches (default: ~/.workbuddy-proxy)
`;

/** Parse `--flag value` and positional arguments. */
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

/** Human-readable model table. */
export function formatModels(models) {
  const lines = [`${models.length} model(s):`, ''];
  for (const model of models) {
    lines.push(
      `  ${model.id.padEnd(22)} ${String(model.name).padEnd(20)} ` +
        `ctx=${String(model.contextWindow).padStart(9)} out=${String(model.maxTokens).padStart(7)}` +
        `${model.images ? '  vision' : ''}${model.reasoning ? '  reasoning' : ''}`,
    );
  }
  return lines.join('\n');
}

/** Human-readable account table. */
export function formatAccounts(accounts) {
  if (!accounts.length) return 'No accounts. Run: workbuddy-proxy login';
  const lines = [`${accounts.length} account(s):`, ''];
  accounts.forEach((account, index) => {
    lines.push(
      `  ${account.active ? '*' : ' '} ${String(index + 1).padStart(2)}  ` +
        `${account.id}  ${String(account.label ?? '').padEnd(16)}  ` +
        `expires ${account.expiresAt ?? 'unknown'}`,
    );
  });
  return lines.join('\n');
}

/** Hermes `providers:` snippet built from the live catalog. */
export function formatHermesSnippet(models, { name = 'workbuddy-proxy', baseUrl = 'http://127.0.0.1:8788/v1' } = {}) {
  const lines = [
    '# Paste under `providers:` in Hermes config.yaml',
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

/** Run the CLI. @returns {Promise<number>} exit code */
export async function run(argv, io = console) {
  const { _: positional, flags } = parseArgs(argv);
  const command = positional[0] ?? 'help';

  switch (command) {
    case 'login': {
      const session = await login({
        onAuthUrl: (url, opened) => {
          io.log('\nComplete the sign-in in your browser:');
          if (!opened) io.log('  (could not open a browser automatically — paste this URL)');
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
      io.log(`✅ Logged in as ${accountLabel(session.account) ?? 'unknown'} (id ${session.id})`);
      io.log('   This account is now active. Run "workbuddy-proxy accounts" to see them all.');
      return 0;
    }

    case 'accounts': {
      io.log(formatAccounts(listAccounts(loadStore())));
      return 0;
    }

    case 'use': {
      const key = positional[1];
      if (!key) {
        io.error('Usage: workbuddy-proxy use <id|label|index>');
        return 1;
      }
      const store = loadStore();
      const target = setActiveSession(store, key);
      if (!target) {
        io.error(`No account matches "${key}". Run: workbuddy-proxy accounts`);
        return 1;
      }
      saveStore(store);
      io.log(`Active account: ${target.label} (${target.id})`);
      return 0;
    }

    case 'whoami': {
      const store = loadStore();
      const session = findSession(store, flags.account);
      const summary = sessionSummary(session);
      if (!summary) {
        io.log('Not logged in.');
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
        io.log(count ? `Removed ${count} account(s).` : 'Nothing to remove.');
        return 0;
      }
      const removed = removeSession(store, flags.account);
      if (!removed) {
        io.log('Nothing to remove.');
        return 0;
      }
      saveStore(store);
      clearCache();
      io.log(`Removed account ${removed.label} (${removed.id}).`);
      if (store.activeId) io.log(`Active account is now ${store.activeId}.`);
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
        io.error(`Invalid --port: ${flags.port}`);
        return 1;
      }
      startServer({
        port,
        host: String(flags.host ?? DEFAULT_HOST),
        localToken: String(flags.token ?? ''),
        allowFallthrough: flags.fallback === true,
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
