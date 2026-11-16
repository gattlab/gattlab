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

test('derives GitHub-style anchors', () => {
  assert.deepEqual(
    [...markdownAnchors('# `Code` and *emphasis*\n## Step 2: run it\n')],
    ['code-and-emphasis', 'step-2-run-it'],
  );
});
