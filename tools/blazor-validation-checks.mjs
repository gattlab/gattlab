import assert from 'node:assert/strict';

export function assertBlazorWorkflow(workflow) {
  const sections = workflow.split(/^ {2}blazor:\s*$/mu);
  assert.equal(
    sections.length,
    2,
    'Mandatory Blazor CI job is missing or duplicated',
  );
  const job = sections[1].split(/^ {2}[\w-]+:\s*$/mu)[0];
  for (const required of [
    'name: Blazor sample validation',
    'runs-on: ubuntu-24.04',
    'uses: actions/setup-dotnet@',
    'global-json-file: examples/blazor-wasm/global.json',
    'run: pnpm install --frozen-lockfile',
    'run: pnpm exec playwright install --with-deps chromium',
    'run: pnpm blazor:validate',
  ])
    assert.ok(
      job.includes(required),
      `Blazor CI contract requires ${required}`,
    );
  assert.match(workflow, /contents: read/u);
  assert.match(workflow, /pull_request:/u);
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /push:[\s\S]*branches:[\s\S]*- main/u);
  // Only artifact retention in the Node job may run after a failed contract.
  // Conditions on jobs, triggers and mandatory execution steps remain forbidden.
  const requiredExecution =
    sections[0].replace(
      /(^ {6}- name: Upload navigation and command-count summaries\n) {8}if: always\(\)\n(?= {8}uses: actions\/upload-artifact@)/mu,
      '$1',
    ) + sections[1];
  assert.doesNotMatch(
    requiredExecution,
    /(?:^\s*if:|continue-on-error:|paths(?:-ignore)?:)/mu,
    'Blazor validation must not be optional or path-skipped',
  );
}

export function assertBlazorScripts(scripts) {
  assert.equal(scripts['blazor:build'], 'node tools/blazor-build.mjs');
  assert.equal(
    scripts['blazor:probe'],
    'pnpm build && pnpm blazor:build && node tools/blazor-app-probe.mjs',
  );
  assert.equal(
    scripts['blazor:validate'],
    'pnpm boundaries:check && pnpm blazor:test && pnpm blazor:probe && dotnet format examples/blazor-wasm/GattLab.BlazorSample.csproj --verify-no-changes --no-restore',
  );
  assert.ok(
    scripts['test:guards'].includes('pnpm blazor:test'),
    'Base Node validation must include Blazor source guards',
  );
  assert.doesNotMatch(
    scripts.validate,
    /dotnet|blazor:(?:build|probe|validate)/u,
    'Base validation stays Node-only',
  );
}
