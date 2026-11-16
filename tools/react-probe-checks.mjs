import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

export const reactCases = Object.freeze(['R1', 'R2', 'R3', 'R4']);
export const reactDevelopmentMarker = 'Download the React DevTools';
export const reactRequiredFiles = Object.freeze([
  'playwright.config.ts',
  'tests/react-app.spec.ts',
  'tests/artifact-failure.spec.ts',
  'tests/probe-support.ts',
]);

export function assertReactCompilerCoverage(checks) {
  assert.deepEqual(
    checks.map(({ version }) => version).toSorted(),
    ['Version 5.9.3', 'Version 6.0.3'],
    'Both React consumer compilers must complete exactly once.',
  );
}

export function assertReactSpecCoverage(files, root, additional = []) {
  for (const file of [...reactRequiredFiles, ...additional]) {
    assert.ok(
      files.includes(resolve(root, file)),
      `React strict check must include ${file}`,
    );
  }
}

export function assertReactReport(report) {
  const specs = [];
  function visit(suite) {
    specs.push(...(suite.specs ?? []));
    for (const child of suite.suites ?? []) visit(child);
  }
  for (const suite of report.suites ?? []) visit(suite);
  assert.equal(specs.length, 4, 'All four React cases must execute once.');
  for (const [index, spec] of specs.entries()) {
    assert.ok(
      spec.title.startsWith(`${reactCases[index]}:`),
      `Missing or reordered React case ${reactCases[index]}`,
    );
    assert.equal(spec.tests.length, 1);
    const result = spec.tests[0];
    assert.equal(result.status, 'expected');
    assert.equal(result.results.length, 1, 'No React retries or repeats.');
    assert.equal(result.results[0].status, 'passed', `${spec.title} must pass`);
  }
  assert.equal(report.config.workers, 1);
  assert.equal(report.config.projects.length, 1);
  assert.equal(report.config.projects[0].retries, 0);
  assert.equal(report.config.projects[0].repeatEach, 1);
  assert.equal(report.stats.expected, 4);
  assert.equal(report.stats.unexpected, 0);
  assert.equal(report.stats.skipped, 0);
  assert.equal(report.stats.flaky, 0);
  assert.deepEqual(report.errors, []);
}

export async function assertPublishedOnlyReactApplication(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    assert.equal(
      entry.isSymbolicLink(),
      false,
      'React assets cannot be symlinks.',
    );
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      assert.notEqual(
        entry.name,
        'src',
        'React consumer cannot contain app source.',
      );
      assert.notEqual(
        entry.name,
        'node_modules',
        'React assets cannot contain dependencies.',
      );
      await assertPublishedOnlyReactApplication(path);
    } else {
      assert.ok(
        !['.ts', '.tsx', '.map'].includes(extname(entry.name)),
        `React consumer must contain built assets only: ${path}`,
      );
    }
  }
}

async function canonicalProfile(repositoryRoot) {
  const source = await readFile(
    resolve(repositoryRoot, 'examples/vanilla-ts/src/bluetooth-profile.ts'),
    'utf8',
  );
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext },
  }).outputText;
  return import(
    `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
  );
}

function fixtureProfile(source) {
  const file = ts.createSourceFile(
    'probe-support.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const values = {};
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const name = declaration.name.text;
      if (
        !['serviceUuid', 'ioCharacteristicUuid', 'writePayload'].includes(name)
      )
        continue;
      let value = declaration.initializer;
      while (
        value &&
        (ts.isAsExpression(value) || ts.isParenthesizedExpression(value))
      ) {
        value = value.expression;
      }
      if (value && ts.isStringLiteralLike(value)) values[name] = value.text;
      else if (value && ts.isArrayLiteralExpression(value)) {
        assert.ok(
          value.elements.every(ts.isNumericLiteral),
          'Expected independent numeric payload literals.',
        );
        values[name] = value.elements.map((element) => Number(element.text));
      }
    }
  }
  return values;
}

export async function assertReactProfileParity(repositoryRoot, supportPath) {
  const canonical = await canonicalProfile(repositoryRoot);
  const expected = fixtureProfile(await readFile(supportPath, 'utf8'));
  for (const name of ['serviceUuid', 'ioCharacteristicUuid', 'writePayload']) {
    assert.deepEqual(
      expected[name],
      canonical[name],
      `React fixture ${name} must match canonical profile exports.`,
    );
  }
  return {
    serviceUuid: canonical.serviceUuid,
    ioCharacteristicUuid: canonical.ioCharacteristicUuid,
  };
}

// Read only the entry scripts and their static/dynamic imported chunks. A stray
// development file beside a production entry must not satisfy the runtime check.
export async function readReactBundle(root) {
  const html = await readFile(resolve(root, 'index.html'), 'utf8');
  const entries = [
    ...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/giu),
  ].map((match) => match[1]);
  assert.ok(entries.length > 0, 'Built React HTML must load JavaScript.');
  const files = new Map();
  async function visit(specifier, parent = resolve(root, 'index.html')) {
    assert.doesNotMatch(
      specifier,
      /^(?:[a-z]+:|\/\/)/iu,
      'React bundle must be offline.',
    );
    const path = resolve(
      specifier.startsWith('/') ? root : dirname(parent),
      specifier.replace(/^\//u, '').split(/[?#]/u)[0],
    );
    const local = relative(root, path);
    assert.ok(
      local !== '..' && !local.startsWith(`..${sep}`),
      'Bundle import cannot escape its root.',
    );
    if (files.has(path)) return;
    const source = await readFile(path, 'utf8');
    files.set(path, source);
    const parsed = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const imports = [];
    function collect(node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      )
        imports.push(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0])
      )
        imports.push(node.arguments[0].text);
      ts.forEachChild(node, collect);
    }
    collect(parsed);
    for (const imported of imports) await visit(imported, path);
  }
  for (const entry of entries) await visit(entry);
  return files;
}

export async function assertReactBuiltAssets(
  repositoryRoot,
  appRoot,
  supportPath,
) {
  await assertPublishedOnlyReactApplication(appRoot);
  const expected = await assertReactProfileParity(repositoryRoot, supportPath);
  const assets = {};
  for (const build of ['production', 'development']) {
    const files = await readReactBundle(resolve(appRoot, 'dist', build));
    const text = [...files.values()].join('\n');
    assert.doesNotMatch(
      text,
      /@gattlab\//u,
      'GattLab must not enter the browser bundle.',
    );
    const uuids = new Set(
      text.match(/[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}/giu),
    );
    assert.deepEqual(
      [...uuids].toSorted(),
      Object.values(expected).toSorted(),
      `${build} bundle must use only the canonical IO UUIDs.`,
    );
    const marked = [...files]
      .filter(([, source]) => source.includes(reactDevelopmentMarker))
      .map(([file]) => relative(appRoot, file));
    assert.equal(
      marked.length > 0,
      build === 'development',
      `${build} React runtime marker must ${build === 'development' ? 'be present' : 'be absent'}.`,
    );
    assets[build] = {
      files: [...files.keys()].map((file) => relative(appRoot, file)),
      developmentMarkerFiles: marked,
    };
  }
  return assets;
}

export async function assertReactDevelopmentRuntime(root) {
  const files = await readReactBundle(root);
  assert.ok(
    [...files.values()].some((source) =>
      source.includes(reactDevelopmentMarker),
    ),
    'development React runtime marker must be present.',
  );
}
