import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function assertVanillaApplicationBoundary(applicationRoot) {
  const files = [resolve(applicationRoot, 'index.html')];
  async function collect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await collect(path);
      else files.push(path);
    }
  }
  await collect(resolve(applicationRoot, 'src'));
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (/@gattlab|playwright|tools\//u.test(source)) {
      throw new Error(
        `${file}: sample application cannot reference GattLab, Playwright, or tools/`,
      );
    }
  }
}
