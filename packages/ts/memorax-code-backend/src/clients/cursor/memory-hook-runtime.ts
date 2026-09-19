import { defaultMemoraxCodeHome } from "../../config/memorax-code.js";
import { createHarnessMemoryRuntime, type HarnessMemoryRuntimeOptions } from "../../memory/harness-runtime.js";
import type { CursorPreCompactCommand, CursorTurnStartCommand, CursorWritebackCommand, MemoryHookTurnStartResult } from "../../memory/hook-command.js";
import { resolvedRepoMemoryWorktree } from "../../memory/repository-session.js";
import type { RepositoryMemoryScope } from "../../repository/scope.js";
import type { MemoryTurnState } from "../../memory/turn-coordinator.js";
import { traceContextFromCursorHookBody, type TraceContext } from "../../trace/context.js";
import { markCurrentTraceTurnOutcome, recordTraceEvent, traceTurnEventId } from "../../trace/store.js";
import { readCursorCompactionSnapshot, readCursorDatabaseSnapshot } from "./database-snapshot.js";
import { captureCursorCompaction, consumeCursorCompaction } from "./compaction.js";
import { captureCursorContinuation, cursorTextDigest, selectCursorDatabaseTurn } from "./database-turn.js";
import { cursorPendingSessions, retireCursorGeneration, withCursorSessionRecord, type CursorSessionRecord, type CursorStoredTurn } from "./turn-store.js";

export type CursorMemoryHookWritebackResult =
  | { ok: true; scheduled: true }
  | { ok: true; scheduled: false; reason: string };

export type CursorMemoryHookTurnStartResult = MemoryHookTurnStartResult & {
  recorded: boolean;
  restorePersonalMemory?: true;
};
export type CursorMemoryHookPreCompactResult = { ok: true; recorded: boolean; reason?: string };

export type CursorMemoryHookRuntimeOptions = HarnessMemoryRuntimeOptions & {
  databaseRetryDelayMs?: number;
  databaseRetryWindowMs?: number;
  turnStateLockTimeoutMs?: number;
};

export type CursorMemoryHookRuntime = {
  recordTurnStart(command: CursorTurnStartCommand): Promise<CursorMemoryHookTurnStartResult>;
  recordPreCompact(command: CursorPreCompactCommand): Promise<CursorMemoryHookPreCompactResult>;
  writeback(command: CursorWritebackCommand): Promise<CursorMemoryHookWritebackResult>;
  size(): number;
  close(): void;
};

export function createCursorMemoryHookRuntime(
  options: CursorMemoryHookRuntimeOptions = {},
): CursorMemoryHookRuntime {
  const now = options.now ?? (() => Date.now());
  const home = options.memoraxCodeHome ?? defaultMemoraxCodeHome(options.env);
  const memory = createHarnessMemoryRuntime({
    client: "cursor",
    retrievalSource: "cursor_hook_retrieval",
    writebackSource: "cursor_hook_writeback",
    diagnosticPrefix: "cursor_memory",
    traceFailureEvent: "cursor_trace.write_failed",
    turnStartTraceSource: "cursor-hook",
    deduplicateRetrieval: true,
    automaticRetrieval: false,
  }, options);
  const { turnCoordinator } = memory;
  let closed = false;
  const retries = new Map<string, ReturnType<typeof setTimeout>>();
  const retryDelay = Math.min(positiveInteger(options.databaseRetryDelayMs, 250), 2000);
  const retryWindow = Math.min(positiveInteger(options.databaseRetryWindowMs, 30_000), 60_000);

  function stateOptions(sessionId: string) {
    return { home, sessionId, lockTimeoutMs: options.turnStateLockTimeoutMs };
  }

  function diagnostic(reason: string, command: { sessionId: string; turnId: string }) {
    options.diagnosticLogger?.("cursor_memory.writeback", {
      sessionId: command.sessionId, turnId: command.turnId, scheduled: false, reason,
      metadataDisposition: "retained",
    });
  }

  async function recordOutcome(command: CursorWritebackCommand, turn: CursorStoredTurn, outcome: "completed" | "interrupted") {
    const traceContext = traceForTurn(command.sessionId, turn);
    try {
      await recordTraceEvent({
        eventId: traceTurnEventId(traceContext, "turn_end"),
        memoraxCodeHome: home, env: options.env, traceContext,
        type: "turn_end", source: "cursor-hook", operation: "writeback", ok: true, outcome,
      });
      await markCurrentTraceTurnOutcome(traceContext, outcome, {
        client: "cursor", memoraxCodeHome: home, env: options.env, now: () => new Date(now()),
      });
    } catch {
      options.diagnosticLogger?.("cursor_trace.write_failed", { label: "turn_end" });
    }
  }

  function cancelRetry(sessionId: string) {
    const timer = retries.get(sessionId);
    if (timer) clearTimeout(timer);
    retries.delete(sessionId);
  }

  function scheduleRetry(sessionId: string, until: number) {
    if (closed || retries.has(sessionId) || now() >= until) return;
    const timer = setTimeout(() => {
      retries.delete(sessionId);
      void withCursorSessionRecord(stateOptions(sessionId), async (record, save) => {
        const turn = record.active;
        if (!turn || closed || turn.state !== "open" || turn.stopStatus !== "completed"
          || !turn.responseDigest || !turn.retryUntil || now() >= turn.retryUntil) return;
        await completePending(sessionId, record, save);
      }).catch(() => { scheduleRetry(sessionId, until); });
    }, Math.min(retryDelay, Math.max(1, until - now())));
    timer.unref();
    retries.set(sessionId, timer);
  }

  async function completePending(sessionId: string, record: CursorSessionRecord, save: () => void): Promise<CursorMemoryHookWritebackResult> {
    const turn = record.active!;
    const command = { sessionId, turnId: turn.turnId };
    if (closed) return skipped("runtime_closed");
    if (turn.state === "accepted") return skipped("already_accepted_locally");
    if (turn.state !== "open") return skipped(turn.reason ?? "native_authority_unavailable");
    if (turn.stopStatus !== "completed") return skipped("completion_event_missing");
    if (!turn.responseDigest) return skipped("response_digest_missing");
    turn.retryUntil ??= now() + retryWindow;
    save();
    const snapshot = await readCursorDatabaseSnapshot({ databasePath: turn.databasePath, sessionId });
    const native = snapshot.ok ? selectCursorDatabaseTurn({
      snapshot: snapshot.snapshot, generationId: turn.turnId,
      promptDigest: turn.promptDigest, responseDigest: turn.responseDigest,
      continuation: turn.continuation,
    }) : snapshot;
    if (closed) return skipped("runtime_closed");
    if (!native.ok) {
      if (!native.retryable) {
        turn.state = "blocked";
        turn.reason = native.reason;
        save();
        cancelRetry(sessionId);
      } else {
        scheduleRetry(sessionId, turn.retryUntil);
      }
      diagnostic(native.reason, command);
      return skipped(native.reason);
    }
    const traceContext = traceForTurn(sessionId, turn);
    const metadata = turnCoordinator.getTurn(turnKey(sessionId, turn.turnId))
      ?? metadataFromStored(sessionId, turn, traceContext);
    const completed = await memory.completeTurn({
      sessionId, clientTurnId: turn.turnId, metadata,
      userText: native.userPrompt, assistantText: native.assistantReply,
      assistantTimestamp: turn.responseObservedAt, assistantTimestampSource: "observed",
      traceContext,
      resolveRepositoryMemory: () => memory.resolveRepositoryMemory({
        sessionId, cwd: turn.cwd, workspaceKind: turn.workspaceKind,
        restoreScope: async () => record.repositoryScope,
      }),
    });
    if (!completed.scheduled) {
      scheduleRetry(sessionId, turn.retryUntil);
      diagnostic(completed.reason, command);
      return skipped(completed.reason);
    }
    // Local enqueue acceptance is the metadata-consumption boundary.
    turn.state = "accepted";
    delete turn.metadata;
    delete turn.retryUntil;
    save();
    cancelRetry(sessionId);
    try {
      await recordTraceEvent({
        eventId: traceTurnEventId(traceContext, "turn_materialized"),
        memoraxCodeHome: home, env: options.env, traceContext,
        type: "turn_materialized", source: "cursor-hook", operation: "writeback", ok: true,
        request: { prompt: native.userPrompt }, response: { assistant: native.assistantReply },
      });
    } catch { options.diagnosticLogger?.("cursor_trace.write_failed", { label: "turn_materialized" }); }
    return { ok: true, scheduled: true };
  }

  // Only our private pending records are scanned; never enumerate client chats.
  for (const pending of cursorPendingSessions(home)) scheduleRetry(pending.sessionId, pending.retryUntil);

  return {
    async recordPreCompact(command) {
      const skipped = (reason: string): CursorMemoryHookPreCompactResult => ({ ok: true, recorded: false, reason });
      if (command.client !== "cursor") return skipped("client_mismatch");
      try {
        return await withCursorSessionRecord(stateOptions(command.sessionId), async (record, save) => {
          const active = record.active;
          if (!active) return skipped("start_missing");
          if (active.databasePath !== command.databasePath || active.cwd !== command.cwd
            || active.workspaceKind !== command.workspaceKind) {
            delete record.compaction;
            save();
            return skipped("database_or_workspace_changed");
          }
          const repositoryMemory = await memory.resolveRepositoryMemory({
            sessionId: command.sessionId, cwd: command.cwd, workspaceKind: command.workspaceKind,
            restoreScope: async () => record.repositoryScope,
          });
          const scope = repositoryMemory.ok ? repositoryMemory.memory.scope : undefined;
          if (!command.cwd || !scope || !resolvedRepoMemoryWorktree(repositoryMemory) || !record.repositoryScope
            || compactionScopeKey(scope) !== compactionScopeKey(record.repositoryScope)) {
            delete record.compaction;
            save();
            return skipped("workspace_scope_unavailable");
          }
          const native = await readCursorCompactionSnapshot(command);
          if (!native.ok) return skipped(native.reason);
          if (!native.snapshot.rootMessageIds.length) return skipped("compaction_roots_missing");
          record.compaction = captureCursorCompaction(record.compaction, {
            databasePath: command.databasePath, cwd: command.cwd, scopeKey: compactionScopeKey(scope),
          }, native.snapshot);
          // Manual summarization has its own generation identity. Observing it
          // must never register, replace, or complete the active Add turn.
          save();
          return { ok: true, recorded: true };
        });
      } catch { return skipped("turn_state_unavailable"); }
    },

    async recordTurnStart(command) {
      if (command.client !== "cursor") return { ok: true, recorded: false };
      const createdAt = now();
      const traceContext = traceContextFromCursorHookBody(command, new Date(createdAt).toISOString());
      try {
        return await withCursorSessionRecord(stateOptions(command.sessionId), async (record, save) => {
          if (record.retiredTurnIds.includes(command.turnId)) {
            diagnostic("duplicate_start", command);
            return { ok: true, recorded: false };
          }
          if (record.active?.turnId === command.turnId) {
            if (record.active.state !== "accepted" && record.active.state !== "interrupted") {
              record.active.state = "blocked";
              record.active.reason = "duplicate_start";
              save();
            }
            diagnostic("duplicate_start", command);
            return { ok: true, recorded: false };
          }
          const previous = record.active;
          if (previous?.state === "open" && previous.stopStatus === "completed" && previous.responseDigest) {
            // Make one final exact read before the next start replaces pending authority.
            await completePending(command.sessionId, record, save);
          }
          cancelRetry(command.sessionId);
          let continuation: CursorStoredTurn["continuation"];
          let reason: string | undefined;
          if (!command.prompt.trim()) {
            if (!previous || !previous.stopStatus || previous.state === "blocked"
              || previous.databasePath !== command.databasePath || previous.cwd !== command.cwd
              || previous.workspaceKind !== command.workspaceKind) {
              reason = "continuation_user_unbound";
            } else {
              for (let attempt = 0; attempt < 5; attempt += 1) {
                const snapshot = await readCursorDatabaseSnapshot({ databasePath: command.databasePath, sessionId: command.sessionId });
                const bound = snapshot.ok ? captureCursorContinuation({
                  snapshot: snapshot.snapshot, generationId: command.turnId, previousGenerationId: previous.turnId,
                  requestId: previous.continuation?.requestId ?? previous.turnId,
                  promptDigest: previous.continuation?.promptDigest ?? previous.promptDigest,
                }) : snapshot;
                if (bound.ok) { continuation = bound.baseline; reason = undefined; break; }
                reason = bound.reason;
                if (!bound.retryable || attempt === 4) break;
                await new Promise((resolve) => setTimeout(resolve, 100));
              }
            }
          }
          if (previous) {
            retireCursorGeneration(record);
            turnCoordinator.discardTurn(turnKey(command.sessionId, previous.turnId), "interrupted");
            options.diagnosticLogger?.("cursor_memory.turn_discarded", {
              sessionId: command.sessionId, turnId: previous.turnId, reason: "generation_replaced",
            });
          }
          const repositoryMemory = await memory.resolveRepositoryMemory({
            sessionId: command.sessionId, cwd: command.cwd, workspaceKind: command.workspaceKind,
            restoreScope: async () => record.repositoryScope,
          });
          if (repositoryMemory.ok && repositoryMemory.memory.scope) record.repositoryScope = repositoryMemory.memory.scope;
          const turn: CursorStoredTurn = {
            turnId: command.turnId, ...(command.cwd ? { cwd: command.cwd } : {}),
            ...(command.workspaceKind ? { workspaceKind: command.workspaceKind } : {}), createdAt,
            promptDigest: cursorTextDigest(command.prompt),
            ...(command.transcriptPath ? { transcriptPath: command.transcriptPath } : {}),
            databasePath: command.databasePath,
            ...(continuation ? { continuation } : {}),
            state: reason ? "blocked" : "open",
            ...(reason ? { reason } : {}),
            metadata: {},
          };
          record.active = turn;
          // Cursor has no automatic retrieval. Keep its local trace/current-turn
          // writes under this lock so an older start cannot overwrite a new one.
          const result = await memory.recordTurnStart({
            sessionId: command.sessionId, clientTurnId: command.turnId,
            cwd: command.cwd, workspaceKind: command.workspaceKind, transcriptPath: command.transcriptPath,
            createdAt, traceContext, prompt: command.prompt, repositoryMemory,
            onTurnRegistered(metadata) {
              turn.metadata = {
                ...(metadata.repositoryScope ? { repositoryScope: metadata.repositoryScope } : {}),
                ...(metadata.repositoryScopeReason ? { repositoryScopeReason: metadata.repositoryScopeReason } : {}),
              };
              save();
            },
          });
          let restorePersonalMemory = false;
          if (record.compaction) {
            const scope = repositoryMemory.ok ? repositoryMemory.memory.scope : undefined;
            const scopeKey = scope ? compactionScopeKey(scope) : undefined;
            if (!result.repoMemoryWorktree || scopeKey !== record.compaction.scopeKey
              || command.databasePath !== record.compaction.databasePath || command.cwd !== record.compaction.cwd) {
              delete record.compaction;
              save();
            } else if (command.prompt.trim() && record.compaction.baseline) {
              const native = await readCursorCompactionSnapshot(command);
              if (native.ok) {
                restorePersonalMemory = consumeCursorCompaction(record.compaction, {
                  databasePath: command.databasePath, cwd: command.cwd, scopeKey,
                }, native.snapshot);
                save();
              }
            }
          }
          if (reason) diagnostic(reason, command);
          return { ...result, recorded: true, ...(restorePersonalMemory ? { restorePersonalMemory: true } : {}) };
        });
      } catch {
        diagnostic("turn_state_unavailable", command);
        // Retrying outside the lock could publish stale CLI identity after a
        // newer generation. Unavailable durable authority cannot register here.
        return { ok: true, recorded: false };
      }
    },

    async writeback(command) {
      if (command.client !== "cursor") return skipped("client_mismatch");
      try {
        return await withCursorSessionRecord(stateOptions(command.sessionId), async (record, save) => {
          const turn = record.active;
          if (!turn) return skipped("start_missing");
          if (turn.turnId !== command.turnId) return skipped("generation_replaced");
          if (turn.state === "accepted") return skipped("already_accepted_locally");
          if (turn.state === "interrupted") return skipped("interrupted");
          const block = (reason: string) => {
            turn.state = "blocked";
            turn.reason = reason;
            save();
            cancelRetry(command.sessionId);
            diagnostic(reason, command);
            return skipped(reason);
          };
          if (command.databasePath !== turn.databasePath || command.cwd !== turn.cwd
            || command.workspaceKind !== turn.workspaceKind) return block("database_or_workspace_changed");
          if (command.phase === "stop" && command.status !== "completed") {
            cancelRetry(command.sessionId);
            if (turn.stopStatus && turn.stopStatus !== command.status) return block("conflicting_stop_events");
            turn.stopStatus = command.status;
            turn.state = "interrupted";
            turn.reason = "interrupted";
            delete turn.metadata;
            save();
            turnCoordinator.discardTurn(turnKey(command.sessionId, command.turnId), "interrupted");
            await recordOutcome(command, turn, "interrupted");
            return skipped("interrupted");
          }
          if (command.phase === "stop") {
            if (turn.stopStatus && turn.stopStatus !== command.status) return block("conflicting_stop_events");
            turn.stopStatus = command.status;
            if (turn.responseDigest) turn.retryUntil ??= now() + retryWindow;
            save();
            // A completed Hook closes operational trace even when native
            // content is still pending or cannot authorize automatic Add.
            await recordOutcome(command, turn, "completed");
          }
          if (command.phase === "response") {
            if (!/^[0-9a-f]{64}$/.test(command.responseDigest)) return block("response_digest_invalid");
            if (turn.responseDigest && turn.responseDigest !== command.responseDigest) return block("conflicting_response_events");
            turn.responseDigest = command.responseDigest;
            turn.responseObservedAt ??= now();
            if (turn.stopStatus === "completed") turn.retryUntil ??= now() + retryWindow;
          }
          save();
          return await completePending(command.sessionId, record, save);
        });
      } catch {
        diagnostic("turn_state_unavailable", command);
        return skipped("turn_state_unavailable");
      }
    },
    size: () => memory.size(),
    close() {
      closed = true;
      for (const timer of retries.values()) clearTimeout(timer);
      retries.clear();
      memory.close();
    },
  };
}

function compactionScopeKey(scope: RepositoryMemoryScope): string {
  return cursorTextDigest(JSON.stringify([
    scope.baseUserId, scope.effectiveUserId, scope.repositoryKey, scope.scopeKind, scope.boundWorkspaceRoot,
  ]));
}

function traceForTurn(sessionId: string, turn: CursorStoredTurn): TraceContext | undefined {
  return traceContextFromCursorHookBody({
    sessionId, turnId: turn.turnId, cwd: turn.cwd, workspaceKind: turn.workspaceKind,
    transcriptPath: turn.transcriptPath,
  }, new Date(turn.createdAt).toISOString());
}

function metadataFromStored(sessionId: string, turn: CursorStoredTurn, traceContext: TraceContext | undefined): MemoryTurnState {
  return {
    client: "cursor", sessionId, clientTurnId: turn.turnId, cwd: turn.cwd,
    workspaceKind: turn.workspaceKind,
    transcriptPath: turn.transcriptPath, createdAt: turn.createdAt, traceContext,
    ...turn.metadata,
  };
}

function turnKey(sessionId: string, turnId: string) {
  return { client: "cursor" as const, sessionId, clientTurnId: turnId };
}

function skipped(reason: string): CursorMemoryHookWritebackResult {
  return { ok: true, scheduled: false, reason };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
