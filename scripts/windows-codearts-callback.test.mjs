import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { test } from 'node:test';
import { createPanelProxy } from './windows-codearts-callback.mjs';

const host = '127.0.0.1';
const managementKey = 'test-management-key';
const loginPath = '/api/session/login';

async function startServer(server) {
  server.listen(0, host);
  await once(server, 'listening');
  return server.address().port;
}

async function stopServer(server) {
  if (server.listening) {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function unusedPort() {
  const server = http.createServer();
  const port = await startServer(server);
  await stopServer(server);
  return port;
}

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

async function fixture(t, loginResponses) {
  const callbacks = [];
  const cancellations = [];
  const upstream = http.createServer(async (request, response) => {
    if (request.url === `${loginPath}/start`) {
      json(response, 200, { success: true, data: loginResponses.shift() });
    } else if (request.url === `${loginPath}/callback`) {
      assert.equal(request.headers['x-api-key'], managementKey);
      callbacks.push(await readJson(request));
      json(response, 200, { success: true, data: { accepted: true } });
    } else if (request.url === `${loginPath}/cancel`) {
      assert.equal(request.headers['x-api-key'], managementKey);
      cancellations.push(await readJson(request));
      json(response, 200, { success: true });
    } else {
      json(response, 200, { success: true, path: request.url });
    }
  });
  const upstreamPort = await startServer(upstream);
  const panel = createPanelProxy({ upstreamPort, adminKey: managementKey });
  const panelPort = await startServer(panel);
  t.after(async () => {
    panel.closeAllConnections();
    upstream.closeAllConnections();
    await stopServer(panel);
    await stopServer(upstream);
  });
  return { panelPort, callbacks, cancellations };
}

function login(port, state) {
  const url = new URL('https://codearts.huaweicloud.com/portal/authorize');
  url.searchParams.set('port', String(port));
  url.searchParams.set('auth_callback_url', `http://${host}:${port}/oauth/callback`);
  return { manualCallback: true, state, url: url.href, timeoutMs: 10000 };
}

async function startLogin(panelPort, provider = 'codearts') {
  return fetch(`http://${host}:${panelPort}${loginPath}/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider, methodIndex: 1 }),
  });
}

test('concurrent CodeArts logins bind their own ports before forwarding callbacks', async (t) => {
  const firstPort = await unusedPort();
  let secondPort = await unusedPort();
  while (secondPort === firstPort) secondPort = await unusedPort();
  const context = await fixture(t, [login(firstPort, 'flow-one'), login(secondPort, 'flow-two')]);

  const first = await startLogin(context.panelPort);
  const second = await startLogin(context.panelPort);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);

  for (const port of [firstPort, secondPort]) {
    const probe = await fetch(`http://${host}:${port}/oauth/callback`);
    assert.equal(probe.status, 404);
  }

  const callbackUrl = `http://${host}:${secondPort}/oauth/callback?code=example-code&state=example-state`;
  const callback = await fetch(callbackUrl);
  assert.equal(callback.status, 200);
  assert.deepEqual(context.callbacks, [{ state: 'flow-two', callbackUrl }]);
  await assert.rejects(fetch(callbackUrl));

  const firstUrl = `http://${host}:${firstPort}/oauth/callback?code=other-code&state=other-state`;
  assert.equal((await fetch(firstUrl)).status, 200);
  assert.deepEqual(context.callbacks[1], { state: 'flow-one', callbackUrl: firstUrl });
  assert.equal(context.callbacks.length, 2);
});

test('occupied callback port rejects and cancels the login without stopping the panel', async (t) => {
  const occupied = http.createServer();
  const port = await startServer(occupied);
  t.after(() => stopServer(occupied));
  const context = await fixture(t, [login(port, 'blocked-flow')]);

  const result = await startLogin(context.panelPort);
  assert.equal(result.status, 502);
  for (let count = 0; count < 30 && context.cancellations.length === 0; count++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(context.cancellations, [{ state: 'blocked-flow' }]);
  assert.equal((await fetch(`http://${host}:${context.panelPort}/api/panel/status`)).status, 200);
});

test('other provider login links pass through without opening a callback listener', async (t) => {
  const port = await unusedPort();
  const otherLogin = {
    manualCallback: true,
    state: 'other-provider',
    url: `https://other.example/authorize?port=${port}`,
  };
  const context = await fixture(t, [otherLogin]);
  const response = await startLogin(context.panelPort);

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, otherLogin);
  const probe = http.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, host, resolve);
  });
  await stopServer(probe);
  assert.equal(context.callbacks.length, 0);
  assert.equal(context.cancellations.length, 0);
});

test('ChatGPT subscription redirects /auth/callback to its own login flow', async (t) => {
  const port = await unusedPort();
  const authorization = new URL('https://auth.openai.com/api/accounts/authorize');
  authorization.searchParams.set('redirect_uri', `http://${host}:${port}/auth/callback`);
  const context = await fixture(t, [{
    manualCallback: true,
    state: 'chatgpt-flow',
    url: authorization.href,
    timeoutMs: 10000,
  }]);

  const start = await startLogin(context.panelPort, 'chatgpt-subscription');
  assert.equal(start.status, 200);
  const wrongPath = await fetch(`http://${host}:${port}/oauth/callback?code=wrong&state=wrong`);
  assert.equal(wrongPath.status, 404);
  assert.deepEqual(context.callbacks, []);

  const callbackUrl = `http://${host}:${port}/auth/callback?code=chatgpt-code&state=chatgpt-state`;
  const callback = await fetch(callbackUrl);
  assert.equal(callback.status, 200);
  assert.deepEqual(context.callbacks, [{ state: 'chatgpt-flow', callbackUrl }]);
  await assert.rejects(fetch(callbackUrl));
});
