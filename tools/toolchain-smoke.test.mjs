import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const smokeScript = fileURLToPath(
  new URL('./toolchain-smoke.mjs', import.meta.url),
);

test('direct node invocation explains that pnpm is required', () => {
  const environment = { ...process.env };
  delete environment.npm_config_user_agent;

  const result = spawnSync(process.execPath, [smokeScript], {
    encoding: 'utf8',
    env: environment,
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    'GattLab toolchain smoke must be run via `pnpm run toolchain:smoke`.\n',
  );
  assert.doesNotMatch(result.stderr, /AssertionError|ERR_ASSERTION/);
});
