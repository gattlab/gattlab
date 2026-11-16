import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Build one browser bundle in an environment isolated from the parent. */
export async function buildReactBundle({
  repositoryRoot = process.cwd(),
  build = 'production',
  outputDirectory = resolve(repositoryRoot, 'examples/react/dist', build),
  modeOnly = false,
}) {
  if (build !== 'production' && build !== 'development') {
    throw new Error(`Unknown React build: ${build}`);
  }
  const environment = { ...process.env };
  if (modeOnly) delete environment.NODE_ENV;
  else environment.NODE_ENV = build;
  const source = `
    const { build } = await import('vite');
    await build({
      configFile: process.argv[1],
      mode: process.argv[2],
      build: { outDir: process.argv[3], emptyOutDir: true },
    });
  `;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      source,
      resolve(repositoryRoot, 'examples/react/vite.config.ts'),
      build,
      resolve(outputDirectory),
    ],
    { cwd: repositoryRoot, env: environment, stdio: 'inherit' },
  );
  await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveExit();
      else
        reject(new Error(`React ${build} build failed (${signal ?? code}).`));
    });
  });
  return resolve(outputDirectory);
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await buildReactBundle({ build: 'production' });
  await buildReactBundle({ build: 'development' });
}
