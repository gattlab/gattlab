import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { rendezvousDirectory } from './constants.js';

export async function markRendezvous(
  scope: string,
  marker: string,
): Promise<void> {
  const directory = join(rendezvousDirectory, scope);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, marker), `${marker}\n`, 'utf8');
}

export async function countRendezvous(
  scope: string,
  prefix: string,
): Promise<number> {
  try {
    const entries = await readdir(join(rendezvousDirectory, scope));
    return entries.filter((entry) => entry.startsWith(prefix)).length;
  } catch (cause) {
    if (isMissingPath(cause)) return 0;
    throw cause;
  }
}

export async function tryAcquireRendezvousLock(name: string): Promise<boolean> {
  await mkdir(rendezvousDirectory, { recursive: true });
  try {
    await mkdir(join(rendezvousDirectory, `${name}.lock`));
    return true;
  } catch (cause) {
    if (isExistingPath(cause)) return false;
    throw cause;
  }
}

export function releaseRendezvousLock(name: string): Promise<void> {
  return rm(join(rendezvousDirectory, `${name}.lock`), {
    force: true,
    recursive: true,
  });
}

function isMissingPath(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    (cause as { readonly code?: unknown }).code === 'ENOENT'
  );
}

function isExistingPath(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    (cause as { readonly code?: unknown }).code === 'EEXIST'
  );
}
