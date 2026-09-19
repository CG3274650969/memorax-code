#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeCursorRuntimeObservation } from "../src/runtime-observation.mjs";
import { cursorDatabasePath } from "../src/native-database-path.mjs";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const commonRoot = join(runtimeRoot, "memorax-code-adapter-common", "src");
const { resolveBackendConnection } = await import(pathToFileURL(join(commonRoot, "backend-connection.mjs")).href);
const { postBackendCommand } = await import(pathToFileURL(join(commonRoot, "backend-command.mjs")).href);
const { ensureBackendAvailable } = await import(pathToFileURL(join(commonRoot, "hooks", "ensure-backend-runner.mjs")).href);
const { scheduleMissingRepoMemoryBuild } = await import(pathToFileURL(join(commonRoot, "repo-memory", "repo-memory-auto-build.mjs")).href);
const {
  memorySkillReminderContext,
  personalMemoryReminderContext,
  MEMORY_IMPACT_REMINDER_CONTEXT,
} = await import(pathToFileURL(join(commonRoot, "hooks", "memory-skill-reminder-policy.mjs")).href);
const { evaluateMemorySkillReminder, markSupplementalReminderForSession } = await import(pathToFileURL(join(commonRoot, "hooks", "memory-skill-reminder-hook.mjs")).href);
const { buildRepoUserProfilePreferencesContext } = await import(pathToFileURL(join(commonRoot, "repo-memory", "repo-user-profile-context.mjs")).href);
const { buildRepoProcedureMemoryContext } = await import(pathToFileURL(join(commonRoot, "repo-memory", "repo-procedure-memory-context.mjs")).href);
const { isRepoMemoryJobWorker } = await import(pathToFileURL(join(commonRoot, "repo-memory", "repo-memory-job-context.mjs")).href);

if (isRepoMemoryJobWorker()) process.exit(0);

const input = await readJsonStdin();
const event = input.hook_event_name;
// Cursor documents `session_id` for sessionStart/sessionEnd and
// `conversation_id` in the common Hook fields. Treat them as aliases so a
// client version that omits the common field still receives the session
// bootstrap context and can correlate later events.
const sessionId = input.conversation_id ?? input.session_id;
const turnId = input.generation_id;
const cwd = Array.isArray(input.workspace_roots) && input.workspace_roots.length === 1
  ? absolutePath(input.workspace_roots[0]) : undefined;
const requiresWorkspace = event !== "sessionStart";
if (!["sessionStart", "beforeSubmitPrompt", "preCompact", "afterAgentResponse", "stop"].includes(event)
  || !uuid(sessionId) || (requiresWorkspace && !cwd)
  || (input.session_id !== undefined && input.session_id !== sessionId)
  || (event !== "sessionStart" && !uuid(turnId))) process.exit(0);
const transcriptPath = absolutePath(input.transcript_path);

const packageMetadata = await readRecord(join(runtimeRoot, ".memorax-code-package.json"));
const home = stringValue(process.env.MEMORAX_CODE_HOME)
  ?? stringValue(packageMetadata.memoraxCodeHome) ?? join(homedir(), ".memorax-code");
const cursorHome = stringValue(process.env.CURSOR_HOME)
  ?? stringValue(packageMetadata.cursorHome) ?? join(homedir(), ".cursor");
const runtimeDigest = stringValue(packageMetadata.runtimeDigest);
const databasePath = cursorDatabasePath({ recordedPath: packageMetadata.databasePath });
if (event !== "sessionStart" && !databasePath) process.exit(0);
const debugEnabled = process.env.MEMORAX_CODE_CURSOR_HOOK_DEBUG === "1";
if (runtimeDigest) {
  try { await writeCursorRuntimeObservation({ memoraxCodeHome: home, cursorHome, runtimeDigest }); }
  catch (error) { debug(error); }
}

await ensureBackendAvailable({
  client: "cursor",
  ensureBackendValue: process.env.MEMORAX_CODE_CURSOR_ENSURE_BACKEND
    ?? process.env.MEMORAX_CODE_CURSOR_HOOK_ENSURE_BACKEND,
  healthTimeoutValue: process.env.MEMORAX_CODE_CURSOR_ENSURE_TIMEOUT_MS,
  startTimeoutValue: process.env.MEMORAX_CODE_CURSOR_START_TIMEOUT_MS,
  memoraxCodeCommand: stringValue(process.env.MEMORAX_CODE_CURSOR_LIFECYCLE_COMMAND)
    ?? stringValue(process.env.MEMORAX_CODE_COMMAND),
  pluginRoot: runtimeRoot,
  resolveHomes: () => ({ memoraxCodeHome: home, cursorHome }),
  buildStartArgs: (homes, recoveryArguments) => [
    "start", "--home", homes.memoraxCodeHome, "--cursor-home", homes.cursorHome,
    ...recoveryArguments,
  ],
  debug,
}, input);

const identity = {
  version: 1, client: "cursor", sessionId, turnId, cwd,
  databasePath,
  ...(transcriptPath ? { transcriptPath } : {}),
};
if (event === "sessionStart") {
  // Cursor guarantees these variables to subsequent Hooks, not shell tools.
  // Keep an explicit command-environment instruction in the native context.
  process.stdout.write(`${JSON.stringify({
    env: {
      MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT: "cursor",
      MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID: sessionId,
    },
    additional_context: [
      memorySkillReminderContext("the `memorax-code` skill"),
      personalMemoryReminderContext("the `memorax-code` skill"),
      MEMORY_IMPACT_REMINDER_CONTEXT,
      "Use the shared skill's Repo Memory authority and workspace rules before reading or writing repository memory.",
      `For every memorax-cli invocation in this conversation, explicitly set MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT=cursor and MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID=${sessionId} in that command's environment.`,
      `In POSIX shells use: env MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT=cursor MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID=${sessionId} memorax-cli <arguments>. In PowerShell set the corresponding $env: variables before the command. Do not assume shell tools inherit Hook environment variables.`,
    ].join("\n\n"),
  })}\n`);
} else if (event === "beforeSubmitPrompt") {
  // Empty native prompts identify Continue; Backend retains the skip decision.
  if (typeof input.prompt !== "string") process.exit(0);
  const turnStart = await post("/memory/turn-start", { ...identity, prompt: input.prompt });
  const repoMemoryWorktree = absolutePath(turnStart?.repoMemoryWorktree);
  if (turnStart?.ok === true && turnStart.recorded === true && repoMemoryWorktree) {
    scheduleMissingRepoMemoryBuild(repoMemoryWorktree, {
      debugEnv: "MEMORAX_CODE_CURSOR_HOOK_DEBUG",
      env: { ...process.env, MEMORAX_CODE_HOME: home },
      pluginRoot: runtimeRoot,
    });
  }
  const reminder = turnStart?.ok === true && turnStart.recorded === true && input.prompt.trim()
    ? await evaluateReminder(turnStart) : undefined;
  process.stdout.write(`${JSON.stringify({
    continue: true,
    ...(reminder?.additionalContext ? { additional_context: reminder.additionalContext } : {}),
  })}\n`);
  if (reminder?.reminder) {
    await post("/memory/skill-reminder", {
      version: 1, client: "cursor", sessionId, turnId, cwd,
      content: reminder.reminder.content, triggers: reminder.reminder.triggers,
    }, 500);
  }
} else if (event === "preCompact") {
  await post("/memory/pre-compact", identity);
} else if (event === "afterAgentResponse") {
  if (typeof input.text !== "string" || !input.text) process.exit(0);
  await post("/memory/writeback", {
    ...identity, phase: "response",
    responseDigest: createHash("sha256").update(input.text).digest("hex"),
  });
} else if (["completed", "aborted", "error"].includes(input.status)) {
  await post("/memory/writeback", { ...identity, phase: "stop", status: input.status });
}

async function evaluateReminder(turnStart) {
  const worktree = absolutePath(turnStart.repoMemoryWorktree);
  if (worktree && turnStart.restorePersonalMemory === true) {
    markSupplementalReminderForSession({
      adapterDir: "cursor", runtime: "cursor", memoraxCodeHome: home,
      debugEnv: "MEMORAX_CODE_CURSOR_HOOK_DEBUG",
    }, sessionId);
  }
  const contextOptions = {
    adapterDir: "cursor", sessionKeyPrefix: "cursor", debugEnv: "MEMORAX_CODE_CURSOR_HOOK_DEBUG",
  };
  return await evaluateMemorySkillReminder({
    adapterDir: "cursor", runtime: "cursor", memoraxCodeHome: home,
    debugEnv: "MEMORAX_CODE_CURSOR_HOOK_DEBUG",
    memorySkillInvocation: "the `memorax-code` skill",
    additionalReminderContext: personalMemoryReminderContext("the `memorax-code` skill"),
    memoryImpactContext: MEMORY_IMPACT_REMINDER_CONTEXT,
    remindOnFirstTurn: true,
    supplementalReminderAfterCompact: true,
    requireTranscriptPath: false,
    ...(worktree ? {
      buildPersonalMemoryContext: (hookInput) => buildRepoUserProfilePreferencesContext({
        ...hookInput, cwd: worktree,
      }, contextOptions),
      buildCadenceReminderContext: (hookInput) => buildRepoProcedureMemoryContext({
        ...hookInput, cwd: worktree,
      }, contextOptions),
    } : {}),
  }, { hookEventName: "UserPromptSubmit", sessionId, turnId, cwd });
}

async function post(path, body, timeoutMs = 12_000) {
  try {
    const connection = resolveBackendConnection({ memoraxCodeHome: home });
    const response = await postBackendCommand({ connection, path, body, timeoutMs, memoraxCodeHome: home });
    return response.ok ? await response.json().catch(() => undefined) : undefined;
  } catch (error) {
    debug(error);
    return undefined;
  }
}

async function readJsonStdin() {
  try {
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    const value = JSON.parse(text);
    return isRecord(value) ? value : {};
  } catch { return {}; }
}

async function readRecord(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return isRecord(value) ? value : {};
  } catch { return {}; }
}

function uuid(value) {
  return typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
}

function absolutePath(value) {
  return typeof value === "string" && value.trim() && !/[\r\n\0]/.test(value)
    && (isAbsolute(value) || win32.isAbsolute(value)) ? value : undefined;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function debug(error) {
  if (debugEnabled) console.error(error instanceof Error ? error.message : String(error));
}
