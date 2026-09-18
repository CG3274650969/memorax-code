import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withJsonFileLockAsync } from "../../memorax-code-adapter-common/src/config-utils.mjs";
import { cursorInstallationDetected, defaultCursorHome } from "../src/adapter-paths.mjs";
import {
  cursorHookCommand, disableCursorAdapter, enableCursorAdapter,
  readCursorAdapterStatus, removeCursorAdapterInstallation,
} from "../src/config.mjs";
import { writeCursorRuntimeObservation } from "../src/runtime-observation.mjs";

const events = ["sessionStart", "beforeSubmitPrompt", "afterAgentResponse", "stop"];

test("Cursor discovery honors home overrides and actual platform installations", () => {
  const home = join(tmpdir(), "cursor-discovery");
  assert.equal(defaultCursorHome({}, home), join(home, ".cursor"));
  assert.equal(defaultCursorHome({ CURSOR_HOME: join(home, "custom") }, home), join(home, "custom"));
  assert.equal(cursorInstallationDetected({ env: {}, home, platform: "darwin",
    pathExists: path => path === "/Applications/Cursor.app" }), true);
  assert.equal(cursorInstallationDetected({ env: {}, home, platform: "linux",
    pathExists: path => path === join(home, ".cursor") }), false);
  assert.equal(cursorInstallationDetected({ env: { CURSOR_HOME: join(home, "custom") },
    pathExists: () => false }), true);
  assert.equal(cursorInstallationDetected({ env: { LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local" },
    platform: "win32", pathExists: path => path.endsWith("\\Programs\\cursor\\Cursor.exe") }), true);
});

test("Cursor installation owns only its flat Hook entries and materialized shared Skill", async () => {
  const fixture = await createFixture();
  try {
    const installed = await enableCursorAdapter(fixture.options);
    assert.equal(installed.ok, true);
    assert.equal(installed.enabled, true);
    assert.equal(installed.cursorHooks.configured, true);
    assert.equal(installed.cursorHooks.runtimeObserved, false);
    assert.equal(installed.globalHooksActivationRequired, undefined);
    assert.equal(await readFile(join(installed.skillPath, "SKILL.md"), "utf8"), "# Canonical Skill fixture\n");
    assert.deepEqual(JSON.parse(await readFile(join(installed.skillPath, ".memorax-code-package.json"), "utf8")), {
      version: 1, memoraxCodeCommand: fixture.options.memoraxCodeCommand,
    });
    const hooks = await fixture.hooks();
    assert.equal(hooks.version, 1);
    assert.deepEqual(hooks.custom, { thirdPartyExtensibilityEnabled: true });
    assert.deepEqual(hooks.hooks.beforeSubmitPrompt[0], fixture.userHook);
    assert.deepEqual(hooks.hooks.afterFileEdit, [{ command: "user-after-edit" }]);
    for (const event of events) {
      const managed = hooks.hooks[event].filter(hook => hook.command.includes("--memorax-code-cursor-hook-v1"));
      assert.equal(managed.length, 1);
      assert.equal(managed[0].type, "command");
      assert.equal(managed[0].hooks, undefined);
    }
    assert.equal((await enableCursorAdapter(fixture.options)).changed, false);
    const state = JSON.parse(await readFile(installed.statePath, "utf8"));
    await writeCursorRuntimeObservation({ memoraxCodeHome: fixture.options.memoraxCodeHome,
      cursorHome: fixture.options.cursorHome, runtimeDigest: state.runtimeDigest });
    assert.equal((await readCursorAdapterStatus(fixture.options)).cursorHooks.runtimeObserved, true);

    const unrelated = join(fixture.options.cursorHome, "skills", "user-skill", "SKILL.md");
    await mkdir(join(fixture.options.cursorHome, "skills", "user-skill"), { recursive: true });
    await writeFile(unrelated, "user skill");
    assert.equal((await disableCursorAdapter(fixture.options)).enabled, false);
    assert.deepEqual((await fixture.hooks()).hooks, {
      beforeSubmitPrompt: [fixture.userHook], afterFileEdit: [{ command: "user-after-edit" }],
    });
    assert.equal(await readFile(join(installed.skillPath, "SKILL.md"), "utf8"), "# Canonical Skill fixture\n");
    assert.equal((await removeCursorAdapterInstallation(fixture.options)).removed, true);
    await assert.rejects(readFile(join(installed.skillPath, "SKILL.md")), /ENOENT/);
    assert.equal(await readFile(unrelated, "utf8"), "user skill");
    assert.equal((await readCursorAdapterStatus(fixture.options)).managed, false);
  } finally { await fixture.close(); }
});

test("Cursor generations retain recovery paths without rewriting an older runtime", async () => {
  const fixture = await createFixture();
  try {
    const first = await enableCursorAdapter(fixture.options);
    const state = JSON.parse(await readFile(first.statePath, "utf8"));
    const oldRuntime = await readFile(state.runtimePath, "utf8");
    const movedCommand = join(fixture.root, "moved-cli.mjs");
    await writeFile(movedCommand, "// never executed\n");
    const changed = await enableCursorAdapter({ ...fixture.options, memoraxCodeCommand: movedCommand });
    const next = JSON.parse(await readFile(changed.statePath, "utf8"));
    assert.notEqual(next.runtimeDigest, state.runtimeDigest);
    assert.equal(await readFile(state.runtimePath, "utf8"), oldRuntime);
    assert.equal(changed.changed, true);
    assert.equal((await enableCursorAdapter({ ...fixture.options, memoraxCodeCommand: movedCommand })).changed, false);
  } finally { await fixture.close(); }
});

test("Cursor generations retain an explicit database path and reject invalid replacements", async () => {
  const fixture = await createFixture();
  const previousDatabasePath = process.env.MEMORAX_CODE_CURSOR_DATABASE_PATH;
  try {
    const databasePath = join(fixture.root, "native-profile", "state.vscdb");
    process.env.MEMORAX_CODE_CURSOR_DATABASE_PATH = databasePath;
    const installed = await enableCursorAdapter(fixture.options);
    assert.equal(installed.ok, true);
    const state = JSON.parse(await readFile(installed.statePath, "utf8"));
    const metadataPath = join(state.runtimeRoot, state.runtimeDigest, ".memorax-code-package.json");
    assert.equal(JSON.parse(await readFile(metadataPath, "utf8")).databasePath, databasePath);
    delete process.env.MEMORAX_CODE_CURSOR_DATABASE_PATH;
    assert.equal((await enableCursorAdapter(fixture.options)).changed, false);
    process.env.MEMORAX_CODE_CURSOR_DATABASE_PATH = "relative.vscdb";
    assert.equal((await enableCursorAdapter(fixture.options)).reason, "database_path_invalid");
    assert.equal(JSON.parse(await readFile(installed.statePath, "utf8")).runtimeDigest, state.runtimeDigest);
    process.env.MEMORAX_CODE_CURSOR_DATABASE_PATH = join(fixture.root, "next-profile", "state.vscdb");
    assert.equal((await enableCursorAdapter(fixture.options)).changed, true);
    assert.equal(JSON.parse(await readFile(metadataPath, "utf8")).databasePath, databasePath);
    process.env.MEMORAX_CODE_CURSOR_DATABASE_PATH = "invalid-cleanup-override";
    assert.equal((await disableCursorAdapter(fixture.options)).ok, true);
    assert.equal((await removeCursorAdapterInstallation(fixture.options)).removed, true);
  } finally {
    if (previousDatabasePath === undefined) delete process.env.MEMORAX_CODE_CURSOR_DATABASE_PATH;
    else process.env.MEMORAX_CODE_CURSOR_DATABASE_PATH = previousDatabasePath;
    await fixture.close();
  }
});

test("Cursor lifecycle retains a recorded custom home when a later command omits the override", async () => {
  const fixture = await createFixture();
  const previousHome = process.env.CURSOR_HOME;
  try {
    delete process.env.CURSOR_HOME;
    const installed = await enableCursorAdapter(fixture.options);
    assert.equal(installed.enabled, true);
    const options = { ...fixture.options, cursorHome: undefined };
    assert.equal((await readCursorAdapterStatus(options)).cursorHome, fixture.options.cursorHome);
    assert.equal((await enableCursorAdapter(options)).changed, false);
    process.env.CURSOR_HOME = join(fixture.root, "conflicting-home");
    assert.equal((await disableCursorAdapter(options)).reason, "state_paths_invalid");
    delete process.env.CURSOR_HOME;
    assert.equal((await disableCursorAdapter(options)).ok, true);
    assert.equal((await removeCursorAdapterInstallation(options)).removed, true);
  } finally {
    if (previousHome === undefined) delete process.env.CURSOR_HOME;
    else process.env.CURSOR_HOME = previousHome;
    await fixture.close();
  }
});

test("Cursor command quoting and marker cleanup support POSIX and encoded Windows launchers", async () => {
  assert.equal(cursorHookCommand("/tmp/$runtime/$(touch marker)/runtime's.mjs", "linux", "/node's"),
    "'/node'\\''s' '/tmp/$runtime/$(touch marker)/runtime'\\''s.mjs' --memorax-code-cursor-hook-v1");
  const command = cursorHookCommand("C:\\Users\\Test User\\runtime.mjs", "win32", "C:\\Program Files\\node.exe");
  const encoded = / -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(command)?.[1];
  assert.ok(encoded);
  const script = Buffer.from(encoded, "base64").toString("utf16le");
  assert.match(script, /--memorax-code-cursor-hook-v1/);
  assert.match(script, /RedirectStandardInput=\$true/);
  const fixture = await createFixture();
  try {
    assert.equal((await enableCursorAdapter({ ...fixture.options, platform: "win32" })).ok, true);
    for (const event of events) assert.equal((await fixture.hooks()).hooks[event].at(-1).command.includes("-EncodedCommand"), true);
    assert.equal((await disableCursorAdapter(fixture.options)).ok, true);
    assert.deepEqual((await fixture.hooks()).hooks.beforeSubmitPrompt, [fixture.userHook]);
  } finally { await fixture.close(); }
});

test("Cursor install rejects unmanaged Skills and malformed or unknown-version manifests", async () => {
  const fixture = await createFixture();
  try {
    const target = join(fixture.options.cursorHome, "skills", "memorax-code");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "SKILL.md"), "user-owned");
    assert.equal((await enableCursorAdapter(fixture.options)).reason, "skill_conflict");
    assert.equal(await readFile(join(target, "SKILL.md"), "utf8"), "user-owned");
    await rm(target, { recursive: true });
    for (const content of ["{ broken", '{"version":2,"hooks":{}}', '{"version":1,"hooks":{"stop":{}}}']) {
      await writeFile(join(fixture.options.cursorHome, "hooks.json"), content);
      const result = await enableCursorAdapter(fixture.options);
      assert.equal(result.reason, "hooks_invalid");
      assert.equal(result.failure.failureReason, "invalid_configuration");
      assert.equal(await readFile(join(fixture.options.cursorHome, "hooks.json"), "utf8"), content);
    }
  } finally { await fixture.close(); }
});

test("Cursor lifecycle waits for its cross-process lock before changing user configuration", async () => {
  const fixture = await createFixture();
  let release;
  let holder;
  let install;
  try {
    let locked;
    const ready = new Promise(resolve => { locked = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    holder = withJsonFileLockAsync(fixture.options.lifecycleLockTarget, async () => {
      locked(); await pending;
    });
    await ready;
    const before = await fixture.hooks();
    install = enableCursorAdapter(fixture.options);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.deepEqual(await fixture.hooks(), before);
    release();
    await holder;
    assert.equal((await install).enabled, true);
  } finally {
    release?.();
    await Promise.allSettled([holder, install].filter(Boolean));
    await fixture.close();
  }
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cursor-config-"));
  const cursorHome = join(root, "Cursor Home");
  const source = join(root, "source");
  const options = {
    cursorHome, memoraxCodeHome: join(root, "state"),
    lifecycleLockTarget: join(root, "locks", "cursor-lifecycle"),
    runtimeHookSourcePath: join(source, "runtime-hook.mjs"),
    runtimeObservationSourcePath: join(source, "runtime-observation.mjs"),
    commonSourcePath: join(source, "common"), skillSourcePath: join(source, "skill"),
    memoraxCodeCommand: join(source, "cli.mjs"),
  };
  await Promise.all([cursorHome, options.commonSourcePath, options.skillSourcePath]
    .map(path => mkdir(path, { recursive: true })));
  await Promise.all([
    writeFile(options.runtimeHookSourcePath, "// runtime fixture\n"),
    writeFile(options.runtimeObservationSourcePath, "// observation fixture\n"),
    writeFile(options.memoraxCodeCommand, "// never executed\n"),
    writeFile(join(options.commonSourcePath, "common.mjs"), "// shared runtime\n"),
    writeFile(join(options.skillSourcePath, "SKILL.md"), "# Canonical Skill fixture\n"),
  ]);
  const userHook = { command: "user-command", matcher: "UserPromptSubmit", timeout: 5 };
  await writeFile(join(cursorHome, "hooks.json"), JSON.stringify({
    version: 1, custom: { thirdPartyExtensibilityEnabled: true },
    hooks: { beforeSubmitPrompt: [userHook], afterFileEdit: [{ command: "user-after-edit" }] },
  }));
  return { root, options, userHook,
    hooks: async () => JSON.parse(await readFile(join(cursorHome, "hooks.json"), "utf8")),
    close: () => rm(root, { recursive: true, force: true }),
  };
}
