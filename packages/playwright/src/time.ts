import { performance as nodePerformance } from 'node:perf_hooks';
import {
  clearTimeout as cancelTimeout,
  setTimeout as scheduleTimeout,
} from 'node:timers';

import type { MonotonicClock } from '@gattlab/core';
import type { CdpBackendDeadlineScheduler } from '@gattlab/cdp';

/** Adapts Node's monotonic performance clock to the core clock contract. */
export function createPlaywrightMonotonicClock(): MonotonicClock {
  return Object.freeze({
    now(): number {
      return nodePerformance.now();
    },
  });
}

/** Adapts Node timers to cancellable backend deadlines. */
export function createPlaywrightDeadlineScheduler(): CdpBackendDeadlineScheduler {
  return Object.freeze({
    schedule(deadlineMs: number, onDeadline: () => void) {
      let active = true;
      const timeout = scheduleTimeout(() => {
        active = false;
        onDeadline();
      }, deadlineMs);
      return Object.freeze({
        cancel(): void {
          if (!active) return;
          active = false;
          cancelTimeout(timeout);
        },
      });
    },
  });
}
