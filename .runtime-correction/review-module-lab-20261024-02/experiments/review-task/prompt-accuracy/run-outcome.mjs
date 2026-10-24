// A valid UNVERIFIED submission is complete; an interrupted review is not.
export function reviewRunExitCode({ protectedInputs, live, rows }) {
  return !protectedInputs || rows.some(row => row.error || (live && !row.result?.completed)) ? 1 : 0;
}
