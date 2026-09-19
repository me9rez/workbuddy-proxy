/**
 * Opening a URL in the user's default browser.
 *
 * On Windows `cmd /c start "" <url>` is actively dangerous for this use case: cmd treats
 * an `&` inside the URL as a command separator, so the authorization link arrives
 * truncated and WorkBuddy renders "登录失败 / 登录链接不完整". `rundll32` receives the URL
 * as a plain argv entry and hands it to ShellExecute untouched.
 */

import { spawn } from 'node:child_process';

/** @returns {[string, string[]]} platform-specific opener command */
export function browserCommand(url, platform = process.platform) {
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  if (platform === 'darwin') return ['open', [url]];
  return ['xdg-open', [url]];
}

/**
 * Best-effort browser launch. Never throws — callers always print the URL as a fallback.
 * @returns {boolean} whether the opener was spawned
 */
export function openInBrowser(url) {
  const [command, args] = browserCommand(url);
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
