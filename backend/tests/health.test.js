import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/ensure-test-env.js';
import app from '../src/app.js';

let server;
let baseUrl;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('GET /api/health returns 200 with the standard body', async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'contract-guard-api');
  assert.equal(typeof body.uptimeSeconds, 'number');
  assert.ok(!Number.isNaN(Date.parse(body.timestamp)));
});

test('unknown routes return the JSON 404 envelope', async () => {
  const res = await fetch(`${baseUrl}/api/definitely-not-a-route`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.code, 'NOT_FOUND');
  assert.match(body.error.message, /^Cannot GET /);
});

test('malformed JSON bodies are rejected with a JSON 4xx error', async () => {
  const res = await fetch(`${baseUrl}/api/health`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'INVALID_JSON');
});
