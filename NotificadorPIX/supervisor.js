const { spawn } = require('child_process');
const http = require('http');
const APP_ENTRY = process.env.SUPERVISOR_APP_ENTRY || 'app.js';
const TRIGGER_PORT = 9998;

let child = null;
let restarting = false;

function startChild() {
  console.log(`[supervisor] iniciando ${APP_ENTRY}...`);
  child = spawn('C:\\nodejs\\node.exe', [APP_ENTRY], { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (restarting) {
      restarting = false;
      startChild();
      return;
    }
    console.log(`[supervisor] ${APP_ENTRY} encerrou (code=${code} signal=${signal}), container vai parar.`);
    process.exit(code || 0);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/__restart') {
    if (!child || restarting) {
      res.statusCode = 409;
      return res.end('ja reiniciando');
    }
    console.log('[supervisor] restart pedido, matando processo filho...');
    restarting = true;
    res.statusCode = 200;
    res.end('ok');
    child.kill();
    return;
  }
  res.statusCode = 404;
  res.end();
});
server.listen(TRIGGER_PORT, '127.0.0.1', () => {
  console.log(`[supervisor] gatilho de restart escutando em 127.0.0.1:${TRIGGER_PORT} (interno)`);
});

process.on('SIGINT', () => { if (child) child.kill(); process.exit(0); });
process.on('SIGBREAK', () => { if (child) child.kill(); process.exit(0); });

if (require.main === module) {
  startChild();
}
