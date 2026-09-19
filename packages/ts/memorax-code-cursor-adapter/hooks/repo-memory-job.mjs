#!/usr/bin/env node
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const hookDir = dirname(fileURLToPath(import.meta.url));
const adapterRoot = dirname(hookDir);
const packagedCommonRoot = join(adapterRoot, "memorax-code-adapter-common", "src");
const sourceCommonRoot = resolve(adapterRoot, "..", "memorax-code-adapter-common", "src");
const commonRoot = existsSync(packagedCommonRoot) ? packagedCommonRoot : sourceCommonRoot;
const { runRepoMemoryJob } = await import(pathToFileURL(join(commonRoot, "repo-memory", "repo-memory-job-supervisor.mjs")).href);
const { evaluateRepository } = await import(pathToFileURL(join(commonRoot, "repo-memory", "repo-memory-update-policy-evaluator.mjs")).href);
const packagedValidator = resolve(adapterRoot, "skills/memorax-code/scripts/repo-memory.mjs");
const validatorPath = existsSync(packagedValidator)
  ? packagedValidator
  : resolve(adapterRoot, "../memorax-code-codex-adapter/skills/memorax-code/scripts/repo-memory.mjs");

try {
  const payload = runRepoMemoryJob(process.argv.slice(2), {
    runner: "cursor",
    finalMessageSource: "stdout",
    memorySkillInvocation: "the `memorax-code` skill",
    validatorPath,
    evaluateRepository,
    createCommand({ prompt, repo }) {
      const cursorAgent = stringValue(process.env.MEMORAX_CODE_CURSOR_AGENT_COMMAND)
        ?? stringValue(process.env.CURSOR_AGENT_COMMAND)
        ?? readMetadataCommand(adapterRoot)
        ?? defaultCursorAgentCommand();
      return [
        cursorAgent,
        "-p",
        "--force",
        "--workspace",
        repo,
        "--plugin-dir",
        adapterRoot,
        "--output-format",
        "text",
        prompt,
      ];
    },
  });
  process.stdout.write(`${JSON.stringify(payload)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readMetadataCommand(pluginRoot) {
  try {
    const metadata = JSON.parse(readFileSync(join(pluginRoot, ".memorax-code-package.json"), "utf8"));
    return stringValue(metadata?.cursorAgentCommand);
  } catch {
    return undefined;
  }
}

function defaultCursorAgentCommand() {
  for (const command of ["agent", "cursor-agent"]) {
    if (commandOnPath(command)) return command;
  }
  return "cursor-agent";
}

function commandOnPath(command) {
  if (command.includes("/") || command.includes("\\")) return executable(command);
  for (const directory of String(process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const suffixes = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
    for (const suffix of suffixes) {
      if (executable(join(directory, `${command}${suffix}`))) return true;
    }
  }
  return false;
}

function executable(path) {
  try {
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
