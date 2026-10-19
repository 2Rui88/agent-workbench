import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { CoordinatorError } from '../errors.js';

export interface ToolInvoker { call(name: string, args: Record<string, unknown>): Promise<unknown>; }
export class McpTools implements ToolInvoker {
  private readonly client = new Client({ name: 'codex-session-coordinator', version: '0.1.0' });
  private readonly names = new Set<string>();
  async connect(url: string, headers: Record<string, string> = {}): Promise<void> {
    const endpoint = new URL(url);
    if (endpoint.username || endpoint.password || !['http:', 'https:'].includes(endpoint.protocol)) throw new CoordinatorError('INVALID_INPUT', 'Invalid MCP endpoint.', 'Use a service URL without embedded credentials.');
    await this.client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers, redirect: 'error' } }));
    const result = await this.client.listTools();
    for (const tool of result.tools) this.names.add(tool.name);
  }
  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.names.has(name)) throw new CoordinatorError('COMMAND_NOT_FOUND', `MCP tool is unavailable: ${name}`, 'Verify the live tools/list contract.');
    const result = await this.client.callTool({ name, arguments: args });
    if (result.isError) throw new CoordinatorError('TASK_GATE_CLOSED', `MCP tool rejected the request: ${name}`, 'Inspect the current identity and tool contract.');
    if (result.structuredContent) return result.structuredContent;
    const block = result.content.find((item) => item.type === 'text');
    if (!block || block.type !== 'text') throw new CoordinatorError('SERVICE_UNHEALTHY', 'MCP returned no structured result.', 'Verify the server protocol.');
    return JSON.parse(block.text) as unknown;
  }
  async close(): Promise<void> { await this.client.close(); }
}
