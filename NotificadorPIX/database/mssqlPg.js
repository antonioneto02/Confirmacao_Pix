'use strict';

let mssql;
try { mssql = require('mssql'); } catch { mssql = null; }

const DIALETO = (process.env.DB_DIALECT || 'mssql').toLowerCase();
if (!['mssql', 'postgres'].includes(DIALETO)) throw new Error(`DB_DIALECT não suportado: ${DIALETO} (use mssql ou postgres).`);
const PG = DIALETO === 'postgres';
const ESQUEMAS = (process.env.PG_MODO || 'esquemas').toLowerCase() !== 'bancos';
const FUSO = process.env.PG_FUSO || 'America/Sao_Paulo';

const doisDig = (n, t = 2) => String(n).padStart(t, '0');

function literal(valor, utc = false) {
  if (valor === null || valor === undefined) return 'NULL';
  if (typeof valor === 'boolean') return valor ? '1' : '0';
  if (typeof valor === 'number') return Number.isFinite(valor) ? String(valor) : 'NULL';
  if (typeof valor === 'bigint') return valor.toString();
  if (valor instanceof Date) {
    if (Number.isNaN(valor.getTime())) return 'NULL';
    const d = utc ? new Date(valor.getTime() + valor.getTimezoneOffset() * 60000) : valor;
    return `'${d.getFullYear()}-${doisDig(d.getMonth() + 1)}-${doisDig(d.getDate())} ${doisDig(d.getHours())}:${doisDig(d.getMinutes())}:${doisDig(d.getSeconds())}.${doisDig(d.getMilliseconds(), 3)}'`;
  }
  if (Buffer.isBuffer(valor)) return `decode('${valor.toString('hex')}', 'hex')`;
  if (Array.isArray(valor)) return valor.length ? valor.map((v) => literal(v, utc)).join(', ') : 'NULL';
  const texto = typeof valor === 'object' ? JSON.stringify(valor) : String(valor);
  return `'${texto.replace(/\u0000/g, '').replace(/'/g, "''")}'`;
}

function varrer(texto, inicio, aoAchar) {
  let profundidade = 0;
  let aspas = false;
  for (let i = inicio; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      if (c === "'") { if (texto[i + 1] === "'") i++; else aspas = false; }
      continue;
    }
    if (c === "'") { aspas = true; continue; }
    if (c === '(') profundidade++;
    else if (c === ')') { if (profundidade === 0) return aoAchar(i, ')'); profundidade--; }
    else if (c === ';' && profundidade === 0) return aoAchar(i, ';');
  }
  return aoAchar(texto.length, '');
}

const fimDoEscopo = (texto, inicio) => varrer(texto, inicio, (i) => i);

function dividirComandos(texto) {
  const partes = [];
  let resto = texto;
  for (;;) {
    let profundidade = 0;
    let aspas = false;
    let corte = -1;
    for (let i = 0; i < resto.length; i++) {
      const c = resto[i];
      if (aspas) { if (c === "'") { if (resto[i + 1] === "'") i++; else aspas = false; } continue; }
      if (c === "'") aspas = true;
      else if (c === '(') profundidade++;
      else if (c === ')') profundidade--;
      else if (c === ';' && profundidade === 0) { corte = i; break; }
    }
    if (corte < 0) { if (resto.trim()) partes.push(resto); break; }
    if (resto.slice(0, corte).trim()) partes.push(resto.slice(0, corte));
    resto = resto.slice(corte + 1);
  }
  return partes;
}

function argumentos(texto, abre) {
  const args = [];
  let profundidade = 0;
  let aspas = false;
  let atual = '';
  for (let i = abre + 1; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      atual += c;
      if (c === "'") { if (texto[i + 1] === "'") { atual += texto[++i]; } else aspas = false; }
      continue;
    }
    if (c === "'") { aspas = true; atual += c; continue; }
    if (c === '(') profundidade++;
    if (c === ')') {
      if (profundidade === 0) { args.push(atual.trim()); return { args, fim: i }; }
      profundidade--;
    }
    if (c === ',' && profundidade === 0) { args.push(atual.trim()); atual = ''; continue; }
    atual += c;
  }
  throw new Error('parênteses desbalanceados no SQL');
}

function trocarFuncao(texto, nome, montar) {
  const re = new RegExp(`\\b${nome}\\s*\\(`, 'i');
  let saida = texto;
  let m;
  let guarda = 0;
  while ((m = re.exec(saida)) && guarda++ < 10000) {
    const abre = m.index + m[0].length - 1;
    const { args, fim } = argumentos(saida, abre);
    saida = saida.slice(0, m.index) + montar(args) + saida.slice(fim + 1);
  }
  return saida;
}

function trocarTop(texto) {
  const re = /\bSELECT\s+(DISTINCT\s+)?TOP\s*(\(\s*([^)]+?)\s*\)|(\d+|[@:][A-Za-z_]\w*))(\s+PERCENT)?/i;
  let saida = texto;
  let m;
  while ((m = re.exec(saida))) {
    const limite = m[3] || m[4];
    const inicio = m.index;
    const semTop = `SELECT ${m[1] || ''}`;
    saida = saida.slice(0, inicio) + semTop + saida.slice(inicio + m[0].length);
    const fim = fimDoEscopo(saida, inicio + semTop.length);
    saida = `${saida.slice(0, fim)} LIMIT ${limite}${saida.slice(fim)}`;
  }
  return saida;
}

const UNIDADES = { day: 'day', dd: 'day', d: 'day', minute: 'minute', mi: 'minute', n: 'minute', hour: 'hour', hh: 'hour', second: 'second', ss: 'second', s: 'second', month: 'month', mm: 'month', m: 'month', year: 'year', yy: 'year', yyyy: 'year', week: 'week', wk: 'week', ww: 'week', quarter: 'quarter', qq: 'quarter' };
const TIPOS_CAST = [[/\bNVARCHAR\s*\(\s*MAX\s*\)/gi, 'TEXT'], [/\bVARCHAR\s*\(\s*MAX\s*\)/gi, 'TEXT'], [/\bNVARCHAR\b/gi, 'VARCHAR'], [/\bNCHAR\b/gi, 'CHAR'], [/\bDATETIME2?\b/gi, 'TIMESTAMP'], [/\bSMALLDATETIME\b/gi, 'TIMESTAMP'], [/\bTINYINT\b/gi, 'SMALLINT'], [/\bUNIQUEIDENTIFIER\b/gi, 'UUID'], [/\bFLOAT\b/gi, 'DOUBLE PRECISION']];

function dividirVirgulas(texto) {
  const partes = [];
  let profundidade = 0;
  let aspas = false;
  let atual = '';
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) { atual += c; if (c === "'") { if (texto[i + 1] === "'") atual += texto[++i]; else aspas = false; } continue; }
    if (c === "'") { aspas = true; atual += c; continue; }
    if (c === '(') profundidade++;
    if (c === ')') profundidade--;
    if (c === ',' && profundidade === 0) { partes.push(atual.trim()); atual = ''; continue; }
    atual += c;
  }
  if (atual.trim()) partes.push(atual.trim());
  return partes;
}

function traduzirMerge(cmdOriginal) {
  let saida = null;
  const cmd = cmdOriginal.replace(/\s+OUTPUT\s+((?:inserted|deleted)\.\w+(?:\s+AS\s+\w+)?(?:\s*,\s*(?:inserted|deleted)\.\w+(?:\s+AS\s+\w+)?)*)\s*$/i, (_m, lista) => {
    saida = lista.replace(/\b(inserted|deleted)\./gi, '');
    return '';
  });
  const m = /^\s*MERGE\s+(?:INTO\s+)?([\w."]+)\s+(?:AS\s+)?(\w+)\s+USING\s*\(\s*SELECT\s+([\s\S]+?)\)\s*(?:AS\s+)?(\w+)\s+ON\s+([\s\S]+?)\s+WHEN\s+MATCHED(?:\s+AND\s+([\s\S]+?))?\s+THEN\s+UPDATE\s+SET\s+([\s\S]+?)\s+WHEN\s+NOT\s+MATCHED(?:\s+BY\s+TARGET)?\s+THEN\s+INSERT\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]+)\)\s*$/i.exec(cmd);
  if (!m) throw new Error('MERGE em formato não suportado no PostgreSQL; escreva a variante desta consulta');
  const [, tabela, alvo, usando, origem, condicao, extra, sets, colunas, valores] = m;
  if (extra || saida) {
    const fonteExtra = {};
    for (const item of dividirVirgulas(usando)) {
      const a = /^([\s\S]+?)\s+AS\s+(\w+)$/i.exec(item);
      if (!a) throw new Error(`MERGE: item do USING sem alias: ${item}`);
      fonteExtra[a[2].toLowerCase()] = a[1];
    }
    const troca = (texto) => texto.replace(new RegExp(`\\b${origem}\\.(\\w+)`, 'gi'), (inteiro, col) => (fonteExtra[col.toLowerCase()] !== undefined ? `(${fonteExtra[col.toLowerCase()]})` : inteiro));
    const setsExtra = dividirVirgulas(sets).map((s) => troca(s).replace(new RegExp(`^\\s*${alvo}\\.`, 'i'), '')).join(', ');
    const onde = troca(condicao);
    const retorno = saida ? ` RETURNING ${saida}` : ' RETURNING 1 AS __ok';
    const atualizar = `UPDATE ${tabela} AS ${alvo} SET ${setsExtra} WHERE ${onde}${extra ? ` AND (${troca(extra)})` : ''}${retorno}`;
    const inserir = `INSERT INTO ${tabela} (${colunas}) SELECT ${troca(valores)} WHERE NOT EXISTS (SELECT 1 FROM ${tabela} AS ${alvo} WHERE ${onde})${retorno}`;
    return `WITH __atualizados AS (${atualizar}), __inseridos AS (${inserir}) SELECT * FROM __atualizados UNION ALL SELECT * FROM __inseridos`;
  }
  const fonte = {};
  for (const item of dividirVirgulas(usando)) {
    const a = /^([\s\S]+?)\s+AS\s+(\w+)$/i.exec(item);
    if (!a) throw new Error(`MERGE: item do USING sem alias: ${item}`);
    fonte[a[2].toLowerCase()] = a[1];
  }
  const trocaFonte = (texto) => texto.replace(new RegExp(`\\b${origem}\\.(\\w+)`, 'gi'), (inteiro, col) => (fonte[col.toLowerCase()] !== undefined ? `(${fonte[col.toLowerCase()]})` : inteiro));
  const setsPg = dividirVirgulas(sets).map((s) => trocaFonte(s).replace(new RegExp(`^\\s*${alvo}\\.`, 'i'), '')).join(', ');
  return `WITH __atualizados AS (UPDATE ${tabela} AS ${alvo} SET ${setsPg} WHERE ${trocaFonte(condicao)} RETURNING 1) `
    + `INSERT INTO ${tabela} (${colunas}) SELECT ${trocaFonte(valores)} WHERE NOT EXISTS (SELECT 1 FROM __atualizados)`;
}

function foraDeTexto(texto, fn) {
  return texto.split(/('(?:[^']|'')*')/).map((p, i) => (i % 2 ? p : fn(p))).join('');
}

const PALAVRAS_SQL = new Set(('SELECT FROM WHERE AND OR NOT NULL IS IN AS ON JOIN LEFT RIGHT INNER OUTER FULL CROSS LATERAL GROUP BY ORDER HAVING LIMIT OFFSET UNION ALL DISTINCT CASE WHEN THEN ELSE END ' +
  'INSERT INTO VALUES UPDATE SET DELETE RETURNING WITH RECURSIVE CAST COALESCE NULLIF EXISTS BETWEEN LIKE ILIKE ESCAPE ASC DESC TRUE FALSE INTERVAL DATE TIMESTAMP TIME ZONE AT ' +
  'INTEGER INT BIGINT SMALLINT NUMERIC DECIMAL VARCHAR CHAR CHARACTER VARYING TEXT BOOLEAN DOUBLE PRECISION REAL FLOAT BYTEA UUID JSON JSONB LOCALTIMESTAMP CURRENT_DATE CURRENT_TIMESTAMP NOW ' +
  'EXTRACT EPOCH YEAR MONTH DAY HOUR MINUTE SECOND WEEK QUARTER FOR OVER PARTITION ROWS ROW FETCH NEXT ONLY FIRST LAST NULLS USING DEFAULT CONFLICT DO NOTHING ANY SOME FILTER WITHIN ' +
  'OVERRIDING SYSTEM VALUE PLACING POSITION OVERLAY SIMILAR TO BOTH LEADING TRAILING TRIM SUBSTRING IF').split(' '));

function normalizarGrafia(grafia) {
  if (!grafia) return null;
  if (grafia instanceof Map) return { tabelas: grafia, colunas: new Map(), global: grafia };
  return grafia;
}

function referencias(t, g) {
  const semTexto = t.replace(/'(?:[^']|'')*'/g, "''");
  const apelidos = new Map();
  const tabelas = [];
  for (const m of semTexto.matchAll(/\b(FROM|JOIN|INTO|UPDATE)\s+(?:"?[A-Za-z_][\w$]*"?\s*\.\s*)?("?)([A-Za-z_][\w$]*)\2(?:\s+(?:AS\s+)?("?)([A-Za-z_][\w$]*)\4)?/gi)) {
    const tabela = m[3].toLowerCase();
    if (!g.tabelas.has(tabela)) continue;
    tabelas.push(tabela);
    apelidos.set(tabela, tabela);
    if (m[5] && !PALAVRAS_SQL.has(m[5].toUpperCase()) && !g.tabelas.has(m[5].toLowerCase())) apelidos.set(m[5].toLowerCase(), tabela);
  }
  return { apelidos, tabelas };
}

function ajustarGrafia(t, grafiaBruta) {
  const g = normalizarGrafia(grafiaBruta);
  if (!g || !g.tabelas.size) return t;
  const { apelidos: aliasTabela, tabelas: usadas } = referencias(t, g);
  const apelidosSaida = new Set([...t.replace(/'(?:[^']|'')*'/g, "''").matchAll(/\bAS\s+"?([A-Za-z_][A-Za-z0-9_$]*)"?/gi)].map((m) => m[1]));
  const coluna = (nome, qualificador) => {
    const k = nome.toLowerCase();
    if (qualificador) {
      const tabela = aliasTabela.get(qualificador.toLowerCase());
      const cols = tabela && g.colunas.get(tabela);
      if (cols && cols.has(k)) return cols.get(k);
      return cols ? undefined : (g.global.get(k) || undefined);
    }
    for (const tabela of usadas) {
      const cols = g.colunas.get(tabela);
      if (cols && cols.has(k)) return cols.get(k);
    }
    const global = g.global.get(k);
    return global || undefined;
  };
  return foraDeTexto(t, (parte) => parte.replace(/(?<![\w$"])("?)([A-Za-z_][A-Za-z0-9_$]*)\1(?![\w$"])/g, (inteiro, aspas, nome, pos, todo) => {
    const antes = todo.slice(0, pos);
    const depois = todo.slice(pos + inteiro.length);
    if (/\bAS\s*$/i.test(antes) || /::\s*$/.test(antes)) return inteiro;
    if (apelidosSaida.has(nome) && !/\.\s*$/.test(antes) && /\bORDER\s+BY\b[^()]*$/i.test(antes)) return inteiro;
    if (!aspas && /^\(/.test(depois) && !/\b(INTO|FROM|JOIN|UPDATE)\s+$/i.test(antes)) return inteiro;
    if (!aspas && PALAVRAS_SQL.has(nome.toUpperCase())) return inteiro;
    const k = nome.toLowerCase();
    if (/^\s*\./.test(depois) && g.esquemas && g.esquemas.has(k) && !g.tabelas.has(k)) return aspas ? inteiro : `"${nome}"`;
    let real;
    const posicaoTabela = /\b(FROM|JOIN|INTO|UPDATE)\s+("?[A-Za-z_][\w$]*"?\s*\.\s*)?$/i.test(antes) || (/^\s*\./.test(depois) && g.tabelas.has(k) && !(aliasTabela.has(k) && aliasTabela.get(k) !== k));
    if (posicaoTabela) real = g.tabelas.get(k);
    else if (/^\s*\./.test(depois) && aliasTabela.has(k)) return inteiro;
    else {
      const q = /([A-Za-z_][\w$]*)"?\s*\.\s*$/.exec(antes);
      real = coluna(nome, q ? q[1] : null);
    }
    if (!real) return inteiro;
    if (real === real.toLowerCase()) return aspas ? real : inteiro;
    return `"${real}"`;
  }));
}
function traduzirSeNaoExiste(cmd) {
  const m = /^\s*IF\s+NOT\s+EXISTS\s*\(/i.exec(cmd);
  if (!m) return cmd;
  const abre = m[0].length - 1;
  const fecha = fimDoEscopo(cmd, abre + 1);
  const sub = cmd.slice(abre + 1, fecha);
  const insercao = /^\s*(INSERT\s+INTO\s+[^(]+\([^)]*\))\s*VALUES\s*\(([\s\S]*)\)\s*$/i.exec(cmd.slice(fecha + 1));
  if (!insercao) return cmd;
  return `${insercao[1]} SELECT ${insercao[2]} WHERE NOT EXISTS (${sub})`;
}

function traduzirComando(cmdOriginal, params, prefixo, utc, grafia) {
  const cmd = traduzirSeNaoExiste(cmdOriginal);
  const prefixoBanco = (inteiro, banco) => (ESQUEMAS && !bancosProtheus().has(banco.toLowerCase()) ? `"${bancoNoPostgres(banco)}".` : '');
  let t = foraDeTexto(cmd, (p) => p.replace(/\[?([A-Za-z_]\w*)\]?\.\[?dbo\]?\.(?=\[?[A-Za-z_#])/gi, prefixoBanco).replace(/(?<![\w\]."])\[?([A-Za-z_]\w*)\]?\.\.(?=\[?[A-Za-z_#])/g, prefixoBanco));
  if (/^\s*MERGE\b/i.test(t)) t = traduzirMerge(t.replace(/\[?dbo\]?\./gi, '').replace(/\[([A-Za-z_][A-Za-z0-9_ ]*)\]/g, '$1').replace(/\bWITH\s*\(\s*HOLDLOCK\s*\)/gi, ''));
  const catalogo = /\bINFORMATION_SCHEMA\b/i.test(t);
  if (catalogo) t = t.replace(/'([^']*)'/g, (_m, s) => `'${s.toLowerCase()}'`);
  t = foraDeTexto(t, (p) => p.replace(/\[?dbo\]?\./gi, ''));
  const minusculas = Object.keys(carregarMapa()).length > 0;
  t = foraDeTexto(t, (p) => p.replace(/\[([A-Za-z_][A-Za-z0-9_ ]*)\]/g, (_m, n) => (!minusculas && /[A-Z]/.test(n) && /[a-z]/.test(n) ? `"${n}"` : n)));
  t = trocarFuncao(t, 'STUFF', (args) => {
    const m = /^\(\s*SELECT\s+('(?:[^']|'')*')\s*\+\s*([\s\S]+?)\s+FROM\s+([\s\S]+?)\s+FOR\s+XML\s+PATH\s*\(\s*''\s*\)(?:\s*,\s*TYPE)?\s*\)(?:\s*\.value\s*\(\s*'[^']*'\s*,\s*'[^']*'\s*\))?$/i.exec(args[0] || '');
    if (m && args[1] === '1' && /^''$/.test(args[3] || '')) return `(SELECT STRING_AGG(CAST(${m[2]} AS TEXT), ${m[1]}) FROM ${m[3]})`;
    return `OVERLAY(${args[0]} PLACING ${args[3]} FROM ${args[1]} FOR ${args[2]})`;
  });
  const bloqueia = /\bWITH\s*\(\s*[^)]*\bUPDLOCK\b[^)]*\)/i.test(t);
  t = t.replace(/\bWITH\s*\(\s*(NOLOCK|UPDLOCK|HOLDLOCK|ROWLOCK|READPAST|TABLOCK|TABLOCKX|READUNCOMMITTED)(\s*,\s*(NOLOCK|UPDLOCK|HOLDLOCK|ROWLOCK|READPAST|TABLOCK|TABLOCKX|READUNCOMMITTED))*\s*\)/gi, '');
  t = t.replace(/\(\s*NOLOCK\s*\)/gi, '');
  t = t.replace(/\b(GETDATE|SYSDATETIME|CURRENT_TIMESTAMP)\s*\(\s*\)/gi, 'LOCALTIMESTAMP');
  t = t.replace(/\b(GETUTCDATE|SYSUTCDATETIME)\s*\(\s*\)/gi, "(now() AT TIME ZONE 'utc')");
  t = t.replace(/\bNOW\s*\(\s*\)/gi, 'LOCALTIMESTAMP');
  t = t.replace(/\s+COLLATE\s+[A-Za-z0-9_]+/gi, '');
  t = t.replace(/\bISNULL\s*\(/gi, 'COALESCE(');
  t = t.replace(/\bLEN\s*\(/gi, 'LENGTH(');
  const conversaoSegura = (tipo, expr) => {
    const nome = String(tipo).trim().toUpperCase();
    let padrao = null;
    if (/^(INT|INTEGER|BIGINT|SMALLINT|TINYINT)$/.test(nome)) padrao = '^\\s*-?[0-9]+\\s*$';
    else if (/^(DECIMAL|NUMERIC|FLOAT|REAL|MONEY)\b/.test(nome)) padrao = '^\\s*-?[0-9]+([.][0-9]+)?\\s*$';
    if (!padrao) return `CAST(${expr} AS ${tipo})`;
    return `(CASE WHEN CAST(${expr} AS TEXT) ~ '${padrao}' THEN CAST(${expr} AS ${tipo}) END)`;
  };
  t = trocarFuncao(t, 'TRY_CONVERT', ([tipo, expr]) => conversaoSegura(tipo, expr));
  t = trocarFuncao(t, 'TRY_CAST', ([arg]) => {
    const m = /^([\s\S]+)\s+AS\s+([\s\S]+)$/i.exec(arg);
    return m ? conversaoSegura(m[2], m[1]) : `CAST(${arg})`;
  });
  t = t.replace(/\bNEWID\s*\(\s*\)/gi, 'gen_random_uuid()');
  for (const [re, novo] of TIPOS_CAST) t = t.replace(re, novo);
  t = t.replace(/\bNOT\s+LIKE\b/gi, 'NOT ILIKE').replace(/(?<!NOT\s)\bLIKE\b/gi, 'ILIKE');
  t = trocarFuncao(t, 'ISJSON', ([expr]) => `__ISJSON__(${expr})`);
  t = t.replace(/__ISJSON__\(([\s\S]*?)\)\s*=\s*1/g, '(($1) IS JSON)').replace(/__ISJSON__\(([\s\S]*?)\)\s*=\s*0/g, '(($1) IS NOT JSON)');
  t = trocarFuncao(t, 'JSON_VALUE', ([expr, caminho]) => {
    const partes = String(caminho).replace(/^'\$\.?|'$/g, '').split('.').filter(Boolean);
    return partes.length === 1 ? `(CAST(${expr} AS jsonb) ->> '${partes[0]}')` : `(CAST(${expr} AS jsonb) #>> '{${partes.join(',')}}')`;
  });
  t = trocarFuncao(t, 'DATEADD', ([unidade, n, base]) => `(CAST(${base} AS TIMESTAMP) + (${n}) * INTERVAL '1 ${UNIDADES[unidade.toLowerCase()] || unidade}')`);
  t = trocarFuncao(t, 'DATEDIFF', ([unidade, a, b]) => {
    const u = UNIDADES[unidade.toLowerCase()] || unidade.toLowerCase();
    if (u === 'day') return `(CAST(${b} AS DATE) - CAST(${a} AS DATE))`;
    if (u === 'month') return `((EXTRACT(YEAR FROM CAST(${b} AS TIMESTAMP)) - EXTRACT(YEAR FROM CAST(${a} AS TIMESTAMP))) * 12 + EXTRACT(MONTH FROM CAST(${b} AS TIMESTAMP)) - EXTRACT(MONTH FROM CAST(${a} AS TIMESTAMP)))::int`;
    if (u === 'year') return `(EXTRACT(YEAR FROM CAST(${b} AS TIMESTAMP)) - EXTRACT(YEAR FROM CAST(${a} AS TIMESTAMP)))::int`;
    const seg = { minute: 60, hour: 3600, second: 1, week: 604800 }[u] || 1;
    return `FLOOR(EXTRACT(EPOCH FROM (date_trunc('${u === 'week' ? 'day' : u}', CAST(${b} AS TIMESTAMP)) - date_trunc('${u === 'week' ? 'day' : u}', CAST(${a} AS TIMESTAMP)))) / ${seg})::int`;
  });
  t = trocarFuncao(t, 'FORMAT', ([expr, formato]) => {
    const m = /^N?'([^']*)'$/.exec(String(formato || '').trim());
    if (!m) return `__FORMATO__(${expr}, ${formato})`;
    const pg = m[1].replace(/yyyy|MM|dd|HH|mm|ss|fff/g, (x) => ({ yyyy: 'YYYY', MM: 'MM', dd: 'DD', HH: 'HH24', mm: 'MI', ss: 'SS', fff: 'MS' })[x]);
    return `to_char(CAST(${expr} AS TIMESTAMP), '${pg}')`;
  }).replace(/__FORMATO__\(/g, 'FORMAT(');
  for (const parte of ['YEAR', 'MONTH', 'DAY']) t = trocarFuncao(t, parte, ([expr]) => `CAST(EXTRACT(${parte} FROM CAST(${expr} AS TIMESTAMP)) AS INTEGER)`);
  t = trocarFuncao(t, 'CONVERT', ([tipo, expr, estilo]) => {
    const formatos = { 120: 'YYYY-MM-DD HH24:MI:SS', 20: 'YYYY-MM-DD HH24:MI:SS', 121: 'YYYY-MM-DD HH24:MI:SS.MS', 21: 'YYYY-MM-DD HH24:MI:SS.MS', 126: 'YYYY-MM-DD"T"HH24:MI:SS.MS', 23: 'YYYY-MM-DD', 103: 'DD/MM/YYYY', 3: 'DD/MM/YY', 104: 'DD.MM.YYYY', 108: 'HH24:MI:SS', 112: 'YYYYMMDD', 105: 'DD-MM-YYYY', 101: 'MM/DD/YYYY' };
    const ehTexto = /^\s*(N?VARCHAR|N?CHAR|TEXT)\b/i.test(tipo);
    const tamanho = (/\(\s*(\d+)\s*\)/.exec(tipo) || [])[1];
    if (ehTexto && estilo !== undefined && formatos[Number(estilo)]) {
      const formatado = `to_char(CAST(${expr} AS TIMESTAMP), '${formatos[Number(estilo)]}')`;
      return tamanho ? `LEFT(${formatado}, ${tamanho})` : formatado;
    }
    return `CAST(${expr} AS ${tipo})`;
  });
  t = trocarFuncao(t, 'CHARINDEX', ([agulha, palheiro]) => `POSITION((${agulha}) IN (${palheiro}))`);
  t = trocarFuncao(t, 'IIF', ([cond, a, b]) => `(CASE WHEN ${cond} THEN ${a} ELSE ${b} END)`);
  t = trocarFuncao(t, 'COUNT', (args) => `CAST(__CONTAR__(${args.join(', ')}) AS INTEGER)`).replace(/__CONTAR__\(/g, 'COUNT(');
  t = trocarFuncao(t, 'SUM', (args) => `CAST(__SOMAR__(${args.join(', ')}) AS DOUBLE PRECISION)`).replace(/__SOMAR__\(/g, 'SUM(');
  const apelidos = new Set();
  t = t.replace(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)\b/g, (inteiro, nome) => {
    if (!(/[A-Z]/.test(nome) && /[a-z]/.test(nome))) return inteiro;
    apelidos.add(nome);
    return `AS "${nome}"`;
  });
  if (apelidos.size) {
    t = t.replace(/\bORDER\s+BY\s+([^()';]*)/gi, (inteiro, lista) => `ORDER BY ${lista.replace(/(?<!["\w.])([A-Za-z_][A-Za-z0-9_]*)(?!["\w.(])/g, (n) => (apelidos.has(n) ? `"${n}"` : n))}`);
  }
  let retorno = null;
  t = t.replace(/\bOUTPUT\s+((?:INSERTED|DELETED)\.(?:\*|\w+)(?:\s+AS\s+\w+)?(?:\s*,\s*(?:INSERTED|DELETED)\.(?:\*|\w+)(?:\s+AS\s+\w+)?)*)/i, (_m, lista) => {
    retorno = lista.replace(/\b(INSERTED|DELETED)\./gi, '');
    return '';
  });
  t = trocarTop(t);
  if (retorno) t = `${t.trimEnd()} RETURNING ${retorno}`;
  if (bloqueia) t = `${t.trimEnd()} FOR UPDATE`;
  const re = prefixo === '@' ? /(?<![@\w])@([a-zA-Z_][a-zA-Z0-9_]*)/g : /(?<![:\w]):([a-zA-Z_][a-zA-Z0-9_]*)/g;
  t = t.replace(re, (inteiro, nome) => {
    const chave = Object.keys(params).find((k) => k.toLowerCase() === nome.toLowerCase());
    if (chave === undefined) return inteiro;
    const v = params[chave];
    return literal(catalogo && typeof v === 'string' ? v.toLowerCase() : v, utc);
  });
  return catalogo ? t : ajustarGrafia(t, grafia);
}

function ehDdlSqlServer(c) {
  if (/\bOBJECT_ID\s*\(|\bCOL_LENGTH\s*\(|\bsys\.(tables|columns|indexes|objects)\b|\bsysobjects\b/i.test(c)) return true;
  if (/^\s*SET\s+(NOCOUNT|XACT_ABORT|ANSI_|QUOTED_IDENTIFIER|DATEFORMAT|LANGUAGE)\b/i.test(c)) return true;
  if (/^\s*(BEGIN|END)\s*$/i.test(c)) return true;
  if (/^\s*IF\b/i.test(c) && /\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX|UNIQUE|NONCLUSTERED|CLUSTERED|VIEW|PROCEDURE|FUNCTION)\b|\bsp_rename\b/i.test(c)) return true;
  if (/^\s*(BEGIN\s+)?(CREATE\s+(TABLE|UNIQUE|INDEX|NONCLUSTERED|CLUSTERED)|ALTER\s+TABLE|DROP\s+(TABLE|INDEX)|EXEC(UTE)?\s+sp_)/i.test(c)) return true;
  return false;
}

function traduzir(sqlTexto, params = {}, prefixo = '@', utc = false, grafia = null) {
  const comandos = dividirComandos(sqlTexto);
  const saida = [];
  for (let i = 0; i < comandos.length; i++) {
    const c = comandos[i];
    const identidade = /^\s*SELECT\s+(?:CAST\s*\(\s*)?SCOPE_IDENTITY\s*\(\s*\)(?:\s+AS\s+\w+\s*\))?\s+AS\s+(\w+)\s*$/i.exec(c) || /^\s*SELECT\s+@@IDENTITY\s+AS\s+(\w+)\s*$/i.exec(c);
    if (identidade && saida.length && /^\s*INSERT\b/i.test(comandos[i - 1])) {
      saida[saida.length - 1] = `${saida[saida.length - 1].trimEnd()} RETURNING id AS "${identidade[1]}"`;
      continue;
    }
    const contagem = /^\s*SELECT\s+@@ROWCOUNT\s+AS\s+(\w+)\s*$/i.exec(c);
    if (contagem) { saida.push(`--ROWCOUNT:${contagem[1]}`); continue; }
    if (ehDdlSqlServer(c)) continue;
    saida.push(traduzirComando(c, params, prefixo, utc, grafia));
  }
  return saida;
}

let tiposRegistrados = false;
function leitores(utc) {
  const { types } = require('pg');
  return {
    getTypeParser: (oid, formato) => {
      if (oid === 21 && process.env.PG_SMALLINT_COMO_BIT !== '0') return (v) => (v === null ? null : v !== '0');
      if (oid === 1700) return (v) => (v === null ? null : Number(v));
      if (utc && oid === 1114) return (v) => (v === null ? null : new Date(`${v.replace(' ', 'T')}Z`));
      if (utc && oid === 1082) return (v) => (v === null ? null : new Date(`${v}T00:00:00Z`));
      return types.getTypeParser(oid, formato);
    },
  };
}

function novoPoolPg(banco, utc) {
  const { Pool } = require('pg');
  tiposRegistrados = true;
  return new Pool({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT || 5432),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: ESQUEMAS ? process.env.PG_DATABASE : banco,
    ssl: process.env.PG_SSL === '1' ? { rejectUnauthorized: false } : undefined,
    max: 10,
    options: ESQUEMAS ? `-c timezone=${FUSO} -c search_path="${banco}",public` : `-c timezone=${FUSO}`,
    types: leitores(utc),
  });
}

const poolsPg = new Map();
const poolPg = (banco, utc = false) => {
  const chave = `${banco}|${utc}`;
  if (!poolsPg.has(chave)) poolsPg.set(chave, novoPoolPg(banco, utc));
  return poolsPg.get(chave);
};const usaUtc = (config) => !(config && config.options && config.options.useUTC === false);

let mapaColunas;
function carregarMapa() {
  if (mapaColunas !== undefined) return mapaColunas;
  const fs = require('fs');
  const path = require('path');
  const arquivo = process.env.PG_MAPA_COLUNAS || path.join(__dirname, '..', 'database', 'sql', 'postgres', 'colunas.json');
  try { mapaColunas = JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch { mapaColunas = {}; }
  return mapaColunas;
}

function grafiaDasChaves(sqlTexto, linhas) {
  if (!linhas.length) return linhas;
  const porTabela = carregarMapa();
  const escrita = {};
  const semTexto = sqlTexto.replace(/'(?:[^']|'')*'/g, ' ');
  const mapa = {};
  const citadas = [...semTexto.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:\[?[A-Za-z_]\w*\]?\.(?=\[?dbo\]?\.))?(?:\[?dbo\]?\.)?\[?([A-Za-z_][A-Za-z0-9_]*)\]?/gi)].map((x) => x[1].toLowerCase());
  for (const tabela of citadas) for (const [k, v] of Object.entries(porTabela[tabela] || {})) if (!(k in mapa)) mapa[k] = v;
  for (const tok of semTexto.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []) {
    const baixo = tok.toLowerCase();
    if (!(baixo in escrita)) escrita[baixo] = tok;
  }
  const apelido = {};
  for (const m of semTexto.matchAll(/\bAS\s+["\[]?([A-Za-z_][A-Za-z0-9_]*)/gi)) if (!(m[1].toLowerCase() in apelido)) apelido[m[1].toLowerCase()] = m[1];
  const estrela = /\bSELECT\s+(DISTINCT\s+)?(TOP\s*\(?[^)\s]+\)?\s+)?([A-Za-z_]\w*\.)?\*/i.test(semTexto);
  const chaves = Object.keys(linhas[0]);
  const novas = chaves.map((k) => {
    if (k !== k.toLowerCase()) return k;
    return apelido[k] || (estrela ? (mapa[k] || escrita[k]) : (escrita[k] || mapa[k])) || k;
  });
  if (novas.every((n, i) => n === chaves[i])) return linhas;
  return linhas.map((l) => {
    const o = {};
    chaves.forEach((k, i) => { o[novas[i]] = l[k]; });
    return o;
  });
}

function montarGrafia(linhas) {
  const esquemas = new Set(linhas.filter((l) => l.s).map((l) => l.s.toLowerCase()));
  const tabelas = new Map();
  const colunas = new Map();
  const global = new Map();
  for (const { t, c } of linhas) {
    const kt = t.toLowerCase();
    tabelas.set(kt, t);
    if (!colunas.has(kt)) colunas.set(kt, new Map());
    colunas.get(kt).set(c.toLowerCase(), c);
    const kc = c.toLowerCase();
    if (!global.has(kc)) global.set(kc, c);
    else if (global.get(kc) !== c) global.set(kc, null);
  }
  for (const [k, v] of tabelas) if (!global.has(k)) global.set(k, v);
  return { tabelas, colunas, global, esquemas };
}

const grafias = new Map();
function grafiaDoBanco(cliente) {
  if (process.env.PG_GRAFIA === 'minusculas') return Promise.resolve(null);
  const banco = (cliente && cliente.database) || process.env.PG_DATABASE || '';
  if (!grafias.has(banco)) {
    grafias.set(banco, cliente.query(`
      SELECT c.table_schema AS s, c.table_name AS t, c.column_name AS c FROM information_schema.columns c
      WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')`)
      .then((r) => montarGrafia(r.rows))
      .catch((e) => { grafias.delete(banco); throw e; }));
  }
  return grafias.get(banco);
}

async function executarPg(cliente, sqlTexto, params, utc) {
  const comandos = traduzir(sqlTexto, params, '@', utc, await grafiaDoBanco(cliente));
  const recordsets = [];
  const rowsAffected = [];
  let ultimo = 0;
  for (const c of comandos) {
    if (c.startsWith('--ROWCOUNT:')) {
      const linha = { [c.slice(11)]: ultimo };
      recordsets.push([linha]);
      continue;
    }
    const r = await cliente.query(c);
    ultimo = r.rowCount || 0;
    rowsAffected.push(ultimo);
    if (r.command === 'SELECT' || (r.fields && r.fields.length)) {
      let linhas = r.rows || [];
      if (/\bINFORMATION_SCHEMA\b/i.test(c)) {
        for (const l of linhas) for (const k of Object.keys(l)) if (!(k.toUpperCase() in l)) l[k.toUpperCase()] = l[k];
      } else {
        linhas = grafiaDasChaves(sqlTexto, linhas);
      }
      recordsets.push(linhas);
    }
  }
  return { recordset: recordsets[0], recordsets, rowsAffected, output: {} };
}

function bancosProtheus() {
  const lista = (process.env.PG_BANCOS_PROTHEUS || 'p2510').split(',');
  if (process.env.DB_DATABASE_PROTHEUS) lista.push(process.env.DB_DATABASE_PROTHEUS);
  return new Set(lista.map((x) => x.trim().toLowerCase()).filter(Boolean));
}

const bancoNoPostgres = (nome) => process.env[`PG_BANCO_${String(nome).toUpperCase()}`] || nome;

function bancosCitados(sqlTexto) {
  const limpo = sqlTexto.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, ' ');
  const nomes = new Set();
  for (const m of limpo.matchAll(/(?<![\w\].])\[?([A-Za-z_][A-Za-z0-9_]*)\]?\s*\.\s*(?:\[?[A-Za-z_][A-Za-z0-9_]*\]?)?\s*\.\s*\[?[A-Za-z_#]/g)) nomes.add(m[1].toLowerCase());
  return nomes;
}

function destinoDaConsulta(sqlTexto, padrao) {
  const protheus = bancosProtheus();
  const citados = bancosCitados(sqlTexto);
  if ([...citados].some((b) => protheus.has(b))) {
    const outros = [...citados].filter((b) => !protheus.has(b));
    if (outros.length) throw new Error(`consulta mistura o Protheus com ${outros.join(', ')}: separe em duas consultas para rodar com o PostgreSQL`);
    return { tipo: 'mssql' };
  }
  if (citados.size > 1 && !ESQUEMAS) throw new Error(`consulta cruza os bancos ${[...citados].join(', ')}, o que o PostgreSQL não faz entre bancos diferentes`);
  const padraoValido = padrao && !protheus.has(String(padrao).toLowerCase()) ? padrao : null;
  const banco = citados.size === 1 ? [...citados][0] : (padraoValido || [...citados][0] || padrao);
  if (!banco || protheus.has(String(banco).toLowerCase())) return { tipo: 'mssql' };
  return { tipo: 'pg', banco: bancoNoPostgres(banco) };
}

function limparConfig(config) {
  const limpa = config && typeof config === 'object' ? { ...config } : config;
  if (limpa && typeof limpa === 'object') delete limpa.proprio;
  return limpa;
}

function bancoPadrao(config) {
  if (config && config.proprio === true && process.env.PG_DATABASE) return process.env.PG_DATABASE;
  return (config && (config.database || (config.options && config.options.database))) || process.env.PG_DATABASE;
}

class RequestPg {
  constructor(alvo) {
    this.alvo = alvo;
    this.params = {};
    this.entradas = [];
  }

  input(nome, tipo, valor) {
    this.params[nome] = arguments.length >= 3 ? valor : tipo;
    this.entradas.push(arguments.length >= 3 ? [nome, tipo, valor] : [nome, tipo]);
    return this;
  }

  output(nome, tipo) {
    this.params[nome] = null;
    this.entradas.push(['__saida__', nome, tipo]);
    return this;
  }

  repassar(req) {
    for (const e of this.entradas) {
      if (e[0] === '__saida__') { if (e[2] !== undefined) req.output(e[1], e[2]); else req.output(e[1]); } else req.input(...e);
    }
    return req;
  }

  async query(sqlTexto) {
    if (this.alvo instanceof TransactionPg) return this.alvo.executar(sqlTexto, this);
    const pool = this.alvo;
    const destino = destinoDaConsulta(sqlTexto, pool.padrao);
    if (destino.tipo === 'mssql') return this.repassar((await pool.poolMssql()).request()).query(sqlTexto);
    const cliente = await poolPg(destino.banco, pool.utc).connect();
    try {
      return await executarPg(cliente, sqlTexto, this.params, pool.utc);
    } finally {
      cliente.release();
    }
  }

  async batch(sqlTexto) { return this.query(sqlTexto); }

  async execute(procedure) {
    const pool = this.alvo instanceof TransactionPg ? this.alvo.pool : this.alvo;
    const destino = destinoDaConsulta(String(procedure), pool.padrao);
    if (destino.tipo === 'mssql') return this.repassar((await pool.poolMssql()).request()).execute(procedure);
    throw new Error(`procedure ${procedure} não existe no PostgreSQL`);
  }
}

class TransactionPg {
  constructor(pool) {
    this.pool = pool;
    this.destino = null;
    this.cliente = null;
    this.txMssql = null;
    this.aberta = false;
  }

  async begin() {
    this.aberta = true;
    return this;
  }

  async abrir(destino) {
    this.destino = destino;
    if (destino.tipo === 'mssql') {
      this.txMssql = new mssql.Transaction(await this.pool.poolMssql());
      await this.txMssql.begin();
    } else {
      this.cliente = await poolPg(destino.banco, this.pool.utc).connect();
      await this.cliente.query('BEGIN');
    }
  }

  async executar(sqlTexto, req) {
    if (!this.aberta) throw new Error('transação não iniciada');
    const destino = destinoDaConsulta(sqlTexto, this.pool.padrao);
    if (!this.destino) await this.abrir(destino);
    else if (this.destino.tipo !== destino.tipo || this.destino.banco !== destino.banco) throw new Error('a transação mistura bancos diferentes (SQL Server e PostgreSQL, ou dois bancos do PostgreSQL)');
    if (destino.tipo === 'mssql') return req.repassar(new mssql.Request(this.txMssql)).query(sqlTexto);
    return executarPg(this.cliente, sqlTexto, req.params, this.pool.utc);
  }

  async encerrar(comando) {
    this.aberta = false;
    if (this.txMssql) { const tx = this.txMssql; this.txMssql = null; this.destino = null; return comando === 'COMMIT' ? tx.commit() : tx.rollback(); }
    if (!this.cliente) { this.destino = null; return undefined; }
    try { await this.cliente.query(comando); } finally { this.cliente.release(); this.cliente = null; this.destino = null; }
    return undefined;
  }

  async commit() { return this.encerrar('COMMIT'); }

  async rollback() { return this.encerrar('ROLLBACK'); }

  request() { return new RequestPg(this); }
}

class ConnectionPoolPg {
  constructor(config) {
    this.config = config;
    this.utc = usaUtc(config);
    this.padrao = bancoPadrao(config);
    this.connected = false;
    this._mssql = null;
  }

  poolMssql() {
    if (!this._mssql) {
      this._mssql = new mssql.ConnectionPool(limparConfig(this.config)).connect().catch((e) => { this._mssql = null; throw e; });
    }
    return this._mssql;
  }

  async connect() {
    const destino = destinoDaConsulta('', this.padrao);
    if (destino.tipo === 'mssql') await this.poolMssql();
    else (await poolPg(destino.banco, this.utc).connect()).release();
    this.connected = true;
    return this;
  }

  request() { return new RequestPg(this); }

  transaction() { return new TransactionPg(this); }

  on() { return this; }

  async close() {
    this.connected = false;
    if (this._mssql) { const p = await this._mssql.catch(() => null); this._mssql = null; if (p) await p.close(); }
  }
}

function ConnectionPool(config, ...resto) {
  if (PG) return new ConnectionPoolPg(config);
  return new mssql.ConnectionPool(limparConfig(config), ...resto);
}

function Transaction(pool) {
  if (pool instanceof ConnectionPoolPg) return new TransactionPg(pool);
  return new mssql.Transaction(pool);
}

function Request(alvo) {
  if (alvo instanceof ConnectionPoolPg || alvo instanceof TransactionPg) return new RequestPg(alvo);
  return new mssql.Request(alvo);
}

const poolsGlobais = new Map();
async function connect(config) {
  if (!PG) return mssql.connect(limparConfig(config));
  const chave = JSON.stringify([bancoPadrao(config), usaUtc(config), config && config.server]);
  if (!poolsGlobais.has(chave)) poolsGlobais.set(chave, await new ConnectionPoolPg(config).connect());
  return poolsGlobais.get(chave);
}
const modulo = Object.create(mssql || {});
Object.assign(modulo, {
  ConnectionPool,
  Transaction,
  Request,
  connect,
  dialeto: () => DIALETO,
  traduzir,
  literal,
  fecharPostgres: async () => { const lista = [...poolsPg.values()]; poolsPg.clear(); poolsGlobais.clear(); await Promise.all(lista.map((p) => p.end())); },
  destinoDaConsulta,
  modoEsquemas: () => ESQUEMAS,
  tiposRegistrados: () => tiposRegistrados,
  __interno: { grafiaDasChaves, ajustarGrafia, montarGrafia, recarregarMapa: () => { mapaColunas = undefined; }, limparGrafias: () => grafias.clear() },
});

module.exports = modulo;
