import type { Accesses } from "./types.ts";
import { conflicts } from "./path_util.ts";

const ABORT_GRACE_MS = 2000;

export interface ScheduledJob<R> {
  /** Stable index — used to return results in the original order. */
  index: number;
  /** Human-readable id (callId) used in log lines. */
  id: string;
  /** Resource footprint, post-prepare. */
  accesses: Accesses;
  /** Async work; may throw or reject. */
  run(): Promise<R>;
}

export interface SchedulerOptions {
  /** AbortSignal to cancel all in-flight jobs. */
  signal: AbortSignal;
  /** Max jobs in parallel. Default 8. */
  concurrency?: number;
  /**
   * Grace period after `signal.abort` before synthesising an error result
   * for tools that ignored cancellation (kimi-style).
   */
  abortGraceMs?: number;
}

/**
 * Run a batch of jobs honouring resource conflicts and returning results
 * in the original order.
 *
 * Conflict model: any overlap between writes of one job and reads/writes of
 * another → sequential. Reads-only jobs against disjoint files run in
 * parallel. Network/process jobs conflict with everything (single-flight).
 *
 * The wait between waves uses per-job completion Promises, never a microtask
 * busy-loop, so macrotask-driven work (timers, I/O, the abort grace clock)
 * progresses normally.
 */
export async function schedule<R>(
  jobs: ReadonlyArray<ScheduledJob<R>>,
  opts: SchedulerOptions,
): Promise<R[]> {
  if (jobs.length === 0) return [];

  const concurrency = Math.max(1, opts.concurrency ?? 8);
  const grace = opts.abortGraceMs ?? ABORT_GRACE_MS;
  const results: R[] = new Array(jobs.length);
  const started = new Set<number>();
  const completed = new Set<number>();
  const inflight = new Set<number>();

  // Job index → indices of earlier jobs that block it. A job becomes
  // runnable once every blocker has completed.
  const blockers: number[][] = jobs.map((job, i) =>
    jobs.slice(0, i).flatMap((earlier, j) =>
      overlap(earlier.accesses, job.accesses) ? [j] : []
    )
  );

  // One resolver per job, resolved when the job's result lands. Waiting on
  // these lets the runtime drain the macrotask queue between waves instead
  // of starving it.
  const completionResolvers: Array<(() => void) | undefined> = new Array(
    jobs.length,
  ).fill(undefined);
  const completions: Array<Promise<void>> = jobs.map((_, i) =>
    new Promise<void>((resolve) => {
      completionResolvers[i] = resolve;
    })
  );

  const ready = (i: number): boolean =>
    !started.has(i) && blockers[i].every((b) => completed.has(b));

  const tryStart = (): void => {
    if (opts.signal.aborted) {
      // Once aborted, we stop launching new jobs; in-flight ones are
      // drained by runJob's grace timer.
      return;
    }
    for (let i = 0; i < jobs.length && inflight.size < concurrency; i++) {
      if (!ready(i)) continue;
      started.add(i);
      inflight.add(i);
      // .catch converts a rejecting runJob into a synthesised error result so
      // the queue's side-effects (completed/inflight/resolver/tryStart) still
      // fire. Without it a single throw strands every blocker downstream.
      runJob(jobs[i], grace, opts.signal).catch((e): R => ({
        content: `[error] ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      } as R)).then((r) => {
        results[i] = r;
        completed.add(i);
        inflight.delete(i);
        completionResolvers[i]?.();
        tryStart();
      });
    }
  };

  tryStart();

  // Wait for everything to finish. We only ever await *pending* completion
  // promises (or break when no job can make progress), so the runtime is
  // free to drain macrotasks — I/O, the abort grace timer, etc. — between
  // waves. Abort makes `tryStart` a no-op; once in-flight jobs drain via
  // their grace timers, the loop exits.
  while (completed.size < jobs.length) {
    if (inflight.size === 0) {
      // Nothing running — try to start the next wave, or bail.
      tryStart();
      if (inflight.size === 0) break;
      continue;
    }
    const pending = completions.filter((_, i) => !completed.has(i));
    if (pending.length === 0) break;
    await Promise.any(pending).catch(() => undefined);
    tryStart();
  }

  // Pad any missing slots (defensive — e.g. aborted before kick-off).
  for (let i = 0; i < results.length; i++) {
    if (!(i in results)) {
      results[i] = synthesiseAbortError(
        jobs[i].id,
        "aborted before start",
      ) as R;
    }
  }

  return results;
}

async function runJob<R>(
  job: ScheduledJob<R>,
  grace: number,
  parentSignal: AbortSignal,
): Promise<R> {
  if (parentSignal.aborted) {
    return synthesiseAbortError(job.id, "aborted before run") as R;
  }
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const execution = Promise.resolve().then(() => job.run());
  let onParent: (() => void) | undefined;
  const aborted = new Promise<R>((resolve) => {
    onParent = () => {
      // Give the tool a grace period to honour the signal.
      graceTimer = setTimeout(() => {
        timedOut = true;
        resolve(
          synthesiseAbortError(job.id, "tool ignored abort signal") as R,
        );
      }, grace);
    };
    parentSignal.addEventListener("abort", onParent, { once: true });
    if (parentSignal.aborted) onParent();
  });

  try {
    const result = await Promise.race([execution, aborted]);
    if (!timedOut && parentSignal.aborted) {
      return synthesiseAbortError(job.id, "aborted") as R;
    }
    return result;
  } finally {
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    if (onParent) parentSignal.removeEventListener("abort", onParent);
  }
}

export function synthesiseAbortError<R>(_id: string, reason: string): R {
  return {
    content: `[aborted] ${reason}`,
    isError: true,
  } as R;
}

/**
 * Two jobs conflict if any of:
 *  - one writes a path the other reads/writes
 *  - either declares network or process (treated as a global lock)
 */
function overlap(a: Accesses, b: Accesses): boolean {
  if (a.network || a.process || b.network || b.process) return true;
  const aw = a.files?.write ?? [];
  const bw = b.files?.write ?? [];
  if (conflicts(aw, bw).length > 0) return true;
  const ar = a.files?.read ?? [];
  const br = b.files?.read ?? [];
  if (conflicts(ar, bw).length > 0) return true;
  if (conflicts(aw, br).length > 0) return true;
  return false;
}
