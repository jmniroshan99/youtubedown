import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

test('real Caddy local gateway forwards auth/CORS and reports an unavailable upstream honestly', { skip: !process.env.CADDY_TEST_BINARY }, async () => {
  const received = [];
  const backend = http.createServer((request, response) => {
    received.push({ method: request.method, path: request.url, authorization: request.headers.authorization, origin: request.headers.origin, forwarded: request.headers['x-forwarded-for'] });
    response.setHeader('Content-Type', 'application/json');
    if (request.headers.origin === 'http://127.0.0.1:5173') {
      response.setHeader('Access-Control-Allow-Origin', request.headers.origin);
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    }
    response.end(JSON.stringify({ status: 'ready' }));
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const gatewayPort = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const folder = await mkdtemp(join(tmpdir(), 'videoflow-gateway-'));
  let child;
  try {
    const source = await readFile(new URL('../Caddyfile.local', import.meta.url), 'utf8');
    const config = source.replace(':8080 {', `http://127.0.0.1:${gatewayPort} {`).replace('api:8000', `127.0.0.1:${backend.address().port}`);
    await writeFile(join(folder, 'Caddyfile'), config);
    child = spawn(process.env.CADDY_TEST_BINARY, ['run', '--config', join(folder, 'Caddyfile'), '--adapter', 'caddyfile'], { stdio: 'ignore' });
    const base = `http://127.0.0.1:${gatewayPort}`;
    let ready = false;
    for (let i = 0; i < 50; i++) {
      if (child.exitCode !== null) throw new Error('Gateway exited during startup');
      try { ready = (await fetch(`${base}/health`)).ok; } catch {}
      if (ready) break;
      await delay(50);
    }
    assert.equal(ready, true);
    const response = await fetch(`${base}/api/downloads`, { headers: { Authorization: 'Bearer fixture-token', Origin: 'http://127.0.0.1:5173', 'X-Forwarded-For': '198.51.100.99' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(received.at(-1), { method: 'GET', path: '/api/downloads', authorization: 'Bearer fixture-token', origin: 'http://127.0.0.1:5173', forwarded: '127.0.0.1' });
    const preflight = await fetch(`${base}/api/analyze`, { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:5173', 'Access-Control-Request-Method': 'POST' } });
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173');
    backend.closeAllConnections();
    await new Promise(resolve => backend.close(resolve));
    const offline = await fetch(`${base}/health`);
    assert.equal(offline.status, 503);
    assert.equal(offline.headers.get('cache-control'), 'private, no-store');
    assert.equal((await offline.json()).status, 'gateway_unavailable');
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM'); await exited;
    }
    backend.closeAllConnections(); backend.close();
    await rm(folder, { recursive: true, force: true });
  }
});
