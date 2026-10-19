import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DashboardProjection } from './projection.js';

export async function startDashboard(options: { databasePath: string; groupId: string; port: number; webRoot: string }): Promise<{ url: string; close(): Promise<void> }> {
  const projection = new DashboardProjection(options.databasePath);
  const assets: Record<string, [string, string]> = { '/': ['dashboard.html', 'text/html'], '/dashboard.css': ['dashboard.css', 'text/css'], '/dashboard.js': ['dashboard.js', 'text/javascript'] };
  const server = createServer(async (request, response) => {
    const send = (status: number, body: string, type = 'text/plain') => {
      response.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    const address = server.address();
    if (!address || typeof address === 'string') { send(503, 'Unavailable'); return; }
    const hosts = [`127.0.0.1:${address.port}`, `localhost:${address.port}`];
    if (!hosts.includes(request.headers.host ?? '') || (request.headers.origin && !hosts.map((host) => `http://${host}`).includes(request.headers.origin))) { send(403, 'Forbidden'); return; }
    if (!['GET', 'HEAD'].includes(request.method ?? '')) { send(405, 'Method Not Allowed'); return; }
    const path = request.url?.split('?')[0] ?? '';
    if (path === '/health') { send(200, 'ok'); return; }
    if (path === '/api/snapshot') {
      try { const snapshot = projection.snapshot(options.groupId); send(snapshot ? 200 : 404, snapshot ? JSON.stringify(snapshot) : 'Group not found', snapshot ? 'application/json' : 'text/plain'); }
      catch { send(503, 'Database unavailable'); }
      return;
    }
    const asset = Object.hasOwn(assets, path) ? assets[path] : undefined;
    if (!asset) { send(404, 'Not Found'); return; }
    try { send(200, await readFile(join(options.webRoot, asset[0]), 'utf8'), asset[1]); }
    catch { send(503, 'Asset unavailable'); }
  });
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, '127.0.0.1', resolve); }); }
  catch (error) { projection.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Dashboard listener unavailable');
  return { url: `http://127.0.0.1:${address.port}/`, close: async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); projection.close(); } };
}
