/**
 * WebSocket Server - メッセージ配信サーバー
 *
 * 使い方:
 *   npm run server
 *
 * メッセージ送信例（別ターミナルから）:
 *   curl -X POST http://localhost:8080/send \
 *     -H "Content-Type: application/json" \
 *     -d '{"type":"text","content":"Hello!","sound":"default"}'
 *
 * Notes:
 * - dist/ が存在する場合は、/ でPWA（ビルド成果物）を配信する。
 * - /events は remo-e の SSE をローカルへプロキシする（同一オリジン化のため）。
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer, IncomingMessage, ServerResponse, request as httpRequest } from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import net from 'node:net';

const PORT = parseInt(process.env.PORT || '8080', 10);
const REMOE_SSE_TARGET = process.env.REMOE_SSE_TARGET || 'http://127.0.0.1:8787/events';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.resolve(__dirname, '..', 'dist');

// 接続中のクライアント
const clients = new Set<WebSocket>();

function checkUpstreamReachable(): void {
  try {
    const u = new URL(REMOE_SSE_TARGET);
    const host = u.hostname;
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));

    const socket = net.connect({ host, port });
    const timeoutMs = 700;

    const done = (ok: boolean, msg?: string) => {
      socket.removeAllListeners();
      socket.end();
      socket.destroy();
      if (!ok) {
        console.warn(`[warn] REMOE_SSE_TARGET is not reachable: ${REMOE_SSE_TARGET}${msg ? ' (' + msg + ')' : ''}`);
        console.warn('[warn] /events will return 502 until remo-e is running');
      }
    };

    socket.setTimeout(timeoutMs);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false, `timeout ${timeoutMs}ms`));
    socket.on('error', (err) => done(false, err instanceof Error ? err.message : String(err)));
  } catch (err) {
    console.warn('[warn] invalid REMOE_SSE_TARGET:', REMOE_SSE_TARGET, err);
  }
}

function hasDist(): boolean {
  try {
    return fs.existsSync(path.join(distDir, 'index.html'));
  } catch {
    return false;
  }
}

function contentTypeFor(p: string): string {
  const ext = path.extname(p).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.ico':
      return 'image/x-icon';
    default:
      return 'application/octet-stream';
  }
}

function serveFile(res: ServerResponse, filePath: string): void {
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
  res.writeHead(200, { 'Content-Type': contentTypeFor(filePath) });
  stream.pipe(res);
}

function servePWA(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (!hasDist()) return false;

  const url = new URL(req.url || '/', 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  // Static file under dist.
  const candidate = path.normalize(path.join(distDir, pathname));
  if (candidate.startsWith(distDir) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    serveFile(res, candidate);
    return true;
  }

  // SPA fallback.
  serveFile(res, path.join(distDir, 'index.html'));
  return true;
}

function serveAdminUI(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`
<!DOCTYPE html>
<html>
<head>
  <title>Display Server Admin</title>
  <meta charset="UTF-8">
  <style>
    body { font-family: system-ui; max-width: 760px; margin: 2rem auto; padding: 1rem; }
    h1 { font-size: 1.5rem; }
    .status { background: #f0f0f0; padding: 1rem; border-radius: 8px; margin: 1rem 0; }
    form { display: flex; flex-direction: column; gap: 0.5rem; }
    textarea { height: 140px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    button { padding: 0.5rem 1rem; cursor: pointer; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .presets { display: flex; gap: 0.5rem; flex-wrap: wrap; margin: 1rem 0; }
    .presets button { font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>📺 Display Server Admin</h1>
  <div class="status">
    <div><strong>接続クライアント:</strong> <span id="clients">-</span></div>
    <div><strong>REMOE SSE target:</strong> <code id="sse">-</code></div>
  </div>

  <h3>メッセージ送信</h3>
  <div class="presets">
    <button onclick="sendPreset('text')">テキスト</button>
    <button onclick="sendPreset('alert')">アラート</button>
    <button onclick="sendPreset('clear')">クリア</button>
  </div>

  <form onsubmit="sendMessage(event)">
    <textarea id="message" placeholder='{"type":"text","content":"Hello!","sound":"default"}'></textarea>
    <button type="submit">送信</button>
  </form>

  <script>
    const presets = {
      text: { type: 'text', content: 'Hello, World!', style: { fontSize: 'large' }, sound: 'default', duration: 5000 },
      alert: { type: 'alert', title: '警告', body: 'これはアラートです', sound: 'alert' },
      clear: { type: 'clear' }
    };

    function sendPreset(name) {
      document.getElementById('message').value = JSON.stringify(presets[name], null, 2);
    }

    async function sendMessage(e) {
      e.preventDefault();
      const text = document.getElementById('message').value;
      try {
        const res = await fetch('/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: text
        });
        const data = await res.json();
        if (!data.ok) alert('Error: ' + data.error);
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }

    async function updateStatus() {
      try {
        const res = await fetch('/status');
        const data = await res.json();
        document.getElementById('clients').textContent = data.clients;
        document.getElementById('sse').textContent = data.remoeSseTarget;
      } catch (err) {}
    }

    updateStatus();
    setInterval(updateStatus, 3000);
  </script>
</body>
</html>
  `);
}

function proxyRemoESSE(req: IncomingMessage, res: ServerResponse): void {
  const base = new URL(REMOE_SSE_TARGET);
  const url = new URL(req.url || '/events', 'http://localhost');

  const target = new URL(base.toString());
  target.search = url.search;

  // Build headers without undefined values (Node rejects invalid header values).
  const headers: Record<string, string> = {
    accept: String(req.headers['accept'] || 'text/event-stream'),
  };
  if (typeof req.headers['cache-control'] === 'string' && req.headers['cache-control']) {
    headers['cache-control'] = req.headers['cache-control'];
  }
  if (typeof req.headers['last-event-id'] === 'string' && req.headers['last-event-id']) {
    headers['last-event-id'] = req.headers['last-event-id'];
  }

  const upstream = httpRequest(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: 'GET',
      path: target.pathname + target.search,
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode || 502, {
        ...up.headers,
        // Force CORS open (PWA may be hosted elsewhere during dev).
        'access-control-allow-origin': '*',
      });
      up.pipe(res);
    },
  );

  upstream.on('error', (err) => {
    console.error('[SSE proxy] upstream error:', err);
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('upstream error: ' + (err instanceof Error ? err.message : String(err)));
  });

  req.on('close', () => upstream.destroy());
  upstream.end();
}

// HTTPサーバー（REST API + PWA配信 + SSEプロキシ）
const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', 'http://localhost');

  // GET /events - proxied SSE (remo-e)
  if (req.method === 'GET' && url.pathname === '/events') {
    proxyRemoESSE(req, res);
    return;
  }

  // POST /send - メッセージ送信
  if (req.method === 'POST' && url.pathname === '/send') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const message = JSON.parse(body);
        broadcast(message);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, clients: clients.size }));
      } catch (err) {
        console.error('[HTTP] /send invalid JSON:', err);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // GET /status - 状態確認
  if (req.method === 'GET' && url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        clients: clients.size,
        uptime: process.uptime(),
        remoeSseTarget: REMOE_SSE_TARGET,
        servingDist: hasDist(),
      }),
    );
    return;
  }

  // GET /admin - 簡易送信UI
  if (req.method === 'GET' && url.pathname === '/admin') {
    serveAdminUI(req, res);
    return;
  }

  // If dist exists, serve the PWA at /
  if (servePWA(req, res)) {
    return;
  }

  // Fallback root: show admin UI when dist isn't built.
  if (req.method === 'GET' && url.pathname === '/') {
    serveAdminUI(req, res);
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// WebSocket サーバー
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  console.log(`[WS] Client connected from ${req.socket.remoteAddress}`);
  clients.add(ws);

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      console.log('[WS] Received:', message);

      // クライアントからのステータスは無視（必要なら処理追加）
      if (message.type === 'hello' || message.type === 'status') {
        return;
      }

      // それ以外はブロードキャスト
      broadcast(message);
    } catch (err) {
      console.error('[WS] Invalid message:', err);
    }
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected');
    clients.delete(ws);
  });

  ws.on('error', (err) => {
    console.error('[WS] Error:', err);
    clients.delete(ws);
  });
});

/**
 * 全クライアントにメッセージを送信
 */
function broadcast(message: object): void {
  const data = JSON.stringify(message);
  console.log(`[WS] Broadcasting to ${clients.size} clients:`, message);

  clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });
}

// サーバー起動
const HOST = process.env.HOST || '127.0.0.1';

httpServer.listen(PORT, HOST, () => {
  console.log(`
╔════════════════════════════════════════════════╗
║         Display Server Started                 ║
╠════════════════════════════════════════════════╣
║  HTTP:      http://${HOST}:${PORT}              ║
║  WebSocket: ws://${HOST}:${PORT}                ║
╠════════════════════════════════════════════════╣
║  Endpoints:                                    ║
║    GET  /        - PWA (if dist/ exists)       ║
║    GET  /admin   - Admin UI (send messages)    ║
║    GET  /events  - Proxy to remo-e SSE         ║
║    GET  /status  - Server status               ║
║    POST /send    - Send message                ║
╚════════════════════════════════════════════════╝
  `);

  console.log('[info] REMOE_SSE_TARGET:', REMOE_SSE_TARGET);
  checkUpstreamReachable();
});
