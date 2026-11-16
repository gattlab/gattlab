import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Returns the GitHub-style heading anchors and explicit HTML ids of a file. */
export function markdownAnchors(text) {
  const anchors = new Set();
  const counts = new Map();
  for (const match of text.matchAll(/^#{1,6}\s+(.+)$/gmu)) {
    const base = match[1]
      .toLowerCase()
      .replace(/[`*_~]/gu, '')
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .trim()
      .replace(/\s/gu, '-');
    const count = counts.get(base) ?? 0;
    anchors.add(count === 0 ? base : `${base}-${count}`);
    counts.set(base, count + 1);
  }
  for (const match of text.matchAll(
    /<(?:a|h[1-6])\b[^>]*\b(?:id|name)=["']([^"']+)["']/giu,
  ))
    anchors.add(match[1]);
  return anchors;
}

// Links to this repository's main branch are checked like relative links.
const repositoryLink =
  /^https:\/\/github\.com\/gattlab\/gattlab\/(?:blob|tree)\/main\/([^#]*)(?:#(.*))?$/u;
// Package READMEs are rendered on npm, where relative file links break.
const publishedReadme = /^packages\/[^/]+\/README\.md$/u;

/**
 * Lists broken relative links, and broken links to this repository's main
 * branch, in Markdown files. `files` maps repository paths to their text;
 * other external URLs are not checked.
 */
export function brokenMarkdownLinks(files) {
  const problems = [];
  for (const [path, text] of files) {
    if (!path.endsWith('.md')) continue;
    for (const match of text.matchAll(
      /!?\[[^\]\n]*\]\(([^\s)]+)(?:\s+"[^"\n]*")?\)/gu,
    )) {
      const href = match[1];
      const repository = repositoryLink.exec(href);
      if (
        !repository &&
        (/^[a-z][a-z0-9+.-]*:/iu.test(href) || href.startsWith('//'))
      )
        continue;
      const [rawTarget, rawAnchor] = repository
        ? [repository[1], repository[2]]
        : href.split('#');
      if (!repository && rawTarget && publishedReadme.test(path)) {
        problems.push(
          `${path}: relative link ${href} breaks on npm; use a https://github.com/gattlab/gattlab/blob/main/ URL`,
        );
        continue;
      }
      const target = rawTarget
        ? posix.normalize(
            posix.join(
              repository ? '' : posix.dirname(path),
              decodeURIComponent(rawTarget).split('?')[0],
            ),
          )
        : path;
      const resolved = [
        target,
        posix.join(target, 'README.md'),
        posix.join(target, 'index.md'),
      ].find((candidate) => files.has(candidate));
      if (resolved === undefined) {
        problems.push(`${path}: missing link target ${href}`);
      } else if (
        rawAnchor &&
        resolved.endsWith('.md') &&
        !markdownAnchors(files.get(resolved)).has(decodeURIComponent(rawAnchor))
      ) {
        problems.push(`${path}: missing anchor ${href}`);
      }
    }
  }
  return problems;
}

function trackedFiles(root) {
  const paths = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
  return new Map(
    paths.map((path) => [
      path,
      path.endsWith('.md') ? readFileSync(resolve(root, path), 'utf8') : '',
    ]),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const problems = brokenMarkdownLinks(trackedFiles(process.cwd()));
  assert.deepEqual(
    problems,
    [],
    `Broken Markdown links:\n${problems.join('\n')}`,
  );
  console.log('Markdown links and anchors resolve.');
}
