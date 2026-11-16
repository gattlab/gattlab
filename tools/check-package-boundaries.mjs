import { readdir, readFile } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import process from 'node:process';

import ts from 'typescript';
import { assertVanillaApplicationBoundary } from './check-vanilla-sample.mjs';
import { assertBlazorApplicationBoundary } from './check-blazor-sample.mjs';
import { assertReactApplicationBoundary } from './check-react-sample.mjs';

const defaultCoreSource = 'packages/core/src';
const coreTarget = resolve(process.cwd(), process.argv[2] ?? defaultCoreSource);
const rawProtocolTargets = process.argv[3]
  ? [
      {
        allowedTopLevelDirectories: new Set(['cdp']),
        path: resolve(process.cwd(), process.argv[3]),
      },
    ]
  : [
      {
        allowedTopLevelDirectories: new Set(['cdp']),
        path: resolve(process.cwd(), 'packages'),
      },
      {
        allowedTopLevelDirectories: new Set([
          'package-boundary-fixtures',
          'protocol-probe',
        ]),
        path: resolve(process.cwd(), 'tools'),
      },
    ];
const sourceExtensions = new Set([
  '.cjs',
  '.js',
  '.jsx',
  '.mjs',
  '.ts',
  '.tsx',
]);
const rawProtocolName = /\b(?:BluetoothEmulation|DeviceAccess)\.[A-Za-z]/u;

function classifyForbiddenImport(specifier) {
  if (
    specifier === 'playwright' ||
    specifier.startsWith('playwright/') ||
    specifier === 'playwright-core' ||
    specifier.startsWith('playwright-core/') ||
    specifier === '@playwright/test' ||
    specifier.startsWith('@playwright/test/') ||
    specifier === '@gattlab/playwright' ||
    specifier.startsWith('@gattlab/playwright/')
  ) {
    return 'Playwright';
  }

  if (
    specifier === 'devtools-protocol' ||
    specifier.startsWith('devtools-protocol/') ||
    specifier === '@gattlab/cdp' ||
    specifier.startsWith('@gattlab/cdp/')
  ) {
    return 'Chrome DevTools Protocol';
  }

  if (
    specifier === 'fs' ||
    specifier.startsWith('fs/') ||
    specifier === 'node:fs' ||
    specifier.startsWith('node:fs/')
  ) {
    return 'Node filesystem';
  }

  return undefined;
}

async function collectSourceFiles(path, extensions = sourceExtensions) {
  if (extensions.has(extname(path))) {
    return [path];
  }

  const entries = await readdir(path, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map((entry) => {
      const entryPath = resolve(path, entry.name);
      return entry.isDirectory()
        ? collectSourceFiles(entryPath, extensions)
        : [entryPath];
    }),
  );

  return nestedFiles.flat().filter((file) => extensions.has(extname(file)));
}

function moduleSpecifierFromNode(node) {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }

  if (
    ts.isImportTypeNode(node) &&
    ts.isLiteralTypeNode(node.argument) &&
    ts.isStringLiteralLike(node.argument.literal)
  ) {
    return node.argument.literal.text;
  }

  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) &&
        node.expression.text === 'require')) &&
    node.arguments[0] &&
    ts.isStringLiteralLike(node.arguments[0])
  ) {
    return node.arguments[0].text;
  }

  return undefined;
}

const violations = [];
for (const file of await collectSourceFiles(
  coreTarget,
  new Set(['.ts', '.tsx']),
)) {
  const sourceText = await readFile(file, 'utf8');
  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  function visit(node) {
    const specifier = moduleSpecifierFromNode(node);
    const boundary = specifier && classifyForbiddenImport(specifier);
    if (boundary) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      );
      violations.push(
        `${file}:${line + 1}:${character + 1}: core cannot import ${boundary} module "${specifier}"`,
      );
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

for (const { allowedTopLevelDirectories, path } of rawProtocolTargets) {
  for (const file of await collectSourceFiles(path)) {
    const [topLevelDirectory] = relative(path, file).split(sep);
    if (allowedTopLevelDirectories.has(topLevelDirectory)) {
      continue;
    }

    const sourceText = await readFile(file, 'utf8');
    const sourceFile = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
    );

    function visit(node) {
      if (ts.isStringLiteralLike(node) && rawProtocolName.test(node.text)) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        violations.push(
          `${file}:${line + 1}:${character + 1}: raw CDP protocol name "${node.text}" is only allowed in packages/cdp or tools/protocol-probe`,
        );
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }
}

try {
  await assertVanillaApplicationBoundary(
    resolve(process.cwd(), 'examples/vanilla-ts'),
  );
} catch (error) {
  violations.push(error.message);
}

try {
  await assertBlazorApplicationBoundary(
    resolve(process.cwd(), 'examples/blazor-wasm'),
  );
} catch (error) {
  violations.push(error.message);
}

try {
  await assertReactApplicationBoundary(
    resolve(process.cwd(), 'examples/react'),
  );
} catch (error) {
  violations.push(error.message);
}

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exit(1);
}

console.log(
  `Package boundaries OK (core: ${coreTarget}; raw protocol scan: ${rawProtocolTargets
    .map(({ path }) => path)
    .join(', ')})`,
);
