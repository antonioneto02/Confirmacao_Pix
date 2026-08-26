// Rodado via "docker exec <container> node supervisor-trigger.js" pelo
// dashboard -- de dentro do container, chama o supervisor local pra
// reiniciar so o processo do app, sem tocar em rede/HCS do container.
const http = require('http');

function trigger() {
  const req = http.request(
    { host: '127.0.0.1', port: 9998, path: '/__restart', method: 'POST', timeout: 5000 },
    (res) => { console.log('restart-trigger status:', res.statusCode); process.exit(res.statusCode === 200 ? 0 : 1); }
  );
  req.on('error', (e) => { console.error('restart-trigger erro:', e.message); process.exit(1); });
  req.on('timeout', () => { console.error('restart-trigger timeout'); req.destroy(); process.exit(1); });
  req.end();
}

// So dispara quando executado direto -- se algum teste do app fizer
// require() de todo .js da pasta, isso evita chamar process.exit() durante
// o import (o que derrubaria o processo de teste inteiro).
if (require.main === module) {
  trigger();
}
