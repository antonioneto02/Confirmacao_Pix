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

if (require.main === module) {
  trigger();
}
