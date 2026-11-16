import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { extname, normalize, relative, resolve } from 'node:path';
import ts from 'typescript';

const sourceExtensions = new Set([
  '.html',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.css',
]);
const scriptExtensions = new Set([
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
]);
const generatedDirectories = new Set(['dist', 'node_modules']);
const uuidLiteral =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;
const forbiddenDomName =
  /^(?:document|querySelector\w*|getElementById|textContent|innerHTML|innerText|outerHTML|insertAdjacent\w*|append|appendChild|replaceChildren|setAttribute|dangerouslySetInnerHTML)$/u;
const profileNames = ['ioCharacteristicUuid', 'serviceUuid', 'writePayload'];
const profileMethods = new Set([
  'requestDevice',
  'getPrimaryService',
  'getCharacteristic',
  'writeValueWithResponse',
]);

function walk(node, visitor) {
  visitor(node);
  ts.forEachChild(node, (child) => walk(child, visitor));
}

function parse(source, file) {
  const kind = /\.[jt]sx$/u.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const tree = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  assert.equal(
    tree.parseDiagnostics.length,
    0,
    `${file}: invalid React source`,
  );
  return tree;
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression)
  )
    return node.argumentExpression.text;
  return undefined;
}

function isNumeric(node) {
  return (
    ts.isNumericLiteral(node) ||
    (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand))
  );
}

export function assertReactSourceBoundary(source, file) {
  assert.doesNotMatch(
    source,
    /@gattlab|\bplaywright(?:-core)?\b|@playwright|(?:packages|tools)\/|test[-/]helpers|BluetoothEmulation|DeviceAccess/iu,
    `${file}: React application cannot reference GattLab testing packages, Playwright, helpers or repository internals`,
  );
}

export function assertReactBrowserSource(source, file, { main = false } = {}) {
  const tree = parse(source, file);
  const rootLookups = [];
  const allowedRootNodes = new Set();
  walk(tree, (node) => {
    if (
      main &&
      ts.isCallExpression(node) &&
      propertyName(node.expression) === 'getElementById' &&
      (ts.isPropertyAccessExpression(node.expression) ||
        ts.isElementAccessExpression(node.expression)) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'document' &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      rootLookups.push(node);
      allowedRootNodes.add(node.expression.expression);
      if (ts.isPropertyAccessExpression(node.expression))
        allowedRootNodes.add(node.expression.name);
      else allowedRootNodes.add(node.expression);
    }
  });
  if (main)
    assert.equal(
      rootLookups.length,
      1,
      `${file}: main.tsx requires exactly one document.getElementById root lookup`,
    );
  walk(tree, (node) => {
    const name = ts.isIdentifier(node)
      ? node.text
      : ts.isElementAccessExpression(node)
        ? propertyName(node)
        : undefined;
    assert.ok(
      !name || !forbiddenDomName.test(name) || allowedRootNodes.has(node),
      `${file}: React DOM ownership forbids ${name}`,
    );
    if (ts.isArrayLiteralExpression(node) && node.elements.length > 0)
      assert.ok(
        !node.elements.every(isNumeric),
        `${file}: copied numeric byte collection must come from the canonical profile`,
      );
    if (
      ts.isCallExpression(node) &&
      propertyName(node.expression) === 'of' &&
      (ts.isPropertyAccessExpression(node.expression) ||
        ts.isElementAccessExpression(node.expression)) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Uint8Array' &&
      node.arguments.some(isNumeric)
    )
      assert.fail(
        `${file}: copied numeric byte collection must come from the canonical profile`,
      );
  });
  assert.doesNotMatch(
    source,
    uuidLiteral,
    `${file}: copied UUID must come from the canonical profile`,
  );
  return tree;
}

function objectProperty(node, name) {
  if (!node || !ts.isObjectLiteralExpression(node)) return undefined;
  return node.properties.find(
    (property) =>
      ts.isPropertyAssignment(property) && propertyName(property.name) === name,
  )?.initializer;
}

export function assertReactSharedProfile(source, file) {
  const tree = parse(source, file);
  const bindings = new Map();
  for (const statement of tree.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      normalize(statement.moduleSpecifier.text).replace(/\.js$/u, '.ts') !==
        '../../vanilla-ts/src/bluetooth-profile.ts'
    )
      continue;
    const names = statement.importClause?.namedBindings;
    assert.ok(
      names && ts.isNamedImports(names) && !statement.importClause.isTypeOnly,
      `${file}: canonical profile requires static named value imports`,
    );
    for (const element of names.elements) {
      assert.ok(
        !element.isTypeOnly,
        `${file}: profile binding must be a value`,
      );
      const imported = element.propertyName?.text ?? element.name.text;
      assert.ok(!bindings.has(imported), `${file}: duplicated profile import`);
      bindings.set(imported, element.name.text);
    }
  }
  assert.deepEqual(
    [...bindings.keys()].toSorted(),
    profileNames,
    `${file}: missing static canonical profile bindings`,
  );
  const importedNames = new Set(bindings.values());
  const isBinding = (node, name) =>
    node && ts.isIdentifier(node) && node.text === bindings.get(name);
  const calls = new Map();
  walk(tree, (node) => {
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    )
      assert.ok(
        !importedNames.has(node.name.text),
        `${file}: canonical profile binding cannot be shadowed`,
      );
    if (
      ts.isBinaryExpression(node) &&
      ts.isIdentifier(node.left) &&
      importedNames.has(node.left.text) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    )
      assert.fail(`${file}: canonical profile binding cannot be reassigned`);
    if (!ts.isCallExpression(node)) return;
    const method = propertyName(node.expression);
    if (!profileMethods.has(method)) return;
    calls.set(method, (calls.get(method) ?? 0) + 1);
    const argument = node.arguments[0];
    if (method === 'requestDevice') {
      const filters = objectProperty(argument, 'filters');
      const services =
        filters &&
        ts.isArrayLiteralExpression(filters) &&
        filters.elements.length === 1
          ? objectProperty(filters.elements[0], 'services')
          : undefined;
      assert.ok(
        services &&
          ts.isArrayLiteralExpression(services) &&
          services.elements.length === 1 &&
          isBinding(services.elements[0], 'serviceUuid'),
        `${file}: requestDevice must actually consume the canonical serviceUuid filter`,
      );
    } else if (
      method === 'getPrimaryService' ||
      method === 'getCharacteristic'
    ) {
      assert.ok(
        isBinding(
          argument,
          method === 'getPrimaryService'
            ? 'serviceUuid'
            : 'ioCharacteristicUuid',
        ),
        `${file}: ${method} must actually consume the canonical UUID binding`,
      );
    } else {
      assert.ok(
        argument &&
          ts.isNewExpression(argument) &&
          ts.isIdentifier(argument.expression) &&
          argument.expression.text === 'Uint8Array' &&
          argument.arguments?.length === 1 &&
          isBinding(argument.arguments[0], 'writePayload'),
        `${file}: writeValueWithResponse must actually consume the canonical writePayload`,
      );
    }
  });
  for (const method of profileMethods)
    assert.equal(
      calls.get(method),
      1,
      `${file}: live canonical profile call ${method} is missing or duplicated`,
    );
}

export async function collectReactSources(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      assert.ok(
        !entry.isSymbolicLink(),
        `${path}: React source cannot be a symlink`,
      );
      if (entry.isDirectory()) {
        if (directory !== root || !generatedDirectories.has(entry.name))
          await visit(path);
      } else if (
        sourceExtensions.has(extname(path)) &&
        relative(root, path) !== 'server.mjs'
      )
        files.push(path);
    }
  }
  await visit(root);
  return files;
}

export async function assertReactApplicationBoundary(root) {
  root = resolve(root);
  const files = await collectReactSources(root);
  for (const required of [
    'index.html',
    'vite.config.ts',
    'src/main.tsx',
    'src/App.tsx',
    'src/bluetooth-session.ts',
  ])
    assert.ok(
      files.includes(resolve(root, required)),
      `Missing handwritten React source ${required}`,
    );
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    assertReactSourceBoundary(source, file);
    const local = relative(root, file);
    if (local === 'vite.config.ts') continue;
    assert.doesNotMatch(
      source,
      uuidLiteral,
      `${file}: copied UUID must come from the canonical profile`,
    );
    if (scriptExtensions.has(extname(file))) {
      const tree = assertReactBrowserSource(source, file, {
        main: local === 'src/main.tsx',
      });
      if (local === 'src/bluetooth-session.ts')
        assertReactSharedProfile(source, file);
      else
        walk(tree, (node) => {
          if (ts.isCallExpression(node))
            assert.ok(
              !profileMethods.has(propertyName(node.expression)),
              `${file}: native profile calls belong to bluetooth-session.ts`,
            );
        });
    } else if (extname(file) === '.html') {
      assert.doesNotMatch(
        source,
        /\bon[a-z]+\s*=/iu,
        `${file}: inline DOM handlers cannot bypass React ownership`,
      );
      for (const script of source.matchAll(
        /<script\b[^>]*>([\s\S]*?)<\/script\s*>/giu,
      ))
        if (script[1].trim())
          assertReactBrowserSource(script[1], `${file}:inline script`);
    }
  }
}
