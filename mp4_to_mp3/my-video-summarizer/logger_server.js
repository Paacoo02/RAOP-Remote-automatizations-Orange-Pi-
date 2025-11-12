// Ejecuta: node logger_server.js
const http = require('http');
const url = require('url');
const PORT = Number(process.env.PORT || 8765);
const HOST = '0.0.0.0'; // escucha en todas las interfaces

function ok(res, obj = { ok: true }) {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    // CORS para poder probar también desde páginas normales:
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);

  if (req.method === 'OPTIONS') return ok(res); // preflight CORS

  if (u.pathname === '/log' && req.method === 'GET') {
    const ts = new Date().toISOString();
    const { tag = 'EXT', msg = '', extra = '' } = u.query;
    console.log(`[${ts}] [${tag}] ${msg} ${extra}`);
    return ok(res);
  }

  if (u.pathname === '/log' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const ts = new Date().toISOString();
        const tag = payload.tag || 'EXT';
        const msg = payload.msg || '';
        const extra = payload.extra ? JSON.stringify(payload.extra) : '';
        console.log(`[${ts}] [${tag}] ${msg} ${extra}`);
      } catch {
        console.log(`[WARN] payload no JSON: ${body}`);
      }
      return ok(res);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`> Logger escuchando en http://${HOST}:${PORT}/log`);
  console.log('  Deja este proceso corriendo para ver los logs del background aquí.');
});