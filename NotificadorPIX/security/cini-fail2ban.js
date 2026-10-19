'use strict';
const fs   = require('fs');
const path = require('path');
const LOG_DIR = process.env.F2B_LOG_DIR || path.join(__dirname, '..', 'logs', 'security');
const KEEP_DAYS = 14;
const SCANNER_PATTERNS = [
  /\/\.(env|git|svn|hg|aws|ssh|docker|vscode|idea|htaccess|htpasswd|DS_Store)(\/|$|\.)/i,
  /\.(php\d?|phtml|asp|aspx|jsp|cgi|pl|sh|bak|sql|swp)$/i,
  /\/wp-(admin|login|content|includes|config)/i,
  /\/(phpmyadmin|pma|myadmin|adminer|xmlrpc|cgi-bin|boaform|HNAP1|actuator|solr|jenkins|manager\/html|server-status|telescope|_ignition)(\/|$)/i,
  /\/vendor\/phpunit/i,
  /\/(config|credentials|secrets|backup|dump|database)\.(json|ya?ml|xml|ini|zip|tar|gz|rar)$/i,
  /(\.\.\/|\.\.\\|%2e%2e(%2f|%5c|\/|\\))/i,
];

const DEFAULT_LOGIN_FAIL_REDIRECT = /[?&](error=invalid_credentials|erro=1)(&|$)/i;

const THROTTLE_MS = { SCANNER: 2 * 1000, RATE_LIMIT: 60 * 1000, LOGIN_FAIL: 0 };
const lastLogged = new Map();

function clientIp(req) {
  const ip = (req.socket && req.socket.remoteAddress) || '';
  return ip.replace(/^::ffff:/, '') || 'desconhecido';
}

const REDES_CINI = ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10',
  '177.104.136.227/32', '200.225.247.91/32', '200.225.247.159/32'];

function ipv4ParaInt(ip) {
  const p = String(ip).split('.');
  if (p.length !== 4 || p.some(x => !/^\d{1,3}$/.test(x) || +x > 255)) return null;
  return ((+p[0] << 24) >>> 0) + (+p[1] << 16) + (+p[2] << 8) + (+p[3]);
}

function ipNaRede(ip, cidr) {
  const [base, bits] = cidr.split('/');
  const a = ipv4ParaInt(ip);
  const b = ipv4ParaInt(base);
  if (a === null || b === null) return false;
  const mask = +bits === 0 ? 0 : (~0 << (32 - +bits)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

function ipDaCini(ip) {
  return ip === '::1' || REDES_CINI.some(cidr => ipNaRede(ip, cidr));
}

function clean(value, max) {
  if (value === undefined || value === null || value === '') return '-';
  return String(value).replace(/[\s"']+/g, '_').substring(0, max);
}

function hoje() {
  return new Date().toISOString().substring(0, 10);
}

let ultimaLimpeza = '';
function limparAntigos() {
  const dia = hoje();
  if (ultimaLimpeza === dia) return;
  ultimaLimpeza = dia;
  fs.readdir(LOG_DIR, (err, arquivos) => {
    if (err) return;
    const limite = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
    for (const nome of arquivos) {
      const m = /^(?:security|scanner|rate_limit|login_fail)-(\d{4}-\d{2}-\d{2})\.log$/.exec(nome);
      if (m && Date.parse(m[1]) < limite) fs.unlink(path.join(LOG_DIR, nome), () => {});
    }
  });
}

let pastaCriada = false;
function registrar(type, req, appName, user) {
  const ip = clientIp(req);
  const throttle = THROTTLE_MS[type] || 0;
  if (throttle) {
    const key = `${type}:${ip}`;
    const agora = Date.now();
    if (agora - (lastLogged.get(key) || 0) < throttle) return;
    lastLogged.set(key, agora);
    if (lastLogged.size > 5000) lastLogged.clear();
  }

  const urlPath = (req.originalUrl || req.url || '').split('?')[0];
  const linha = `${new Date().toISOString()} CINI-F2B type=${type} ip=${ip} app=${clean(appName, 60)} `
    + `user=${clean(user, 60)} path=${clean(urlPath, 200)}\n`;

  try {
    if (!pastaCriada) { fs.mkdirSync(LOG_DIR, { recursive: true }); pastaCriada = true; }
    fs.appendFile(path.join(LOG_DIR, `${type.toLowerCase()}-${hoje()}.log`), linha, () => {});
    limparAntigos();
  } catch (err) {
    console.error('[cini-fail2ban] Falha ao gravar log de seguranca:', err.message);
  }
}

function isScanner(req) {
  const raw = req.originalUrl || req.url || '';
  const urlPath = raw.split('?')[0];
  return SCANNER_PATTERNS.some(r => r.test(urlPath)) || /(\.\.\/|%2e%2e)/i.test(raw);
}

function usuarioDoBody(req) {
  const b = req.body || {};
  return b.username || b.usuario || b.login || b.user || b.email || b.codigo || b.client_id || '';
}

function guard(appName, opts = {}) {
  const loginPaths = (opts.loginPaths || []).map(p => p.toLowerCase());
  const loginFailRedirect = opts.loginFailRedirect || DEFAULT_LOGIN_FAIL_REDIRECT;
  const watchRateLimit = opts.rateLimit !== false;
  const ignorarLoginDaCini = opts.ignoreLoginFailFromCini === true;
  const maxPerMinute = opts.maxPerMinute || 0;
  const janela = new Map();

  return function ciniFail2ban(req, res, next) {
    // Sem NODE_ENV=production o tratador de erro padrao do Express devolve o stack trace (codigo,
    // caminhos) para quem fez a requisicao. So o modo do Express muda — process.env.NODE_ENV nao.
    if (req.app && req.app.get('env') !== 'production' && !process.env.F2B_MANTER_ENV_EXPRESS) req.app.set('env', 'production');
    if (isScanner(req)) {
      registrar('SCANNER', req, appName);
      return res.status(404).end();
    }

    if (maxPerMinute) {
      const ip = clientIp(req);
      const minuto = Math.floor(Date.now() / 60000);
      const atual = janela.get(ip);
      const count = atual && atual.minuto === minuto ? atual.count + 1 : 1;
      if (janela.size > 10000) janela.clear();
      janela.set(ip, { minuto, count });
      if (count > maxPerMinute) {
        if (watchRateLimit) registrar('RATE_LIMIT', req, appName);
        return res.status(429).json({ error: 'Muitas requisicoes. Tente novamente em instantes.' });
      }
    }

    const isLogin = req.method === 'POST'
      && loginPaths.includes((req.originalUrl || '').split('?')[0].replace(/\/+$/, '').toLowerCase())
      && !(ignorarLoginDaCini && ipDaCini(clientIp(req)));

    if (isLogin || watchRateLimit) {
      res.on('finish', () => {
        const status = res.statusCode;
        if (status === 429) {
          if (watchRateLimit) registrar('RATE_LIMIT', req, appName);
          return;
        }
        if (!isLogin) return;
        const location = String(res.getHeader('Location') || '');
        const falhou = status === 401 || status === 403
          || (status >= 300 && status < 400 && loginFailRedirect.test(location));
        if (falhou) registrar('LOGIN_FAIL', req, appName, usuarioDoBody(req));
      });
    }
    next();
  };
}

function logLoginFail(req, appName, user) {
  registrar('LOGIN_FAIL', req, appName, user);
}

function apenasRedeCini(appName, publicas = []) {
  const regras = publicas.map((p) => {
    if (p instanceof RegExp) return { metodo: null, testa: (c) => p.test(c) };
    const m = /^(GET|POST|PUT|PATCH|DELETE)\s+(.+)$/i.exec(p);
    const caminho = (m ? m[2] : p).replace(/\/+$/, '') || '/';
    return { metodo: m ? m[1].toUpperCase() : null, testa: (c) => c === caminho };
  });
  return function ciniApenasRede(req, res, next) {
    const ip = clientIp(req);
    if (ipDaCini(ip)) return next();
    const caminho = (req.path || '/').replace(/\/+$/, '') || '/';
    if (regras.some(r => (!r.metodo || r.metodo === req.method) && r.testa(caminho))) return next();
    registrar('RATE_LIMIT', req, appName);
    return res.status(403).json({ error: 'Acesso negado' });
  };
}

module.exports = { guard, logLoginFail, isScanner, ipDaCini, apenasRedeCini };
