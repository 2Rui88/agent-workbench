/// <reference types="node" />

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("standard systemd deployment", () => {
  it("uses a valid listener, writable data directory, and Host allowlist", () => {
    const unit = readFileSync(join(
      root,
      "deploy/systemd/cli-session-task-mcp.service"
    ), "utf8");

    expect(unit).toContain("Environment=TASK_MCP_HOST=0.0.0.0");
    expect(unit).not.toContain("TASK_MCP_HOST=0.0.0.\n");
    expect(unit).toContain(
      "Environment=TASK_MCP_DATA_DIR=/opt/cli-session-task-mcp/data"
    );
    expect(unit).toContain("Environment=TASK_MCP_ALLOWED_HOSTS=");
    expect(unit).not.toContain("TASK_MCP_LAN_PORT");
    expect(unit).toContain("EnvironmentFile=-/etc/default/cli-session-task-mcp");
    expect(unit).toContain("ProtectHome=true");
    expect(unit).toContain("ReadWritePaths=/opt/cli-session-task-mcp/data");
  });

  it("creates the service identity and grants only the data directory", () => {
    const setup = readFileSync(join(root, "deploy/setup.sh"), "utf8");

    expect(setup).toContain('SERVICE_USER="deploy"');
    expect(setup).toContain('getent group "$SERVICE_GROUP"');
    expect(setup).toContain('id -u "$SERVICE_USER"');
    expect(setup).toContain("sudo useradd");
    expect(setup).toContain(
      'sudo install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$APP_DIR/data"'
    );
    expect(setup).toContain("TASK_MCP_ALLOWED_HOSTS=%s");
  });
});
