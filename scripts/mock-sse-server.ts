/**
 * Mock SSE server for local dev/testing.
 *
 * Serves the same interface contract as remo-e:
 * - GET /events (text/event-stream)
 * - event name: message
 * - payload: PowerReadingEvent JSON
 * - sends last event immediately on connect
 */

import http from 'node:http';

const PORT = parseInt(process.env.MOCK_SSE_PORT || '8787', 10);
const INTERVAL_MS = parseInt(process.env.MOCK_SSE_INTERVAL_MS || '1000', 10);

type PowerReadingEvent = {
  type: 'power.reading';
  timestamp: string;
  watts: number;
  applianceId: string;
  nickname: string;
  sourceHost?: string;
};

let last: PowerReadingEvent | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function makeReading(): PowerReadingEvent {
  // Simple pseudo-realistic waveform
  const t = Date.now() / 1000;
  const base = 650;
  const wave = Math.round(180 * Math.sin(t / 5));
  const jitter = Math.round((Math.random() - 0.5) * 40);
  const watts = Math.max(0, base + wave + jitter);

  return {
    type: 'power.reading',
    timestamp: nowIso(),
    watts,
    applianceId: 'mock-appliance-001',
    nickname: 'Mock Remo E',
    sourceHost: 'mock-sse-server',
  };
}

function writeSSE(res: http.ServerResponse, data: object) {
  res.write('event: message\n');
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const server = http.createServer((req, res) => {
  // CORS (match remo-e default)
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (req.method === 'GET' && req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    res.write(': connected\n\n');

    if (last) {
      writeSSE(res, last);
    }

    const keepAlive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 25_000);

    const interval = setInterval(() => {
      last = makeReading();
      writeSSE(res, last);
    }, INTERVAL_MS);

    req.on('close', () => {
      clearInterval(interval);
      clearInterval(keepAlive);
    });

    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[mock-sse] listening on http://0.0.0.0:${PORT}`);
  console.log(`[mock-sse] GET /events (SSE), GET /healthz`);
  console.log(`[mock-sse] interval=${INTERVAL_MS}ms`);
});
