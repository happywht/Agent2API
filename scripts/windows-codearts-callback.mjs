import { readFileSync } from 'node:fs';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const HOST = '127.0.0.1';
const LOGIN = '/api/session/login';
const PROVIDERS = {
  'https://codearts.huaweicloud.com/portal/authorize': {
    redirectParameter: 'auth_callback_url',
    callbackPath: '/oauth/callback',
    verifyPortParameter: true,
  },
  'https://auth.openai.com/api/accounts/authorize': {
    redirectParameter: 'redirect_uri',
    callbackPath: '/auth/callback',
    verifyPortParameter: false,
  },
};

function send(response, status, value) {
  const json = typeof value !== 'string';
  const body = Buffer.from(json ? JSON.stringify(value) : value);
  response.writeHead(status, {
    'Content-Type': `${json ? 'application/json' : 'text/plain'}; charset=utf-8`,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  });
  response.end(body);
}

function callbackTarget(login) {
  const authorization = login?.url || login?.authUrl;
  if (!login?.manualCallback || !authorization || !login.state) return;
  const portal = new URL(authorization);
  const provider = PROVIDERS[portal.origin + portal.pathname];
  if (!provider) return;
  const rawRedirect = portal.searchParams.get(provider.redirectParameter);
  const redirect = new URL(rawRedirect ?? '');
  const port = Number(redirect.port);
  if (
    !Number.isInteger(port) || port < 1024 || port > 65535
    || rawRedirect !== `http://${HOST}:${port}${provider.callbackPath}`
    || (provider.verifyPortParameter && portal.searchParams.get('port') !== String(port))
  ) {
    throw new Error('Invalid loopback callback address');
  }
  return { port, path: provider.callbackPath };
}

function listenForCallback(listeners, postLogin, login, { port, path }) {
  const authority = `${HOST}:${port}`;
  const origin = `http://${authority}`;
  let busy = false;
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'GET' || request.headers.host !== authority || !request.url.startsWith(`${path}?`)) {
      send(response, 404, 'Waiting for the authorization callback.');
      return;
    }
    const target = new URL(request.url, origin);
    if (!target.searchParams.get('state') || !(target.searchParams.get('code') || target.searchParams.get('error'))) {
      send(response, 404, 'Waiting for the authorization callback.');
      return;
    }
    if (busy) {
      send(response, 409, 'The callback is being processed. Return to Agent2API.');
      return;
    }
    busy = true;
    try {
      const accepted = await postLogin('callback', { state: login.state, callbackUrl: target.href });
      if (!accepted) {
        send(response, 400, 'The callback was rejected. Check the login status in Agent2API.');
        return;
      }
      send(response, 200, 'Callback received. Return to Agent2API to check the account.');
      server.close();
    } catch {
      if (!response.headersSent) send(response, 502, 'Cannot submit the callback. Retry from Agent2API.');
    } finally {
      busy = false;
    }
  });
  server.headersTimeout = 5000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      listeners.add(server);
      const timeout = Math.max(1000, Math.min(Number(login.timeoutMs) || 300000, 300000));
      const timer = setTimeout(() => server.close(), timeout);
      timer.unref();
      server.once('close', () => {
        clearTimeout(timer);
        listeners.delete(server);
      });
      resolve();
    });
  });
}

export function createPanelProxy({ upstreamPort, adminKey }) {
  const listeners = new Set();
  async function postLogin(operation, payload) {
    const result = await fetch(`http://${HOST}:${upstreamPort}${LOGIN}/${operation}`, {
      method: 'POST',
      headers: { 'x-api-key': adminKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
    return result.ok && (await result.json()).success === true;
  }

  async function forwardLogin(upstream, response) {
    let login;
    let target;
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of upstream) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) throw new Error('Login response too large');
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      if (upstream.statusCode === 200 && upstream.headers['content-type']?.includes('application/json')) {
        login = JSON.parse(body).data;
        target = callbackTarget(login);
        if (target) await listenForCallback(listeners, postLogin, login, target);
      }
      response.writeHead(upstream.statusCode, upstream.headers);
      response.end(body);
    } catch (error) {
      if (login?.state) void postLogin('cancel', { state: login.state }).catch(() => {});
      if (!response.headersSent) {
        const message = target && error?.code === 'EADDRINUSE'
          ? `Local callback port ${target.port} is already in use. Close the app using it and restart the login.`
          : 'Cannot open the local callback port. Restart the login.';
        send(response, 502, { success: false, message });
      } else {
        response.destroy();
      }
    }
  }

  const panel = http.createServer((browser, response) => {
    const port = browser.socket.localPort;
    if (![`${HOST}:${port}`, `localhost:${port}`].includes(browser.headers.host)) {
      send(response, 400, { success: false, message: 'Use the local panel address.' });
      return;
    }
    const loginStart = browser.method === 'POST' && browser.url === `${LOGIN}/start`;
    const headers = { ...browser.headers };
    if (loginStart) headers['accept-encoding'] = 'identity';
    const upstream = http.request({
      host: HOST, port: upstreamPort, method: browser.method, path: browser.url, headers,
    }, (result) => {
      if (loginStart) {
        void forwardLogin(result, response);
        return;
      }
      response.writeHead(result.statusCode, result.headers);
      result.on('error', () => response.destroy());
      result.pipe(response);
    });
    upstream.on('error', () => {
      if (!response.headersSent) send(response, 502, { success: false, message: 'Agent2API is unavailable.' });
      else response.destroy();
    });
    response.on('close', () => upstream.destroy());
    browser.pipe(upstream);
  });
  panel.on('close', () => {
    for (const callback of listeners) callback.close();
  });
  return panel;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const envFile = readFileSync('.env', 'utf8');
  const configuredKey = (name) => {
    const value = new RegExp(`^\\s*${name}\\s*=([^\\r\\n]+)`, 'm').exec(envFile)?.[1].trim();
    return value?.replace(/^(['"])(.*)\1$/, '$2');
  };
  const adminKey = process.env.AGENT2API_PROXY_API_KEY
    || configuredKey('AGENT2API_PROXY_API_KEY') || configuredKey('A2_MANAGEMENT_KEY');
  if (!adminKey) throw new Error('Set AGENT2API_PROXY_API_KEY in the deployment .env file.');
  const panel = createPanelProxy({ upstreamPort: 18082, adminKey });
  panel.listen(18080, HOST);
}
