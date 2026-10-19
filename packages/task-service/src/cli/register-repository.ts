/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { createRuntimeConfig } from "../config/runtime-config.js";
import { PlatformDomainError, assertProjectNotArchived } from "../core/task-service.js";
import { SqliteDatabase } from "../storage/database.js";

interface RegisterRepositoryArgs {
  projectId: string;
  projectName: string;
  repositoryId: string;
  repositoryName: string;
  path: string;
}

const requiredFlags = [
  "--project-id",
  "--project-name",
  "--repository-id",
  "--repository-name",
  "--path"
] as const;

function usage(): string {
  return [
    "Usage: npm run repo:register -- --project-id <id> --project-name <name>",
    "  --repository-id <id> --repository-name <name> --path <git-repository-root>"
  ].join("\n");
}

function parseArgs(argv: readonly string[]): RegisterRepositoryArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      flag === undefined
      || !requiredFlags.includes(flag as (typeof requiredFlags)[number])
      || value === undefined
      || value.startsWith("--")
    ) {
      throw new Error(`Unexpected arguments near "${flag ?? value ?? ""}"\n${usage()}`);
    }
    values.set(flag, value);
  }
  const missing = requiredFlags.filter((flag) => !values.has(flag));
  if (missing.length > 0) {
    throw new Error(`Missing required flags: ${missing.join(", ")}\n${usage()}`);
  }
  return {
    projectId: values.get("--project-id")!,
    projectName: values.get("--project-name")!,
    repositoryId: values.get("--repository-id")!,
    repositoryName: values.get("--repository-name")!,
    path: values.get("--path")!
  };
}

function resolveRepositoryRoot(rawPath: string): string {
  const path = realpathSync(rawPath);
  if (!statSync(path).isDirectory()) {
    throw new Error(`Repository path is not a directory: ${rawPath}`);
  }
  let toplevel: string;
  try {
    toplevel = execFileSync(
      "git",
      ["-C", path, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trimEnd();
  } catch (error) {
    throw new Error(`Repository path is not a Git repository: ${path}`, { cause: error });
  }
  if (toplevel !== path) {
    throw new Error(
      `Repository path is inside a Git repository but is not its root; register ${toplevel} instead`
    );
  }
  return path;
}

function registerRepository(args: RegisterRepositoryArgs): void {
  const repositoryPath = resolveRepositoryRoot(args.path);
  const config = createRuntimeConfig();
  const database = SqliteDatabase.open(config);
  try {
    const now = new Date().toISOString();
    const store = database.createProgressStore();
    store.transaction((tx) => {
      // Never attach a repository to an archived project, and never restore
      // it implicitly: the human restores it from the Board first.
      assertProjectNotArchived(tx.getProject(args.projectId));
      tx.upsertProject({
        project_id: args.projectId,
        name: args.projectName,
        created_at: now,
        updated_at: now
      });
      tx.upsertRepository({
        repository_id: args.repositoryId,
        project_id: args.projectId,
        path: repositoryPath,
        label: args.repositoryName,
        created_at: now,
        updated_at: now
      });
    });
    const repository = store.getRepository(args.repositoryId);
    if (repository === undefined) {
      throw new Error(`Failed to register repository ${args.repositoryId}`);
    }
    console.log(
      `Registered repository ${repository.repository_id} "${repository.label}"`
      + ` in project ${repository.project_id} at ${repository.path}`
    );
  } finally {
    database.close();
  }
}

function main(): void {
  try {
    registerRepository(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof PlatformDomainError
      ? `${error.code}: ${error.message}\n${error.recovery_actions.join("\n")}`
      : error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

main();
