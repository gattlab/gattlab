import assert from 'node:assert/strict';
import test from 'node:test';

import { brokenMarkdownLinks, markdownAnchors } from './check-doc-links.mjs';

const guide = '# Guide\n\n## 1. Write the test\n\n## Limits\n\n## Limits\n';

test('accepts existing files, directory READMEs, anchors and external links', () => {
  const files = new Map([
    ['docs/guide.md', guide],
    ['packages/core/README.md', '# Core\n'],
    [
      'README.md',
      '[Guide](docs/guide.md#1-write-the-test) [Again](docs/guide.md#limits-1) ' +
        '[Core](packages/core) [Site](https://example.com/x#y) [Top](#readme)\n' +
        '<a id="readme"></a>\n',
    ],
  ]);
  assert.deepEqual(brokenMarkdownLinks(files), []);
});

test('reports a missing target and a missing anchor', () => {
  const files = new Map([
    ['docs/guide.md', guide],
    [
      'README.md',
      '[Gone](docs/missing.md) [Stale](docs/guide.md#old-heading)\n',
    ],
  ]);
  assert.deepEqual(brokenMarkdownLinks(files), [
    'README.md: missing link target docs/missing.md',
    'README.md: missing anchor docs/guide.md#old-heading',
  ]);
});

test('checks links to the main branch of this repository', () => {
  const base = 'https://github.com/gattlab/gattlab';
  const files = new Map([
    ['docs/guide.md', guide],
    ['packages/core/README.md', '# Core\n'],
    [
      'packages/cdp/README.md',
      `# CDP\n\n[Guide](${base}/blob/main/docs/guide.md#limits) ` +
        `[Core](${base}/tree/main/packages/core) ` +
        `[Gone](${base}/blob/main/docs/missing.md) ` +
        `[Stale](${base}/blob/main/docs/guide.md#old-heading) ` +
        `[Tag](${base}/blob/v1/docs/missing.md) [Top](#cdp)\n`,
    ],
  ]);
  assert.deepEqual(brokenMarkdownLinks(files), [
    `packages/cdp/README.md: missing link target ${base}/blob/main/docs/missing.md`,
    `packages/cdp/README.md: missing anchor ${base}/blob/main/docs/guide.md#old-heading`,
  ]);
});

test('rejects relative file links in package READMEs published to npm', () => {
  const files = new Map([
    ['docs/guide.md', guide],
    ['packages/core/README.md', '# Core\n\n[Guide](../../docs/guide.md)\n'],
    ['examples/app/README.md', '[Guide](../../docs/guide.md)\n'],
  ]);
  assert.deepEqual(brokenMarkdownLinks(files), [
    'packages/core/README.md: relative link ../../docs/guide.md breaks on npm; use a https://github.com/gattlab/gattlab/blob/main/ URL',
  ]);
});

test('derives GitHub-style anchors', () => {
  assert.deepEqual(
    [...markdownAnchors('# `Code` and *emphasis*\n## Step 2: run it\n')],
    ['code-and-emphasis', 'step-2-run-it'],
  );
});
