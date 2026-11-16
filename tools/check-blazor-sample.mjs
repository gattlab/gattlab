import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';
import ts from 'typescript';

const applicationExtensions = new Set([
  '.cs',
  '.razor',
  '.csproj',
  '.html',
  '.js',
  '.mjs',
  '.ts',
]);
const generatedDirectories = new Set(['bin', 'obj', 'dist', 'node_modules']);
const uuidLiteral =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;
const forbiddenDomName =
  /^(?:document|querySelector\w*|getElementById|textContent|innerHTML|innerText|outerHTML|insertAdjacent\w*|append|appendChild|replaceChildren|setAttribute|nodeValue|replaceWith|before|after|prepend)$/u;

export async function collectBlazorSources(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(
          `${path}: handwritten Blazor source cannot be a symlink`,
        );
      if (entry.isDirectory()) {
        // Only project-root build output is generated; wwwroot/dist helpers
        // are handwritten browser code and must remain in the ownership scan.
        if (directory !== root || !generatedDirectories.has(entry.name))
          await visit(path);
      } else if (
        applicationExtensions.has(extname(path)) &&
        relative(root, path) !== 'server.mjs'
      ) {
        files.push(path);
      }
    }
  }
  await visit(root);
  return files;
}

export function assertBlazorSourceBoundary(source, file) {
  assert.doesNotMatch(
    source,
    /@gattlab|playwright|(?:packages|tools)\/|test[-/]helpers|BluetoothEmulation|DeviceAccess|GattLab\.(?!BlazorSample\b)[\w.]+/iu,
    `${file}: Blazor application cannot reference GattLab testing packages, Playwright, helpers, internals, or testing assemblies`,
  );
  assert.doesNotMatch(
    source,
    /\bElementReference\b/u,
    `${file}: ElementReference cannot pass Razor DOM ownership into JavaScript`,
  );
}

function parse(source, file) {
  const tree = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  assert.equal(
    tree.parseDiagnostics.length,
    0,
    `${file}: invalid handwritten JavaScript`,
  );
  return tree;
}

function walk(node, visitor) {
  visitor(node);
  ts.forEachChild(node, (child) => walk(child, visitor));
}

export function assertBlazorJavaScript(source, file, { profile = false } = {}) {
  const tree = parse(source, file);
  if (profile) {
    function isData(node) {
      if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node))
        return true;
      if (ts.isArrayLiteralExpression(node)) return node.elements.every(isData);
      return (
        ts.isCallExpression(node) &&
        node.expression.getText(tree) === 'Object.freeze' &&
        node.arguments.length === 1 &&
        ts.isArrayLiteralExpression(node.arguments[0]) &&
        isData(node.arguments[0])
      );
    }
    for (const statement of tree.statements) {
      assert.ok(
        ts.isVariableStatement(statement) &&
          statement.modifiers?.some(
            (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
          ) &&
          (statement.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
          statement.declarationList.declarations.every(
            (declaration) =>
              ts.isIdentifier(declaration.name) &&
              declaration.initializer &&
              isData(declaration.initializer),
          ),
        `${file}: shared profile must contain only exported constant data`,
      );
    }
  }
  walk(tree, (node) => {
    const name = ts.isIdentifier(node)
      ? node.text
      : ts.isElementAccessExpression(node) &&
          ts.isStringLiteralLike(node.argumentExpression)
        ? node.argumentExpression.text
        : undefined;
    assert.ok(
      !name || !forbiddenDomName.test(name),
      `${file}: Razor DOM ownership forbids ${name}`,
    );
    // Dynamic code would evade the syntactic DOM/profile ownership checks.
    if (ts.isIdentifier(node))
      assert.ok(
        !['eval', 'Function', 'Reflect'].includes(node.text),
        `${file}: dynamic JavaScript is outside the sample contract`,
      );
    if (
      !profile &&
      ts.isArrayLiteralExpression(node) &&
      node.elements.length > 0
    ) {
      assert.ok(
        !node.elements.every((element) => ts.isNumericLiteral(element)),
        `${file}: copied numeric byte collection must live in bluetooth-profile.js`,
      );
    }
    if (
      !profile &&
      ts.isCallExpression(node) &&
      node.expression.getText(tree) === 'Uint8Array.of' &&
      node.arguments.some((argument) => ts.isNumericLiteral(argument))
    ) {
      assert.fail(
        `${file}: copied numeric byte collection must live in bluetooth-profile.js`,
      );
    }
  });
  if (!profile)
    assert.doesNotMatch(
      source,
      uuidLiteral,
      `${file}: copied UUID must live in bluetooth-profile.js`,
    );
}

export function assertBlazorSharedProfile(source, file) {
  const tree = parse(source, file);
  const bindings = new Map();
  for (const statement of tree.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      statement.moduleSpecifier.text !== './bluetooth-profile.js'
    )
      continue;
    const names = statement.importClause?.namedBindings;
    assert.ok(
      names && ts.isNamedImports(names),
      `${file}: profile must use static named imports`,
    );
    for (const element of names.elements)
      bindings.set(
        element.propertyName?.text ?? element.name.text,
        element.name.text,
      );
  }
  for (const name of [
    'serviceUuid',
    'ioCharacteristicUuid',
    'notificationCharacteristicUuid',
    'writePayload',
  ]) {
    assert.equal(
      bindings.get(name),
      name,
      `${file}: missing static shared profile binding ${name}`,
    );
  }
  const calls = new Map();
  const isBinding = (node, name) =>
    node && ts.isIdentifier(node) && node.text === bindings.get(name);
  walk(tree, (node) => {
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isFunctionDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      assert.ok(
        ![...bindings.values()].includes(node.name.text),
        `${file}: profile binding cannot be shadowed`,
      );
    }
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression)
    )
      return;
    const method = node.expression.name.text;
    if (
      ![
        'requestDevice',
        'getPrimaryService',
        'getCharacteristic',
        'writeValueWithResponse',
        'startNotifications',
        'stopNotifications',
      ].includes(method)
    )
      return;
    calls.set(method, (calls.get(method) ?? 0) + 1);
    if (method === 'getCharacteristic') {
      const target = [
        'ioCharacteristicUuid',
        'notificationCharacteristicUuid',
      ].find((name) => isBinding(node.arguments[0], name));
      assert.ok(
        target,
        `${file}: getCharacteristic must actually consume a shared characteristic UUID binding`,
      );
      calls.set(target, (calls.get(target) ?? 0) + 1);
      return;
    }
    if (method === 'startNotifications' || method === 'stopNotifications')
      return;
    const argument = node.arguments[0];
    if (method === 'requestDevice') {
      let sharedFilter = false;
      if (argument)
        walk(argument, (child) => {
          if (
            ts.isPropertyAssignment(child) &&
            child.name.getText(tree) === 'services' &&
            ts.isArrayLiteralExpression(child.initializer)
          ) {
            sharedFilter =
              child.initializer.elements.length === 1 &&
              isBinding(child.initializer.elements[0], 'serviceUuid');
          }
        });
      assert.ok(
        sharedFilter,
        `${file}: requestDevice must actually consume the shared serviceUuid filter`,
      );
    } else if (method === 'getPrimaryService') {
      assert.ok(
        isBinding(argument, 'serviceUuid'),
        `${file}: ${method} must actually consume the shared UUID binding`,
      );
    } else {
      assert.ok(
        argument &&
          ts.isNewExpression(argument) &&
          argument.expression.getText(tree) === 'Uint8Array' &&
          isBinding(argument.arguments?.[0], 'writePayload'),
        `${file}: writeValueWithResponse must actually consume the shared writePayload`,
      );
    }
  });
  for (const [method, count] of [
    ['requestDevice', 1],
    ['getPrimaryService', 1],
    ['getCharacteristic', 2],
    ['ioCharacteristicUuid', 1],
    ['notificationCharacteristicUuid', 1],
    ['writeValueWithResponse', 1],
    ['startNotifications', 1],
    ['stopNotifications', 1],
  ]) {
    assert.equal(
      calls.get(method),
      count,
      `${file}: live shared profile call ${method} is missing or duplicated`,
    );
  }
}

export function assertBlazorSessionModule(source, file) {
  const tree = parse(source, file);
  for (const statement of tree.statements) {
    assert.ok(
      ts.isImportDeclaration(statement) || ts.isFunctionDeclaration(statement),
      `${file}: session module holds no module-level state; state belongs to createSession`,
    );
  }
  let listeners = 0;
  let listen;
  walk(tree, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'listen')
      listen = node;
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.name.text !== 'addEventListener'
    )
      return;
    listeners += 1;
    let owner = node.parent;
    while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
    assert.equal(
      owner?.name?.text,
      'listen',
      `${file}: raw addEventListener outside the diagnostics helper listen()`,
    );
  });
  assert.equal(
    listeners,
    1,
    `${file}: native listeners register only through listen()`,
  );
  assertReportsBeforeGuard(listen, tree, file);
}

// The diagnostics helper has exactly one accepted shape (comments and
// formatting aside): an unconditional report with inert arguments, then the
// disposed guard. Enumerating forbidden syntax left bypasses; an
// intentional change to listen() updates this canonical source with review.
// Threat model: this syntactic guard stops accidental drift of the sample.
// Deliberately obfuscated application code (aliases through `this`, getters,
// prototype or cross-realm patching) is out of scope; no static JavaScript
// check can be complete against it.
const canonicalListen = `function listen(target, type, handler) {
  const observed = (event) => {
    diagnosticsReceiver
      .invokeMethodAsync('OnNativeEvent', sessionId, type)
      .catch((error) => console.error('Bluetooth diagnostics failed', error));
    if (!disposed) handler(event);
  };
  target.addEventListener(type, observed);
  listeners.push({ target, type, observed });
}`;
const printer = ts.createPrinter({ removeComments: true });

function printed(node, tree) {
  return printer.printNode(ts.EmitHint.Unspecified, node, tree);
}

function assertReportsBeforeGuard(listen, tree, file) {
  const failure = `${file}: listen() must report native events to the diagnostics receiver before any disposed guard`;
  const canonical = parse(canonicalListen, 'canonical-listen.js');
  assert.equal(
    printed(listen, tree),
    printed(canonical.statements[0], canonical),
    failure,
  );
  const session = listen.parent?.parent;
  assert.ok(
    session &&
      ts.isFunctionDeclaration(session) &&
      session.name?.text === 'createSession' &&
      listen.parent.parent === session,
    `${file}: listen() must be declared directly inside createSession()`,
  );
  assert.deepEqual(
    session.parameters.map((parameter) =>
      ts.isIdentifier(parameter.name) &&
      !parameter.initializer &&
      !parameter.dotDotDotToken
        ? parameter.name.text
        : undefined,
    ),
    ['sessionId', 'panelReceiver', 'diagnosticsReceiver'],
    `${file}: createSession(sessionId, panelReceiver, diagnosticsReceiver) takes plain parameters`,
  );
  // The report's receiver and id can only be the createSession parameters:
  // no other declaration, assignment, or use can replace or patch them.
  const declared = new Map();
  let receiverUses = 0;
  walk(session, (node) => {
    // `arguments` would alias the parameters without naming them.
    if (ts.isIdentifier(node) && node.text === 'arguments')
      assert.fail(`${file}: arguments cannot alias createSession parameters`);
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    )
      declared.set(node.name.text, (declared.get(node.name.text) ?? 0) + 1);
  });
  walk(tree, (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      /^(?:sessionId|diagnosticsReceiver)\b/u.test(node.left.getText(tree))
    )
      assert.fail(`${file}: ${node.left.getText(tree)} cannot be reassigned`);
    if (
      ts.isIdentifier(node) &&
      node.text === 'diagnosticsReceiver' &&
      !ts.isParameter(node.parent)
    )
      receiverUses += 1;
  });
  for (const name of ['sessionId', 'diagnosticsReceiver', 'listen'])
    assert.equal(
      declared.get(name),
      1,
      `${file}: ${name} cannot be shadowed or redeclared`,
    );
  assert.equal(
    receiverUses,
    1,
    `${file}: diagnosticsReceiver is used only by the listen() report`,
  );
}

export function assertBlazorInteropImports(source, file, { service }) {
  const calls = [
    ...source.matchAll(/InvokeAsync<IJSObjectReference>\(\s*"([^"]*)"/gu),
  ].map((match) => match[1]);
  const all = [...source.matchAll(/InvokeAsync<IJSObjectReference>/gu)];
  assert.equal(
    all.length,
    calls.length,
    `${file}: shadow interop modules are outside this sample contract`,
  );
  if (!service) {
    assert.deepEqual(
      calls,
      [],
      `${file}: shadow interop modules are outside this sample contract`,
    );
    return;
  }
  assert.match(
    source,
    /InvokeAsync<IJSObjectReference>\("import",\s*"\.\/bluetooth\.js"\)/u,
    `${file}: C# must import the checked local interop module`,
  );
  assert.deepEqual(
    calls.toSorted(),
    ['createSession', 'import'],
    `${file}: shadow interop modules are outside this sample contract`,
  );
}

export async function assertBlazorApplicationBoundary(root) {
  const files = await collectBlazorSources(root);
  for (const required of [
    'Program.cs',
    'App.razor',
    'BluetoothPanel.razor',
    'Services/BluetoothService.cs',
    'Services/BluetoothSession.cs',
    'Services/LifecycleLog.cs',
    'wwwroot/index.html',
    'wwwroot/bluetooth.js',
    'wwwroot/bluetooth-profile.js',
  ]) {
    assert.ok(
      files.includes(resolve(root, required)),
      `Missing handwritten Blazor source ${required}`,
    );
  }
  let checkedInterop = false;
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    assertBlazorSourceBoundary(source, file);
    const local = relative(root, file);
    if (['.js', '.mjs', '.ts'].includes(extname(file))) {
      assertBlazorJavaScript(source, file, {
        profile: local === 'wwwroot/bluetooth-profile.js',
      });
    } else {
      if (['.html', '.razor'].includes(extname(file))) {
        assert.doesNotMatch(
          source,
          /(?<!@)\bon[a-z]+\s*=/iu,
          `${file}: inline DOM handlers cannot bypass Razor ownership`,
        );
      }
      assert.doesNotMatch(
        source,
        uuidLiteral,
        `${file}: copied UUID cannot bypass the shared JS profile through C#/Razor/HTML`,
      );
      assert.doesNotMatch(
        source,
        /(?:new\s+(?:(?:byte|int)\s*)?\[\s*\]\s*\{\s*\d|(?:=|return)\s*\[\s*\d|(?:byte|int)\[\]\s+\w+\s*=\s*\{\s*\d)/u,
        `${file}: copied numeric byte collection cannot bypass the shared profile`,
      );
      for (const script of source.matchAll(
        /<script\b[^>]*>([\s\S]*?)<\/script\s*>/giu,
      )) {
        if (script[1].trim())
          assertBlazorJavaScript(script[1], `${file}:inline script`);
      }
    }
    if (local === 'wwwroot/bluetooth.js') {
      assertBlazorSharedProfile(source, file);
      assertBlazorSessionModule(source, file);
      checkedInterop = true;
    }
    if (['.cs', '.razor'].includes(extname(file)))
      assertBlazorInteropImports(source, file, {
        service: local === 'Services/BluetoothService.cs',
      });
  }
  assert.ok(checkedInterop, 'The checked local interop module is required');
}
