import {assertBridge} from './errors.mjs';

export const DIRECT_RUN_PROGRESS_VERSION=1;
const PHASES=new Set(['PREPARING','EXECUTING','RETURNING_RESULT']);

// Host monotonic duration is evidence, never a host-provided wall-clock
// timestamp. The authenticated control plane assigns the observation times.
export function validateDirectRunProgress(value) {
  assertBridge(value && typeof value==='object' && !Array.isArray(value),
    'DIRECT_RUN_PROGRESS_INVALID','Direct Run progress must be an object');
  assertBridge(Object.keys(value).every(key=>key==='phase' || key==='executionElapsedMs'),
    'DIRECT_RUN_PROGRESS_INVALID','Direct Run progress contains an unknown field');
  assertBridge(PHASES.has(value.phase) && Number.isSafeInteger(value.executionElapsedMs) &&
    value.executionElapsedMs>=0 && value.executionElapsedMs<=3_700_000 &&
    (value.phase!=='PREPARING' || value.executionElapsedMs===0),
  'DIRECT_RUN_PROGRESS_INVALID','Direct Run phase or execution elapsed time is invalid');
  return {phase:value.phase,executionElapsedMs:value.executionElapsedMs};
}

export function directRunProgressFromRow(row) {
  if(row?.progress_phase===null || row?.progress_phase===undefined) return undefined;
  return {
    ...validateDirectRunProgress({phase:row.progress_phase,executionElapsedMs:Number(row.execution_elapsed_ms)}),
    reportedAt:Number(row.progress_reported_at),
    phaseStartedAt:Number(row.phase_started_at)
  };
}
