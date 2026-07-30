// Smoke test for the built server: spawns dist/index.js, speaks stdio
// JSON-RPC to it, and asserts it advertises the expected read-only tools.
//
// Uses only Node built-ins so it runs on the oldest supported runtime, where
// the vitest toolchain cannot (rolldown requires ^20.19 || >=22.12). This is
// what validates the `engines` floor in CI.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED = ['get_pipeline', 'get_step_logs', 'list_instances', 'list_pipelines', 'list_repos'];

const child = spawn(process.execPath, [join(root, 'dist', 'index.js')], {
  env: {
    ...process.env,
    WOODPECKER_URL: 'https://ci.example.com',
    WOODPECKER_TOKEN: 'smoke-token',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));

const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0' },
  },
});
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_instances' } });

const fail = (message) => {
  console.error(`smoke: ${message}`);
  if (stdout) console.error(`--- stdout ---\n${stdout}`);
  if (stderr) console.error(`--- stderr ---\n${stderr}`);
  child.kill();
  process.exit(1);
};

setTimeout(() => {
  child.kill();

  const responses = stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const tools = responses.find((r) => r.id === 2)?.result?.tools;
  if (!Array.isArray(tools)) fail('tools/list returned no tools array');

  const names = tools.map((t) => t.name).sort();
  if (names.join(',') !== EXPECTED.join(',')) {
    fail(`unexpected tools: got [${names}], want [${EXPECTED}]`);
  }

  const call = responses.find((r) => r.id === 3)?.result;
  if (call?.isError) fail(`list_instances returned an error: ${call.content?.[0]?.text}`);
  if (!call?.content?.[0]?.text?.includes('ci.example.com')) {
    fail(`list_instances did not report the configured instance: ${JSON.stringify(call)}`);
  }

  // stdout is the protocol channel — anything unparseable there would corrupt it.
  const noise = stdout.split('\n').filter((l) => l.trim() && !l.trim().startsWith('{'));
  if (noise.length) fail(`non-JSON output on stdout: ${JSON.stringify(noise.slice(0, 3))}`);

  console.log(`smoke: OK on Node ${process.version} — ${names.length} tools, stdout clean`);
  process.exit(0);
}, 3000);
