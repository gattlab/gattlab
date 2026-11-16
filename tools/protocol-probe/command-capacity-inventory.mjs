import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import ts from 'typescript';

// Inventory ordinary handwritten real-browser models, not negative unit fixtures.
const roots = [
  ['vanilla', 'tools/vanilla-app-fixtures'],
  ['blazor', 'tools/blazor-app-fixtures'],
  ['playwright', 'packages/playwright/e2e'],
  ['cdp', 'packages/cdp/test'],
];

export async function commandCapacityInventory(repositoryRoot) {
  const candidates = [];
  const files = [];
  const occurrences = new Map();
  for (const [family, directory] of roots) {
    for (const path of await sourceFiles(resolve(repositoryRoot, directory))) {
      if (family === 'cdp' && !path.endsWith('.chromium.test.ts')) continue;
      const source = await readFile(path, 'utf8');
      const file = relative(repositoryRoot, path);
      files.push({
        file,
        sha256: createHash('sha256').update(source).digest('hex'),
      });
      const tree = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node) => {
        if (
          ts.isPropertyAssignment(node) &&
          node.name.getText(tree) === 'services'
        ) {
          const value = unwrap(node.initializer);
          if (
            ts.isObjectLiteralExpression(node.parent) &&
            property(node.parent, 'address')
          ) {
            assert.ok(
              ts.isArrayLiteralExpression(value),
              'New dynamic peripheral services require an explicit inventory rule',
            );
          }
          if (
            ts.isArrayLiteralExpression(value) &&
            value.elements.length > 0 &&
            value.elements.every(
              (element) =>
                ts.isObjectLiteralExpression(unwrap(element)) &&
                property(unwrap(element), 'uuid'),
            )
          ) {
            const services = value.elements.map((element) =>
              shape(unwrap(element)),
            );
            const counts = {
              services: services.length,
              characteristics: services.reduce(
                (sum, service) => sum + service.characteristics.length,
                0,
              ),
              descriptors: services.reduce(
                (sum, service) =>
                  sum +
                  service.characteristics.reduce(
                    (n, characteristic) => n + characteristic.descriptors,
                    0,
                  ),
                0,
              ),
            };
            const ownerName = owner(node, tree);
            const key = `${file}:${ownerName}`;
            const occurrence = occurrences.get(key) ?? 0;
            occurrences.set(key, occurrence + 1);
            candidates.push({
              occurrence,

              family,
              file,
              line:
                tree.getLineAndCharacterOfPosition(node.getStart(tree)).line +
                1,
              owner: ownerName,
              counts,
              services,
            });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(tree);
    }
  }
  const selected = candidates.filter(
    (candidate) =>
      !candidates.some(
        (other) =>
          other.family === candidate.family &&
          Object.keys(candidate.counts).every(
            (key) => other.counts[key] >= candidate.counts[key],
          ) &&
          Object.keys(candidate.counts).some(
            (key) => other.counts[key] > candidate.counts[key],
          ),
      ),
  );
  for (const [family] of roots)
    assert.ok(
      selected.some((entry) => entry.family === family),
      `Missing ${family} model inventory`,
    );
  const profiles = selected.map((entry, index) => ({
    ...entry,
    id: `${entry.family}:${entry.file}:${entry.owner}:${entry.occurrence}`,
    definition: definition(entry, index),
  }));
  return { schemaVersion: 1, files, candidates, profiles };
}

function unwrap(node) {
  while (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node)
  )
    node = node.expression;
  return node;
}
function property(node, name) {
  return node.properties.find(
    (entry) =>
      ts.isPropertyAssignment(entry) &&
      (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) &&
      entry.name.text === name,
  );
}
function elements(node, name) {
  const entry = property(node, name);
  if (!entry) return [];
  const value = unwrap(entry.initializer);
  assert.ok(
    ts.isArrayLiteralExpression(value),
    `${name} model inventory requires explicit array; extend inventory for new source shape`,
  );
  return [...value.elements].map(unwrap);
}
function shape(service) {
  return {
    characteristics: elements(service, 'characteristics').map(
      (characteristic) => {
        assert.ok(
          ts.isObjectLiteralExpression(characteristic),
          'Inventory characteristic must be an object',
        );
        return {
          descriptors: elements(characteristic, 'descriptors').length,
          properties: elements(characteristic, 'properties').map((entry) => {
            assert.ok(
              ts.isStringLiteral(entry),
              'Inventory property must be a literal',
            );
            return entry.text;
          }),
        };
      },
    ),
  };
}
function owner(node, tree) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent) && parent.name)
      return parent.name.text;
    if (
      ts.isCallExpression(parent) &&
      /(?:test|it)\(/u.test(parent.getText(tree).slice(0, 12))
    ) {
      const title = parent.arguments[0];
      if (title && ts.isStringLiteral(title)) return title.text;
    }
  }
  return 'module model';
}
function definition(entry, index) {
  let attribute = 0;
  const uuid = () =>
    `f5090000-0000-4000-8000-${(++attribute).toString(16).padStart(12, '0')}`;
  return {
    address: `50:90:00:00:${Math.floor(index / 256)
      .toString(16)
      .padStart(2, '0')}:${(index % 256).toString(16).padStart(2, '0')}`,
    name: 'Command capacity sensor',
    advertisement: { rssi: -42 },
    services: entry.services.map((service) => ({
      uuid: uuid(),
      characteristics: service.characteristics.map((characteristic) => ({
        uuid: uuid(),
        properties: characteristic.properties,
        initialValue: [42],
        descriptors: Array.from(
          { length: characteristic.descriptors },
          (_, i) => ({
            uuid:
              (characteristic.properties.includes('notify') ||
                characteristic.properties.includes('indicate')) &&
              i === characteristic.descriptors - 1
                ? '00002902-0000-1000-8000-00805f9b34fb'
                : uuid(),
            initialValue: [0, 0],
          }),
        ),
      })),
    })),
  };
}
async function sourceFiles(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await sourceFiles(path)));
    else if (entry.isFile() && path.endsWith('.ts')) paths.push(path);
  }
  return paths.sort();
}
