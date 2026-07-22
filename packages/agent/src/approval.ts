import { Effect } from "effect";
import type { ApprovalDecisionType } from "@niuma/schema";
import type {
  ApprovalGateway,
  ApprovalInfo,
  ApprovalOutcome,
  ApprovalRequest,
  EventLog,
} from "./deps.ts";

interface Parked {
  readonly info: ApprovalInfo;
  readonly resume: (outcome: ApprovalOutcome) => void;
}

// Default gateway: records approval.requested (persisted + broadcast by the
// server's pubsub), parks the caller until the server calls resolve() with the
// user's stdin decision, then records approval.resolved. The `pending` map lets
// a reconnecting/resuming frontend rediscover outstanding approvals.
//
// When `signal` is threaded in, a parked approval is released on abort with a
// `reject` outcome — otherwise the callback would hang until externally
// resolved and the parked entry would leak. Effect.callback's resume is
// idempotent so a late resolve() after abort is a no-op.
export function makeApprovalGateway(eventLog: EventLog): ApprovalGateway {
  const parked = new Map<string, Parked>();

  const ask = (
    sessionId: string,
    req: ApprovalRequest,
    signal?: AbortSignal,
  ): Effect.Effect<ApprovalOutcome> =>
    Effect.gen(function* () {
      const approvalId = crypto.randomUUID();
      const info: ApprovalInfo = { approvalId, ...req };
      yield* eventLog.append(sessionId, {
        type: "approval.requested",
        data: { approvalId, callId: req.callId, name: req.name, input: req.input },
      });
      const outcome = yield* Effect.callback<ApprovalOutcome>((resume) => {
        parked.set(approvalId, {
          info,
          resume: (o) => resume(Effect.succeed(o)),
        });
        // Release a parked approval on session abort so the loop can record
        // turn.aborted instead of hanging on stdin. Effect.callback's
        // returned cleanup only runs on interruption, not on normal resume,
        // so — like resolve() — we delete the parked entry explicitly.
        const onAbort = () => {
          if (!parked.has(approvalId)) return;
          parked.delete(approvalId);
          resume(Effect.succeed({ decision: "reject", feedback: "aborted" }));
        };
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }
        // Best-effort interruption cleanup; no-op on normal completion.
        return Effect.sync(() => {
          parked.delete(approvalId);
          if (signal) signal.removeEventListener("abort", onAbort);
        });
      });
      yield* eventLog.append(sessionId, {
        type: "approval.resolved",
        data: {
          approvalId,
          decision: outcome.decision,
          ...(outcome.feedback !== undefined
            ? { feedback: outcome.feedback }
            : {}),
        },
      });
      return outcome;
    });

  const resolve = (
    approvalId: string,
    decision: ApprovalDecisionType,
    feedback?: string,
  ): void => {
    const p = parked.get(approvalId);
    if (!p) return;
    parked.delete(approvalId);
    p.resume(feedback !== undefined ? { decision, feedback } : { decision });
  };

  return {
    ask,
    resolve,
    get pending() {
      const m = new Map<string, ApprovalInfo>();
      for (const [id, p] of parked) m.set(id, p.info);
      return m;
    },
  };
}
