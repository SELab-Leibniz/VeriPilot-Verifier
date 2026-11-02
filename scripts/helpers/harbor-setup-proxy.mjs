// Temporary authenticated bootstrap networking through the host's working
// network. It is closed before the scored model phase; no provider auth here.
import http from 'node:http';
import net from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const installationHosts = ['archive.ubuntu.com', 'security.ubuntu.com', 'deb.debian.org', 'security.debian.org',
  'archive.debian.org', 'github.com', '*.github.com', '*.githubusercontent.com', 'nodejs.org', '*.nodejs.org', 'registry.npmjs.org'];
export async function createHarborSetupProxy({ bind = '0.0.0.0', advertisedHost = 'host.docker.internal',
  allowHosts = installationHosts, httpPorts = [80], connectPorts = [443], idleTimeoutMs = 30000, onRecord = async () => {} } = {}) {
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1) throw new Error('SETUP_PROXY_IDLE_TIMEOUT_INVALID');
  const capability = randomBytes(32).toString('hex');
  const auth = 'Basic ' + Buffer.from('rc-setup:' + capability).toString('base64');
  const sockets = new Set(), records = [], startedAt = Date.now(); let closing, closed = false, closedAt, socketsClosedAt, reports = Promise.resolve();
  const authenticated = request => {
    const actual = request.headers['proxy-authorization'] ?? '';
    return typeof actual === 'string' && Buffer.byteLength(actual) === Buffer.byteLength(auth)
      && timingSafeEqual(Buffer.from(actual), Buffer.from(auth));
  };
  const allowed = hostname => allowHosts.some(host => host.startsWith('*.')
    ? hostname.endsWith(host.slice(1)) && hostname !== host.slice(2) : hostname === host);
  const report = () => { const value = { startedAt, closed, closedAt, socketsClosedAt, records: structuredClone(records) }; reports = reports.then(() => onRecord(value)); return reports; };
  const observe = value => { records.push(value); return report(); };
  const server = http.createServer(async (request, response) => {
    if (closed || !authenticated(request)) {
      response.writeHead(407, { 'proxy-authenticate': 'Basic realm="rc-setup"' }); response.end(); return;
    }
    let url;
    try { url = new URL(request.url); } catch { response.writeHead(400); response.end(); return; }
    if (url.protocol !== 'http:' || url.username || url.password || !allowed(url.hostname)
      || !httpPorts.includes(Number(url.port || 80)) || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(403); response.end(); return;
    }
    const headers = { ...request.headers }; delete headers['proxy-authorization']; delete headers['proxy-connection'];
    headers.host = url.host;
    const upstream = http.request(url, { method: request.method, headers }, incoming => {
      observe({ method: request.method, host: url.hostname, status: incoming.statusCode }).catch(() => {});
      response.writeHead(incoming.statusCode, incoming.headers); incoming.on('error', () => response.destroy()); incoming.pipe(response);
    });
    upstream.setTimeout(idleTimeoutMs, () => upstream.destroy(new Error('SETUP_PROXY_NETWORK_TIMEOUT')));
    upstream.on('socket', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    response.on('close', () => upstream.destroy()); request.on('error', () => upstream.destroy()); request.pipe(upstream);
  });
  server.on('connect', (request, client, head) => {
    client.on('error', () => {});
    if (closed || !authenticated(request)) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="rc-setup"\r\nConnection: close\r\n\r\n'); return;
    }
    let target;
    try { target = new URL('https://' + request.url); } catch { client.destroy(); return; }
    const port = Number(target.port || 443);
    if (!allowed(target.hostname) || !connectPorts.includes(port) || target.username || target.password
      || target.pathname !== '/' || target.search || target.hash) { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    const upstream = net.connect({ host: target.hostname, port }); sockets.add(upstream);
    upstream.once('close', () => sockets.delete(upstream));
    upstream.setTimeout(idleTimeoutMs, () => { upstream.destroy(); client.destroy(); });
    upstream.once('connect', () => {
      observe({ method: 'CONNECT', host: target.hostname, port }).catch(() => {});
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client);
    });
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
    client.once('close', () => upstream.destroy());
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, bind, resolve); });
  return {
    url: `http://rc-setup:${capability}@${advertisedHost}:${server.address().port}`,
    snapshot: () => ({ startedAt, closed, closedAt, socketsClosedAt, records: structuredClone(records), activeSockets: sockets.size }),
    close() { return closing ??= (async () => {
      closed = true; closedAt = Date.now();
      const pending = [...sockets].map(socket => new Promise(resolve => {
        if (socket.closed) resolve(); else { socket.once('close', resolve); socket.destroy(); }
      }));
      await Promise.all([new Promise(resolve => server.close(resolve)), ...pending]); socketsClosedAt = Date.now(); await report();
    })(); },
  };
}
