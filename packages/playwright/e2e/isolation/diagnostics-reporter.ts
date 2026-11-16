import { readFileSync } from 'node:fs';

import type {
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';

class ConflictDiagnosticsReporter implements Reporter {
  #conflictTestRan = false;
  #conflictAttachmentFound = false;

  onTestEnd(test: TestCase, result: TestResult): void {
    if (test.parent.project()?.name !== 'shared-browser-conflict') return;
    if (!test.title.includes('reports the shared process conflict')) return;
    this.#conflictTestRan = true;

    for (const attachment of result.attachments) {
      if (attachment.name !== 'gattlab-diagnostics.json') continue;
      const contents =
        attachment.body?.toString('utf8') ??
        (attachment.path === undefined
          ? ''
          : readFileSync(attachment.path, 'utf8'));
      if (
        contents.includes('BLUETOOTH_LAB_ALREADY_ACTIVE') &&
        contents.includes('cdp-domain-conflict')
      ) {
        this.#conflictAttachmentFound = true;
      }
    }
  }

  onEnd(
    result: FullResult,
  ): Promise<{ status?: FullResult['status'] } | undefined> {
    if (!this.#conflictTestRan || this.#conflictAttachmentFound) {
      return Promise.resolve(undefined);
    }
    process.stderr.write(
      'Isolation expected a gattlab-diagnostics attachment containing the shared-browser domain conflict.\n',
    );
    return Promise.resolve({
      status: result.status === 'interrupted' ? 'interrupted' : 'failed',
    });
  }
}

export default ConflictDiagnosticsReporter;
