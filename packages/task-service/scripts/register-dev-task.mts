import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "zcode-controller", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:47321/mcp"));
await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);

const ctx = await client.callTool({
  name: "session_context",
  arguments: {
    workspace_path: "/Users/macmini/playground/cli-session-task-mcp",
    repository_id: "cli-session-task-mcp",
    worktree_path: "/Users/macmini/playground/cli-session-task-mcp"
  }
});
const ctxText = (ctx.content as { type: string; text?: string }[])
  .filter((part) => part.type === "text")
  .map((part) => part.text ?? "")
  .join("");
const ctxData = JSON.parse(ctxText) as { session_id?: string; data?: { session_id?: string } };
const sessionId = ctxData.session_id ?? ctxData.data?.session_id;
if (sessionId === undefined) {
  console.error("session_context raw:", ctxText.slice(0, 300));
  throw new Error("session_id not found in session_context response");
}
console.log("session:", sessionId.slice(0, 8));

const created = await client.callTool({
  name: "task_create",
  arguments: {
    session_id: sessionId,
    operation_id: `zcode-register-${Date.now()}`,
    expected_version: 0,
    repository_id: "cli-session-task-mcp",
    title: "MCP 写工具会话绑定与租约持有校验",
    goal: "防止 Agent 冒用其他会话 ID 执行写操作：写工具校验 transport↔session 绑定，checkpoint/submit 校验租约持有者",
    acceptance_criteria: [
      "全部写工具拒绝与非本 transport 绑定的 session_id（稳定错误码）",
      "checkpoint/submit 在存在租约时校验调用方为租约持有者",
      "集成测试覆盖冒用场景，全量测试通过"
    ],
    next_action: "在 register-tools 写 handler 增加绑定校验并在 task-service 增加租约持有校验",
    priority: "P1"
  }
});
const createdText = (created.content as { type: string; text?: string }[])
  .filter((part) => part.type === "text")
  .map((part) => part.text ?? "")
  .join("");
console.log("created:", createdText.slice(0, 250));

await transport.close();
process.exit(0);
