import test from 'node:test';
import assert from 'node:assert/strict';

import { browserCommand } from '../src/browser.js';

test('windows uses rundll32 so the URL is never parsed by cmd', () => {
  const url = 'https://copilot.tencent.com/login?platform=CLI&state=abc';
  const [command, args] = browserCommand(url, 'win32');

  assert.equal(command, 'rundll32');
  assert.deepEqual(args, ['url.dll,FileProtocolHandler', url]);
  // Regression guard: `cmd /c start "" <url>` truncates at the `&`.
  assert.notEqual(command, 'cmd');
});

test('macOS and linux use the platform opener', () => {
  assert.deepEqual(browserCommand('https://x.test', 'darwin'), ['open', ['https://x.test']]);
  assert.deepEqual(browserCommand('https://x.test', 'linux'), ['xdg-open', ['https://x.test']]);
});
