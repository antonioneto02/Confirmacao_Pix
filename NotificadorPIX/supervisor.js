// Supervisor leve: roda como PID 1 do container e sobe o app real como
// processo filho. "Restart" deixa de significar "docker restart" (que no
// Windows precisa desmontar/remontar HCS+HNS, a causa das travas de hoje)
// e passa a significar "avisa esse supervisor pra matar e subir o filho
// de novo" -- so um kill+spawn de processo comum, igual o PM2 sempre fez.
//
// Gatilho: POST http://127.0.0.1:9998/__restart, so acessivel de DENTRO do
// container (nao publicado no docker-compose.yml) -- o dashboard aciona via
// "docker exec <container> node supervisor-trigger.js", nunca de fora.
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
    // Saida normal (nao pedida pelo supervisor) -- propaga pro container
    // encerrar de verdade, igual seria sem supervisor nenhum.
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

// docker stop manda um sinal de parada -- deixa isso derrubar o filho e
// sair de verdade (nao e um restart pedido, o container tem que parar).
process.on('SIGINT', () => { if (child) child.kill(); process.exit(0); });
process.on('SIGBREAK', () => { if (child) child.kill(); process.exit(0); });

// So sobe o filho e o servidor de trigger quando executado direto (node
// supervisor.js) -- se algum teste do app fizer require() de todo .js da
// pasta (padrao comum pra pegar erro de sintaxe), isso evita tentar
// spawnar C:\nodejs\node.exe (so existe no host de producao) durante o
// import, o que quebrava o teste no runner Linux do CI.
if (require.main === module) {
  startChild();
}
