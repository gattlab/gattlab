import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { runChecked } from './package-tarball-harness.mjs';

const sampleRoot = resolve('examples/blazor-wasm');
const pin = JSON.parse(
  await readFile(resolve(sampleRoot, 'global.json'), 'utf8'),
);
assert.equal(
  runChecked('Blazor SDK', 'dotnet', ['--version'], sampleRoot),
  pin.sdk.version,
);
for (const [stage, args] of [
  ['locked restore', ['restore', '--locked-mode']],
  [
    'Release publish',
    [
      'publish',
      '--configuration',
      'Release',
      '--no-restore',
      '--output',
      'dist',
    ],
  ],
]) {
  const started = performance.now();
  const output = runChecked(`Blazor ${stage}`, 'dotnet', args, sampleRoot);
  console.log(output);
  console.log(
    `Blazor ${stage}: ${((performance.now() - started) / 1000).toFixed(2)} s`,
  );
}
