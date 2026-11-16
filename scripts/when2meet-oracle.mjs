// The panel conversation must be idle before a live run counts as complete.
// This depends on extension/sidepanel.js mirroring the task lifecycle onto
// #transcript[aria-busy="true|false"]; a busy panel is never success.
export function panelSettled(busy) {
  return busy === 'false';
}

// The event name, both time bounds, timezone and URL must match the populated
// values captured before the task, and Monday/Wednesday must be the only days.
export function oracleOk(oracle, baseline, submissions) {
  const chosen = [...new Set(oracle.chosen ?? [])].sort();
  return oracle.mode === 'DaysOfTheWeek'
    && chosen.length === 2 && chosen[0] === '1' && chosen[1] === '3'
    && oracle.name === baseline.name
    && oracle.notBefore === baseline.notBefore
    && oracle.notAfter === baseline.notAfter
    && oracle.zone === baseline.zone
    && oracle.url === baseline.url
    && submissions.length === 0;
}

export function terminalSuccess(state, baseline, submissions) {
  return panelSettled(state.busy) && oracleOk(state.oracle, baseline, submissions);
}
