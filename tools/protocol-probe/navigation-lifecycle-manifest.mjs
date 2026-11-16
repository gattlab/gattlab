// Each entry owns a fresh Chromium process. N10 alone transfers sequential
// protocol ownership inside that process; these are not production lab tests.
const cases = [];
function add(group, level, action, subject = 'fixture', extra = {}) {
  const suffix = extra.repair ? `-${extra.repair}` : '';
  const retention = extra.retainedFixture ? '-fixture-U1-retained' : '';
  cases.push(
    Object.freeze({
      id: `${group}-${subject}-${level}-${action}${suffix}${retention}`,
      group,
      level,
      action,
      subject,
      repair: 'none',
      ...extra,
    }),
  );
}
add('N1', 'U0', 'lazy-goto');
for (const action of ['goto', 'reload']) add('N1', 'U0', action);
for (const level of ['U1', 'U2', 'U3', 'U4']) {
  add('N2', level, 'goto');
  add('N3', level, 'reload');
}
for (const action of ['goto', 'reload']) add('N4', 'U4', action);
add('N5', 'U4', 'scripted-disconnect');
for (const action of ['native-disconnect', 'goto', 'reload'])
  add('N5', 'U4', action);
for (const level of ['U1', 'U4']) {
  for (const action of ['hash', 'history']) add('N6', level, action);
}
for (const level of ['U0', 'U1', 'U4']) add('N6', level, 'replace', 'child');
for (const level of ['U1', 'U4']) {
  for (const action of ['other-origin', 'blank', 'close'])
    add('N7', level, action);
}
for (const subject of ['same-context', 'other-context']) {
  for (const level of ['U0', 'U1', 'U2', 'U3', 'U4', 'pending-request']) {
    for (const action of ['goto', 'close']) add('N7', level, action, subject);
  }
  for (const action of ['goto', 'close']) {
    add('N7', 'U1', action, subject, { retainedFixture: true });
  }
}
for (const level of ['pending-chooser', 'pending-read']) {
  for (const action of ['goto', 'close']) add('N8', level, action);
}
for (const level of ['U1', 'U4']) {
  add('N9', level, 'goto');
  add('N9', level, 'close', 'same-context');
}
add('N10', 'U1', 'goto');
add('N10', 'U1', 'close', 'same-context');
for (const repair of ['enable-only', 'reset-only', 'reset-rebuild']) {
  add('N2', 'U1', 'goto', 'fixture', { repair });
  add('N3', 'U4', 'reload', 'fixture', { repair });
}

export const NAVIGATION_CASES = Object.freeze(cases);
export const NAVIGATION_SUITE_NAMES = Object.freeze([
  'full',
  'other-page-smoke',
]);
export function navigationCases(suite = 'full') {
  if (!NAVIGATION_SUITE_NAMES.includes(suite))
    throw new Error(`Unknown navigation suite: ${suite}`);
  if (suite === 'full') return NAVIGATION_CASES;
  // Four pending variants plus corresponding U0 controls. Diagnostic only.
  return NAVIGATION_CASES.filter(
    (item) =>
      item.group === 'N7' &&
      ['same-context', 'other-context'].includes(item.subject) &&
      ['U0', 'pending-request'].includes(item.level),
  );
}
