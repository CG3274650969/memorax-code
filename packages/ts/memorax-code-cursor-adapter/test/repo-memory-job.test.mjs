import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { markerPathForRepo } from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-job-marker.mjs";

const adapterRoot = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const jobHook = join(adapterRoot, "hooks", "repo-memory-job.mjs");

test("Cursor Repo Memory launcher builds a writable headless command", () => {
  const root = tempRoot("cursor-repo-memory-job-dry-run-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  const cursorAgent = join(root, "cursor-agent");
  initRepo(repo);

  const result = runJob(["start", "--mode", "build", "--repo", repo, "--dry-run"], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
    MEMORAX_CODE_CURSOR_AGENT_COMMAND: cursorAgent,
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.runner, "cursor");
  assert.equal(payload.finalMessageSource, "stdout");
  assert.equal(payload.repo, repo);
  assert.deepEqual(payload.command.slice(0, 9), [
    cursorAgent,
    "-p",
    "--force",
    "--workspace",
    repo,
    "--plugin-dir",
    adapterRoot,
    "--output-format",
    "text",
  ]);
  assert.match(payload.prompt, /repo-build operation/);
  assert.match(payload.prompt, /the `memorax-code` skill/);
});

test("Cursor Repo Memory launcher records a missing Agent CLI as a bounded failure", () => {
  const root = tempRoot("cursor-repo-memory-job-spawn-fails-");
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code");
  const missingCursorAgent = join(root, "missing-cursor-agent");
  initRepo(repo);

  const result = runJob(["start", "--mode", "build", "--repo", repo], {
    MEMORAX_CODE_HOME: memoraxCodeHome,
    MEMORAX_CODE_CURSOR_AGENT_COMMAND: missingCursorAgent,
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const state = waitForTerminal(payload.jobPath);
  assert.equal(state.status, "failed");
  assert.equal(state.failureReason, "cursor_spawn_failed");
  assert.equal(readMarker(memoraxCodeHome, repo), false);
});

function runJob(args, env = {}) {
  return spawnSync(process.execPath, [jobHook, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function tempRoot(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function initRepo(repo) {
  mkdirSync(repo, { recursive: true });
  runGit(repo, ["init", "--quiet"]);
  runGit(repo, ["config", "user.name", "Cursor Repo Memory Test"]);
  runGit(repo, ["config", "user.email", "cursor-repo-memory@example.invalid"]);
  writeFileSync(join(repo, "README.md"), "# Cursor Repo Memory Test\n");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "--quiet", "-m", "initial"]);
}

function runGit(repo, args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function waitForTerminal(jobPath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = JSON.parse(readFileSync(jobPath, "utf8"));
    if (state.status === "succeeded" || state.status === "failed") return state;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for Cursor Repo Memory job: ${jobPath}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
}

function readMarker(memoraxCodeHome, repo) {
  try {
    readFileSync(markerPathForRepo(memoraxCodeHome, realpathSync(repo)).markerPath, "utf8");
    return true;
  } catch {
    return false;
  }
}
