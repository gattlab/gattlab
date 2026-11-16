import { NAVIGATION_CASES } from './navigation-lifecycle-manifest.mjs';

// The installed boundary deliberately excludes other-page controlled chooser
// journeys and repair experiments; those remain the accepted protocol matrix.
export const PUBLIC_NAVIGATION_CASES = Object.freeze([
  ...NAVIGATION_CASES.filter(
    (row) =>
      row.repair === 'none' &&
      !(
        ['same-context', 'other-context'].includes(row.subject) &&
        ['U2', 'U3', 'U4'].includes(row.level)
      ),
  ).map((row) =>
    Object.freeze({
      ...row,
      id: `public:${row.id}`,
      expectedCleanupFailure:
        row.subject === 'fixture' && row.action === 'close',
      testIds:
        row.group === 'N10'
          ? [`public:${row.id}:dispose`, `public:${row.id}:sequential-owner`]
          : [`public:${row.id}`],
    }),
  ),
  {
    id: 'public:short-assertion:maximum-models',
    group: 'short-assertion',
    level: 'U0',
    action: 'model-only',
    subject: 'fixture',
    testIds: ['public:short-assertion:maximum-models'],
  },
  ...['absent', 'powered-off', 'powered-on'].map((state) =>
    Object.freeze({
      id: `public:state:${state}:fences`,
      group: 'state',
      level: 'U0',
      action: 'fences',
      subject: 'fixture',
      state,
      testIds: [`public:state:${state}:fences`],
    }),
  ),
]);
