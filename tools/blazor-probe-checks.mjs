import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';

export async function assertPublishedOnlyBlazorApplication(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    assert.equal(
      entry.isSymbolicLink(),
      false,
      `Blazor consumer must not contain symlinks: ${entry.name}`,
    );
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) await assertPublishedOnlyBlazorApplication(path);
    else
      assert.doesNotMatch(
        entry.name,
        /\.(?:cs|razor|csproj)$/u,
        `Blazor consumer must not contain C# source: ${path}`,
      );
  }
}

export function assertBlazorCompilerCoverage(checks) {
  assert.deepEqual(
    checks.map(({ version }) => version).toSorted(),
    ['Version 5.9.3', 'Version 6.0.3'],
    'Both Blazor consumer compilers must complete.',
  );
}

export const blazorSmokeCases = Object.freeze(['B1', 'B2', 'B3']);
export const blazorScenarioCases = Object.freeze([
  'E1',
  'E2',
  'E3',
  'E4',
  'E5',
  'L1',
  'L2a',
  'L2b',
  'L3',
]);

export function assertBlazorSpecCoverage(files, root) {
  for (const file of [
    'playwright.config.ts',
    'tests/blazor-app.spec.ts',
    'tests/blazor-scenarios.spec.ts',
    'tests/artifact-failure.spec.ts',
    'tests/probe-support.ts',
  ]) {
    assert.ok(
      files.includes(resolve(root, file)),
      `Blazor strict check must include ${file}`,
    );
  }
}

export function assertBlazorReport(report, cases = blazorSmokeCases) {
  const specs = [];
  function visit(suite) {
    specs.push(...(suite.specs ?? []));
    for (const child of suite.suites ?? []) visit(child);
  }
  for (const suite of report.suites ?? []) visit(suite);
  assert.equal(
    specs.length,
    cases.length,
    `All ${String(cases.length)} Blazor cases (${cases.join(', ')}) must execute exactly once.`,
  );
  for (const [index, spec] of specs.entries()) {
    assert.ok(
      spec.title.startsWith(`${cases[index]}:`),
      `Missing or reordered Blazor case ${cases[index]}`,
    );
    assert.equal(spec.tests.length, 1);
    const test = spec.tests[0];
    assert.equal(test.status, 'expected');
    assert.equal(
      test.results.length,
      1,
      'No retries or repeats in Blazor cases',
    );
    assert.equal(
      test.results[0].status,
      'passed',
      `${spec.title} must pass (not skip)`,
    );
  }
  assert.equal(report.config.workers, 1);
  assert.equal(report.stats.expected, cases.length);
  assert.equal(report.stats.unexpected, 0);
  assert.equal(report.stats.skipped, 0);
  assert.equal(report.stats.flaky, 0);
  assert.deepEqual(report.errors, []);
}

export async function assertBlazorAssetParity(repositoryRoot, wwwroot) {
  const sourceRoot = resolve(repositoryRoot, 'examples/blazor-wasm/wwwroot');
  for (const asset of ['bluetooth.js', 'bluetooth-profile.js']) {
    assert.deepEqual(
      await readFile(resolve(wwwroot, asset)),
      await readFile(resolve(sourceRoot, asset)),
      `Published/copied ${asset} must be byte-identical to handwritten source.`,
    );
  }
  const vanilla = await readFile(
    resolve(repositoryRoot, 'examples/vanilla-ts/src/bluetooth-profile.ts'),
    'utf8',
  );
  const published = await readFile(
    resolve(wwwroot, 'bluetooth-profile.js'),
    'utf8',
  );
  async function exportsOf(source) {
    return {
      ...(await import(
        `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
      )),
    };
  }
  assert.deepEqual(
    await exportsOf(published),
    await exportsOf(
      ts.transpileModule(vanilla, {
        compilerOptions: { module: ts.ModuleKind.ESNext },
      }).outputText,
    ),
    'Published Blazor profile must match the actual Vanilla exports/values.',
  );
}
