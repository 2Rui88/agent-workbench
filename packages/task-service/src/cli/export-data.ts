/// <reference types="node" />

import { randomUUID } from "node:crypto";
import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRuntimeConfig } from "../config/runtime-config.js";

interface ExportArgs {
  output: string;
}

function usage(): string {
  return "Usage: npm run data:export -- --output <path>";
}

function parseArgs(argv: readonly string[]): ExportArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag !== "--output" || value === undefined || value.startsWith("--")) {
      throw new Error(`Unexpected arguments near "${flag ?? value ?? ""}"\n${usage()}`);
    }
    values.set(flag, value);
  }
  if (!values.has("--output")) {
    throw new Error(`Missing required flag: --output\n${usage()}`);
  }
  return { output: values.get("--output")! };
}

interface TableSpec {
  /** Export key in the JSON document. */
  key: string;
  /** Source table in the platform database. */
  table: string;
  /** Deterministic row order for reproducible exports. */
  orderBy: string;
  /** `*_json` columns decoded into friendlier keys; raw columns pass through. */
  jsonColumns: ReadonlyMap<string, string>;
}

const tableSpecs: readonly TableSpec[] = [
  {
    key: "projects",
    table: "projects",
    orderBy: "project_id",
    jsonColumns: new Map()
  },
  {
    key: "repositories",
    table: "repositories",
    orderBy: "repository_id",
    jsonColumns: new Map()
  },
  {
    key: "tasks",
    table: "tasks",
    orderBy: "task_id",
    jsonColumns: new Map([
      ["checkpoint_json", "checkpoint"],
      ["acceptance_criteria_json", "acceptance_criteria"]
    ])
  },
  {
    key: "checkpoints",
    table: "checkpoints",
    orderBy: "created_at, checkpoint_id",
    jsonColumns: new Map([["payload_json", "payload"]])
  },
  {
    key: "snapshots",
    table: "repo_snapshots",
    orderBy: "captured_at, snapshot_id",
    jsonColumns: new Map()
  },
  {
    key: "events",
    table: "task_events",
    orderBy: "created_at, event_id",
    jsonColumns: new Map([["payload_json", "payload"]])
  },
  {
    key: "session_events",
    table: "session_events",
    orderBy: "created_at, event_id",
    jsonColumns: new Map([["payload_json", "payload"]])
  },
  {
    key: "decisions",
    table: "human_decisions",
    orderBy: "created_at, decision_id",
    jsonColumns: new Map()
  },
  {
    key: "dependencies",
    table: "task_dependencies",
    orderBy: "task_id, depends_on_task_id",
    jsonColumns: new Map()
  },
  {
    key: "repair_requests",
    table: "dependency_repair_requests",
    orderBy: "created_at, repair_id",
    jsonColumns: new Map()
  }
];

type ExportRow = Record<string, unknown>;

function readRows(database: DatabaseSync, spec: TableSpec): ExportRow[] {
  return database.prepare(`SELECT * FROM ${spec.table} ORDER BY ${spec.orderBy}`)
    .all()
    .map((row) => {
      const record: ExportRow = {};
      for (const [column, value] of Object.entries(row as Record<string, unknown>)) {
        const decodedKey = spec.jsonColumns.get(column);
        if (decodedKey !== undefined) {
          if (typeof value === "string") {
            record[decodedKey] = JSON.parse(value);
          }
          continue;
        }
        record[column] = value;
      }
      if (spec.table === "task_dependencies" && record.policy === "acceptance_gate") {
        delete record.policy;
      }
      return record;
    });
}

function collectExport(databasePath: string): Record<string, unknown> {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const payload: Record<string, unknown> = {
      schema_version: Number(
        database.prepare("PRAGMA user_version").get()?.user_version ?? 0
      )
    };
    for (const spec of tableSpecs) {
      payload[spec.key] = readRows(database, spec);
    }
    return payload;
  } finally {
    database.close();
  }
}

function writeExportAtomically(outputPath: string, payload: unknown): void {
  if (existsSync(outputPath)) {
    throw new Error(`Refusing to overwrite existing output file: ${outputPath}`);
  }
  const temporaryPath = join(
    dirname(outputPath),
    `.${basename(outputPath)}.tmp-${randomUUID()}`
  );
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
      flag: "wx"
    });
    renameSync(temporaryPath, outputPath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temp file never made it to disk; nothing to clean up.
    }
    throw error;
  }
}

function main(): void {
  let args: ExportArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const config = createRuntimeConfig();
  if (!existsSync(config.databasePath)) {
    console.error(
      `No platform database found at ${config.databasePath};`
      + " start the server once (npm start) before exporting."
    );
    process.exitCode = 1;
    return;
  }

  try {
    const payload = collectExport(config.databasePath);
    writeExportAtomically(args.output, payload);
    const counts = tableSpecs.map((spec) => (
      `${spec.key}=${(payload[spec.key] as unknown[]).length}`
    )).join(" ");
    console.log(`Exported ${counts} to ${args.output}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

main();
