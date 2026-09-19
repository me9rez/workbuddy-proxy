/**
 * 在用户默认浏览器中打开 URL。
 *
 * Windows 上 `cmd /c start "" <url>` 在这里是**有害的**:cmd 会把 URL 里的 `&` 当成
 * 命令分隔符,授权链接被截断后 WorkBuddy 会渲染 "登录失败 / 登录链接不完整"。
 * `rundll32` 把 URL 当作普通 argv 交给 ShellExecute,不会被解析。
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
