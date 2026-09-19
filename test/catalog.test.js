import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCatalog } from '../src/catalog.js';

const payload = {
  agents: [
    { name: 'cli', models: ['hy3', 'glm-5.2'] },
    { name: 'web', models: ['not-for-cli'] },
  ],
  models: [
    {
      id: 'hy3',
      name: 'Hy3',
      maxInputTokens: 192000,
      maxOutputTokens: 64000,
      supportsImages: true,
      supportsReasoning: true,
      reasoning: { effort: 'high' },
    },
    { id: 'glm-5.2', name: 'GLM-5.2', maxAllowedSize: 1000000, maxOutputTokens: 64000 },
    { id: 'not-for-cli', name: 'Nope', maxInputTokens: 1, maxOutputTokens: 1 },
  ],
};

test('parseCatalog keeps only cli-agent models', () => {
  const models = parseCatalog(payload);
  assert.deepEqual(
    models.map((m) => m.id),
    ['hy3', 'glm-5.2'],
  );
});

test('parseCatalog reads capacity, modalities and default effort', () => {
  const [hy3, glm] = parseCatalog(payload);
  assert.equal(hy3.contextWindow, 192000);
  assert.equal(hy3.maxTokens, 64000);
  assert.equal(hy3.images, true);
  assert.equal(hy3.reasoning, true);
  assert.equal(hy3.defaultEffort, 'high');
  assert.equal(glm.contextWindow, 1000000, 'falls back to maxAllowedSize');
  assert.equal(glm.images, false);
  assert.equal(glm.reasoning, false);
});

test('parseCatalog drops entries without usable capacity', () => {
  const models = parseCatalog({
    agents: [{ name: 'cli', models: ['a', 'b'] }],
    models: [
      { id: 'a', maxInputTokens: 1000, maxOutputTokens: 100 },
      { id: 'b', name: 'no capacity' },
    ],
  });
  assert.deepEqual(
    models.map((m) => m.id),
    ['a'],
  );
});

test('parseCatalog accepts the legacy nested agents shape', () => {
  const models = parseCatalog({ agent: { agents: [{ name: 'cli', models: ['x'] }] }, models: [{ id: 'x', maxInputTokens: 5, maxOutputTokens: 5 }] });
  assert.equal(models.length, 1);
});

test('parseCatalog tolerates a payload with no agents', () => {
  assert.deepEqual(parseCatalog({}), []);
  assert.deepEqual(parseCatalog(undefined), []);
});
