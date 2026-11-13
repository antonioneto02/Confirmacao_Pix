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

function trocarApply(texto) {
  const re = /\b(OUTER|CROSS)\s+APPLY\s*\(/i;
  let saida = texto;
  let m;
  let guarda = 0;
  while ((m = re.exec(saida)) && guarda++ < 1000) {
    const abre = m.index + m[0].length - 1;
    const { fim } = argumentos(saida, abre);
    const resto = saida.slice(fim + 1);
    const apelido = /^\s+(?:AS\s+)?("?[A-Za-z_][\w$]*"?(?:\s*\([^()]*\))?)/i.exec(resto);
    const valido = apelido && !/^(WHERE|ON|JOIN|GROUP|ORDER|UNION|LEFT|INNER|CROSS|OUTER|RIGHT|FULL|HAVING|LIMIT|OFFSET)$/i.test(apelido[1]);
    const fimApelido = valido ? apelido[0].length : 0;
    const juncao = m[1].toUpperCase() === 'OUTER' ? 'LEFT JOIN LATERAL (' : 'CROSS JOIN LATERAL (';
    const corpo = saida.slice(abre + 1, fim);
    const nome = valido ? apelido[0] : ' __lateral';
    saida = saida.slice(0, m.index) + juncao + corpo + ')' + nome + (m[1].toUpperCase() === 'OUTER' ? ' ON TRUE' : '') + resto.slice(fimApelido);
  }
  return saida;
}

function contarComoInteiro(texto) {
  const re = /\bCOUNT\s*\(/i;
  let saida = texto;
  let m;
  let guarda = 0;
  while ((m = re.exec(saida)) && guarda++ < 10000) {
    const abre = m.index + m[0].length - 1;
    const { args, fim } = argumentos(saida, abre);
    let final = fim + 1;
    let janela = '';
    const over = /^\s*OVER\s*\(/i.exec(saida.slice(final));
    if (over) {
      const fimOver = argumentos(saida, final + over[0].length - 1).fim;
      janela = saida.slice(final, fimOver + 1);
      final = fimOver + 1;
    }
    saida = `${saida.slice(0, m.index)}CAST(__CONTAR__(${args.join(', ')})${janela} AS INTEGER)${saida.slice(final)}`;
  }
  return saida.replace(/__CONTAR__\(/g, 'COUNT(');
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
      const a = /^([\s\S]+?)\s+(?:AS\s+)?(\w+)$/i.exec(item);
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
    const a = /^([\s\S]+?)\s+(?:AS\s+)?(\w+)$/i.exec(item);
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

const CLAUSULAS = /\b(SELECT|FROM|WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|SET|VALUES|RETURNING|ON|JOIN|LIMIT|UNION|INTO|USING|WHEN|THEN|ELSE|AND|OR|PARTITION\s+BY|OVER)\b/gi;

function itemDeSelect(antes, depois) {
  if (!/^\s*(,|\bFROM\b)/i.test(depois)) return false;
  if (!/(\bSELECT\s+(DISTINCT\s+)?|,)\s*("?[A-Za-z_][\w$]*"?\s*\.\s*)?$/i.test(antes)) return false;
  let profundidade = 0;
  let inicio = 0;
  for (let i = antes.length - 1; i >= 0; i--) {
    const c = antes[i];
    if (c === ')') profundidade++;
    else if (c === '(') { if (profundidade === 0) { inicio = i + 1; break; } profundidade--; }
  }
  let ultima = null;
  for (const m of antes.slice(inicio).replace(/\([^()]*\)/g, ' ').matchAll(CLAUSULAS)) ultima = m[1].toUpperCase();
  return ultima === 'SELECT';
}

const NAO_APELIDO = /^(WHERE|ON|JOIN|GROUP|ORDER|UNION|LEFT|INNER|CROSS|OUTER|RIGHT|FULL|HAVING|LIMIT|OFFSET|AND|OR|AS|SELECT|FROM|SET|VALUES|RETURNING)$/i;

function subconsultasDe(semTexto) {
  const lista = [];
  for (let i = 0; i < semTexto.length; i++) {
    if (semTexto[i] !== '(' || !/^\(\s*(SELECT|WITH)\b/i.test(semTexto.slice(i, i + 40))) continue;
    let n = 0;
    let j = i;
    for (; j < semTexto.length; j++) { if (semTexto[j] === '(') n++; else if (semTexto[j] === ')') { n--; if (n === 0) break; } }
    const a = /^\s*(?:AS\s+)?"?([A-Za-z_][\w$]*)"?/i.exec(semTexto.slice(j + 1));
    lista.push({ nome: a && !NAO_APELIDO.test(a[1]) ? a[1].toLowerCase() : null, ini: i, fim: j });
  }
  return lista;
}

function derivadas(semTexto) {
  return subconsultasDe(semTexto).filter((d) => d.nome);
}

function escoposDe(semTexto, g) {
  const escopos = [{ ini: -1, fim: semTexto.length }, ...subconsultasDe(semTexto)];
  for (const e of escopos) {
    let proprio = semTexto.slice(e.ini + 1, e.fim).split('');
    for (const filho of escopos) {
      if (filho === e || filho.ini <= e.ini || filho.fim >= e.fim) continue;
      for (let k = filho.ini; k <= filho.fim; k++) proprio[k - e.ini - 1] = ' ';
    }
    proprio = proprio.join('');
    e.tabelas = referencias(proprio, g).tabelas;
  }
  return escopos;
}

function ajustarGrafia(t, grafiaBruta) {
  const g = normalizarGrafia(grafiaBruta);
  if (!g || !g.tabelas.size) return t;
  const { apelidos: aliasTabela, tabelas: usadas } = referencias(t, g);
  const legado = !g.colunas.size;
  const semTextoIgual = t.replace(/'(?:[^']|'')*'/g, (x) => "'" + ' '.repeat(x.length - 2) + "'");
  const subconsultas = derivadas(semTextoIgual);
  const escopos = escoposDe(semTextoIgual, g);
  const daSubconsulta = (qualificador, onde) => {
    const k = qualificador.toLowerCase();
    const mesmas = subconsultas.filter((d) => d.nome === k);
    return mesmas.length > 0 && !mesmas.some((d) => onde > d.ini && onde < d.fim);
  };
  const apelidosSaida = new Set([...t.replace(/'(?:[^']|'')*'/g, "''").matchAll(/\bAS\s+"?([A-Za-z_][A-Za-z0-9_$]*)"?/gi)].map((m) => m[1]));
  const coluna = (nome, qualificador, onde) => {
    const k = nome.toLowerCase();
    if (qualificador) {
      const tabela = aliasTabela.get(qualificador.toLowerCase());
      const cols = tabela && g.colunas.get(tabela);
      if (cols && cols.has(k)) return cols.get(k);
      return legado ? (g.global.get(k) || undefined) : undefined;
    }
    const visiveis = legado || onde === undefined
      ? [usadas]
      : escopos.filter((e) => onde > e.ini && onde < e.fim).sort((a, b) => (a.fim - a.ini) - (b.fim - b.ini)).map((e) => e.tabelas);
    for (const lista of visiveis) {
      for (const tabela of lista) {
        const cols = g.colunas.get(tabela);
        if (cols && cols.has(k)) return cols.get(k);
      }
    }
    return legado || !usadas.length ? (g.global.get(k) || undefined) : undefined;
  };
  const especial = (nome, onde) => {
    const k = nome.toLowerCase();
    const visiveis = escopos.filter((e) => onde > e.ini && onde < e.fim).sort((a, b) => (a.fim - a.ini) - (b.fim - b.ini));
    for (const e of visiveis) {
      for (const tabela of e.tabelas) {
        const cols = g.colunas.get(tabela);
        if (cols && cols.has(k)) return cols.get(k);
      }
    }
    return g.global.get(k) || nome;
  };
  let deslocamento = 0;
  return t.split(/('(?:[^']|'')*'|"(?=[^"\n]*[^A-Za-z0-9_$"\n])[\p{L}\d_%#][^"\n]*")/u).map((parte, indice) => {
    const base = deslocamento;
    deslocamento += parte.length;
    if (indice % 2) return parte.startsWith('"') ? `"${especial(parte.slice(1, -1), base)}"` : parte;
    return parte.replace(/(?<![\w$"])("?)([A-Za-z_][A-Za-z0-9_$]*)\1(?![\w$"])/g, (inteiro, aspas, nome, pos, todo) => {
    const antes = todo.slice(0, pos);
    const depois = todo.slice(pos + inteiro.length);
    if (/\bAS\s*$/i.test(antes) || /::\s*$/.test(antes)) return inteiro;
    if (apelidosSaida.has(nome) && !/\.\s*$/.test(antes) && /\bORDER\s+BY\b[^()]*$/i.test(antes)) return inteiro;
    if (!aspas && /^\(/.test(depois) && !/\b(INTO|FROM|JOIN|UPDATE)\s+$/i.test(antes)) return inteiro;
    if (!aspas && PALAVRAS_SQL.has(nome.toUpperCase())) return inteiro;
    const k = nome.toLowerCase();
    if (/^\s*\./.test(depois) && g.esquemas && g.esquemas.has(k) && (!g.tabelas.has(k) || /\b(FROM|JOIN|INTO|UPDATE)\s+$/i.test(antes))) return aspas ? inteiro : `"${nome}"`;
    let real;
    const posicaoTabela = /\b(FROM|JOIN|INTO|UPDATE)\s+("?[A-Za-z_][\w$]*"?\s*\.\s*)?$/i.test(antes) || (/^\s*\./.test(depois) && g.tabelas.has(k) && !(aliasTabela.has(k) && aliasTabela.get(k) !== k));
    if (posicaoTabela) real = g.tabelas.get(k);
    else if (/^\s*\./.test(depois) && aliasTabela.has(k)) return inteiro;
    else {
      const q = /([A-Za-z_][\w$]*)"?\s*\.\s*$/.exec(antes);
      if (q && daSubconsulta(q[1], base + pos)) return inteiro;
      real = coluna(nome, q ? q[1] : null, base + pos);
    }
    if (!real) return inteiro;
    if (real === real.toLowerCase()) return aspas ? real : inteiro;
    if (!posicaoTabela && !legado && itemDeSelect(antes, depois)) return `"${real}" AS ${nome}`;
    return `"${real}"`;
    });
  }).join('');
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

function posicaoNoTopo(texto, re, inicio = 0) {
  const semTexto = texto.replace(/'(?:[^']|'')*'/g, (x) => "'" + ' '.repeat(x.length - 2) + "'");
  let n = 0;
  for (let i = inicio; i < semTexto.length; i++) {
    const c = semTexto[i];
    if (c === '(') n++;
    else if (c === ')') n--;
    else if (n === 0 && (i === 0 || /[\s)]/.test(semTexto[i - 1]))) {
      const m = re.exec(semTexto.slice(i));
      if (m && m.index === 0) return { i, m };
    }
  }
  return null;
}

function comRecursivo(t) {
  const inicio = /^\s*WITH\s+(?!RECURSIVE\b)/i.exec(t);
  if (!inicio) return t;
  let i = inicio[0].length;
  for (;;) {
    const cab = /^\s*"?([A-Za-z_][\w$]*)"?\s*(\([^()]*\))?\s*AS\s*\(/i.exec(t.slice(i));
    if (!cab) return t;
    const abre = i + cab[0].length - 1;
    const { fim } = argumentos(t, abre);
    const corpo = t.slice(abre + 1, fim).replace(/'(?:[^']|'')*'/g, "''");
    if (new RegExp(String.raw`\b(FROM|JOIN)\s+"?${cab[1]}"?(?![\w$])`, 'i').test(corpo)) return t.replace(/^(\s*WITH)\s+/i, '$1 RECURSIVE ');
    const virgula = /^\s*,/.exec(t.slice(fim + 1));
    if (!virgula) return t;
    i = fim + 1 + virgula[0].length;
  }
}

function traduzirUpdateFrom(t) {
  const upd = posicaoNoTopo(t, /UPDATE\s+("?[A-Za-z_][\w$]*"?)\s+SET\b/iy);
  if (!upd) return t;
  const alvo = upd.m[1].replace(/"/g, '');
  const inicioSets = upd.i + upd.m[0].length;
  const de = posicaoNoTopo(t, /FROM\b/iy, inicioSets);
  if (!de) return t;
  const onde = posicaoNoTopo(t, /WHERE\b/iy, de.i);
  const fimFrom = onde ? onde.i : t.length;
  const fromTexto = t.slice(de.i + 4, fimFrom);
  const item = new RegExp(String.raw`^\s*((?:"?[A-Za-z_][\w$]*"?\s*\.\s*)?"?[A-Za-z_][\w$]*"?)\s+(?:AS\s+)?"?${alvo}"?(?![\w$])`, 'i').exec(fromTexto)
    || new RegExp(String.raw`\bJOIN\s+((?:"?[A-Za-z_][\w$]*"?\s*\.\s*)?"?[A-Za-z_][\w$]*"?)\s+(?:AS\s+)?"?${alvo}"?(?![\w$])`, 'i').exec(fromTexto);
  if (!item) return t;
  const sets = dividirVirgulas(t.slice(inicioSets, de.i)).map((x) => x.replace(new RegExp(String.raw`^\s*"?${alvo}"?\s*\.\s*`, 'i'), ' ').trim());
  const resto = onde ? t.slice(onde.i + onde.m[0].length) : '';
  return `${t.slice(0, upd.i)}UPDATE ${item[1]} AS __alvo SET ${sets.join(', ')} FROM${fromTexto.trimEnd()} WHERE __alvo.ctid = ${alvo}.ctid${onde ? ` AND (${resto.trim()})` : ''}`;
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
  t = foraDeTexto(t, (p) => p.replace(/\[([^\]\n]+)\]/g, (_m, n) => {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) return !minusculas && /[A-Z]/.test(n) && /[a-z]/.test(n) ? `"${n}"` : n;
    return `"${minusculas ? n.toLowerCase() : n}"`;
  }));
  t = traduzirUpdateFrom(t);
  t = comRecursivo(t);
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
  t = trocarFuncao(t, 'EOMONTH', ([d, n]) => `CAST(date_trunc('month', CAST(${d} AS TIMESTAMP)${n ? ` + (${n}) * INTERVAL '1 month'` : ''}) + INTERVAL '1 month' - INTERVAL '1 day' AS DATE)`);
  t = trocarFuncao(t, 'DATEFROMPARTS', ([a, m, d]) => `make_date(CAST(${a} AS INTEGER), CAST(${m} AS INTEGER), CAST(${d} AS INTEGER))`);
  t = trocarFuncao(t, 'ISDATE', ([x]) => `(CASE WHEN CAST(${x} AS TEXT) ~ '^\\s*[0-9]{4}-?[0-9]{2}-?[0-9]{2}' THEN 1 ELSE 0 END)`);
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
  t = t.replace(/(?<![@:\w])NOT\s+LIKE\b/gi, 'NOT ILIKE').replace(/(?<!NOT\s)(?<![@:\w])LIKE\b/gi, 'ILIKE');
  t = trocarFuncao(t, 'ISJSON', ([expr]) => `__ISJSON__(${expr})`);
  t = t.replace(/__ISJSON__\(([\s\S]*?)\)\s*=\s*1/g, '(($1) IS JSON)').replace(/__ISJSON__\(([\s\S]*?)\)\s*=\s*0/g, '(($1) IS NOT JSON)');
  t = trocarFuncao(t, 'JSON_VALUE', ([expr, caminho]) => {
    const partes = String(caminho).replace(/^'\$\.?|'$/g, '').split('.').filter(Boolean);
    return partes.length === 1 ? `(CAST(${expr} AS jsonb) ->> '${partes[0]}')` : `(CAST(${expr} AS jsonb) #>> '{${partes.join(',')}}')`;
  });
  t = trocarFuncao(t, 'DATEADD', ([unidade, n, base]) => `(CAST(${base} AS TIMESTAMP) + (${n}) * INTERVAL '1 ${UNIDADES[unidade.toLowerCase()] || unidade}')`);
  t = trocarFuncao(t, 'DATEPART', ([unidade, expr]) => {
    const bruto = unidade.trim().toLowerCase();
    if (['weekday', 'dw', 'w'].includes(bruto)) return `CAST(EXTRACT(DOW FROM CAST(${expr} AS TIMESTAMP)) + 1 AS INTEGER)`;
    if (['dayofyear', 'dy', 'y'].includes(bruto)) return `CAST(EXTRACT(DOY FROM CAST(${expr} AS TIMESTAMP)) AS INTEGER)`;
    if (['iso_week', 'isowk', 'isoww'].includes(bruto)) return `CAST(EXTRACT(WEEK FROM CAST(${expr} AS TIMESTAMP)) AS INTEGER)`;
    const u = UNIDADES[bruto] || bruto;
    return `CAST(FLOOR(EXTRACT(${u.toUpperCase()} FROM CAST(${expr} AS TIMESTAMP))) AS INTEGER)`;
  });
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
  t = trocarApply(t);
  t = t.replace(/\bSTRING_SPLIT\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)(\s+(?:AS\s+)?([A-Za-z_]\w*))?/gi, (inteiro, args, _a, apelido) => {
    const [valor, separador] = dividirVirgulas(args);
    const nome = apelido && !/^(WHERE|ON|JOIN|GROUP|ORDER|UNION|LEFT|INNER|CROSS)$/i.test(apelido) ? apelido : '__partes';
    const sobra = apelido && nome === '__partes' ? ` ${apelido}` : '';
    return `unnest(string_to_array(${valor}, ${separador})) AS ${nome}(value)${sobra}`;
  });
  t = trocarFuncao(t, 'CHARINDEX', ([agulha, palheiro]) => `POSITION((${agulha}) IN (${palheiro}))`);
  t = trocarFuncao(t, 'IIF', ([cond, a, b]) => `(CASE WHEN ${cond} THEN ${a} ELSE ${b} END)`);
  t = contarComoInteiro(t);
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
  return catalogo ? t : ajustarGrafia(numerosComoTexto(concatenar(t, grafia), grafia), grafia);
}

function ehDdlSqlServer(c) {
  if (/\bOBJECT_ID\s*\(|\bCOL_LENGTH\s*\(|\bsys\.(tables|columns|indexes|objects)\b|\bsysobjects\b/i.test(c)) return true;
  if (/^\s*SET\s+(NOCOUNT|XACT_ABORT|ANSI_|QUOTED_IDENTIFIER|DATEFORMAT|LANGUAGE)\b/i.test(c)) return true;
  if (/^\s*(BEGIN|END)\s*$/i.test(c)) return true;
  if (/^\s*IF\b/i.test(c) && /\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX|UNIQUE|NONCLUSTERED|CLUSTERED|VIEW|PROCEDURE|FUNCTION)\b|\bsp_rename\b/i.test(c)) return true;
  if (/^\s*(BEGIN\s+)?(CREATE\s+(TABLE|UNIQUE|INDEX|NONCLUSTERED|CLUSTERED)|ALTER\s+TABLE|DROP\s+(TABLE|INDEX)|EXEC(UTE)?\s+sp_)/i.test(c)) return true;
  return false;
}

function separarIdentidade(texto) {
  return foraDeTexto(texto, (p) => p.replace(/([^;\s])(\s+)(SELECT\s+(?:CAST\s*\(\s*)?(?:SCOPE_IDENTITY\s*\(\s*\)|@@IDENTITY\b|@@ROWCOUNT\b))/gi, '$1;$2$3'));
}

function operandoAntes(t, fim) {
  let i = fim;
  while (i > 0 && /\s/.test(t[i - 1])) i--;
  const fimOp = i;
  if (t[i - 1] === "'") {
    let j = i - 2;
    while (j >= 0) { if (t[j] === "'") { if (t[j - 1] === "'") { j -= 2; continue; } break; } j--; }
    return t.slice(j, fimOp);
  }
  if (t[i - 1] === ')') {
    let n = 0;
    let j = i - 1;
    for (; j >= 0; j--) { if (t[j] === ')') n++; else if (t[j] === '(') { n--; if (n === 0) break; } }
    let k = j;
    while (k > 0 && /[\w$]/.test(t[k - 1])) k--;
    return t.slice(k, fimOp);
  }
  let k = i;
  while (k > 0 && /[\w$".]/.test(t[k - 1])) k--;
  return t.slice(k, fimOp);
}

function operandoDepois(t, inicio) {
  let i = inicio;
  while (i < t.length && /\s/.test(t[i])) i++;
  if (t[i] === "'") {
    let j = i + 1;
    while (j < t.length) { if (t[j] === "'") { if (t[j + 1] === "'") { j += 2; continue; } break; } j++; }
    return t.slice(i, j + 1);
  }
  let k = i;
  while (k < t.length && /[\w$".]/.test(t[k])) k++;
  if (t[k] === '(' || (k === i && t[i] === '(')) {
    let n = 0;
    let j = k;
    for (; j < t.length; j++) { if (t[j] === '(') n++; else if (t[j] === ')') { n--; if (n === 0) break; } }
    return t.slice(i, j + 1);
  }
  return t.slice(i, k);
}

function ehTexto(op, colunaTipo) {
  const o = op.trim();
  if (!o) return false;
  if (/^'/.test(o)) return true;
  if (/^(RTRIM|LTRIM|TRIM|UPPER|LOWER|SUBSTRING|SUBSTR|LEFT|RIGHT|REPLACE|CONCAT|REPLICATE|LPAD|RPAD|to_char)\s*\(/i.test(o)) return true;
  if (/^(CAST|CONVERT)\s*\(/i.test(o) && /\bAS\s+(N?VARCHAR|N?CHAR|TEXT|CHARACTER)\b|\(\s*(N?VARCHAR|N?CHAR)\b/i.test(o)) return true;
  if (/^COALESCE\s*\(/i.test(o) && /'/.test(o)) return true;
  if (/^"?[A-Za-z_][\w$]*"?(\s*\.\s*"?[A-Za-z_][\w$]*"?)?$/.test(o)) return colunaTipo(o);
  return false;
}

function tipoDeColuna(g, refs, op) {
  if (!g || !g.tipos || !refs) return null;
  const partes = op.replace(/"/g, '').split('.').map((x) => x.trim().toLowerCase());
  const col = partes.pop();
  const tabelas = partes.length ? [refs.apelidos.get(partes[0])].filter(Boolean) : refs.tabelas;
  for (const tabela of tabelas) {
    const tipo = g.tipos.get(tabela) && g.tipos.get(tabela).get(col);
    if (tipo) return tipo;
  }
  return null;
}

const COLUNA_REF = String.raw`(?<![\w$".])((?:"?[A-Za-z_][\w$]*"?\s*\.\s*)?"?[A-Za-z_][\w$]*"?)`;
const NUMERO = String.raw`(-?\d+(?:\.\d+)?)(?![\w.])`;

function numerosComoTexto(t, grafia) {
  const g = normalizarGrafia(grafia);
  if (!g || !g.tipos || !g.tipos.size) return t;
  const refs = referencias(t, g);
  const texto = (op) => {
    if (PALAVRAS_SQL.has(op.replace(/"/g, '').toUpperCase())) return false;
    const tipo = tipoDeColuna(g, refs, op);
    return !!tipo && /char|text/i.test(tipo);
  };
  return foraDeTexto(t, (p) => p
    .replace(new RegExp(String.raw`${COLUNA_REF}(\s*(?:=|<>|!=|>=|<=|>|<)\s*)${NUMERO}`, 'g'), (m, col, op, num) => (texto(col) ? `${col}${op}'${num}'` : m))
    .replace(/(?<![\w$".])(-?\d+(?:\.\d+)?)(\s*(?:=|<>|!=)\s*)((?:"?[A-Za-z_][\w$]*"?\s*\.\s*)?"?[A-Za-z_][\w$]*"?)(?![\w$"(.])/g,(m, num, op, col) => (texto(col) ? `'${num}'${op}${col}` : m))
    .replace(new RegExp(String.raw`${COLUNA_REF}(\s+(?:NOT\s+)?IN\s*\()(\s*-?\d+(?:\.\d+)?(?:\s*,\s*-?\d+(?:\.\d+)?)*\s*)\)`, 'gi'), (m, col, abre, lista) => (texto(col) ? `${col}${abre}${lista.split(',').map((x) => `'${x.trim()}'`).join(', ')})` : m)));
}

function concatenar(t, grafia) {
  const g = normalizarGrafia(grafia);
  const refs = g && g.colunas.size ? referencias(t, g) : null;
  const colunaTipo = (op) => {
    const tipo = tipoDeColuna(g, refs, op);
    return !!tipo && /char|text|uuid/i.test(tipo);
  };
  let saida = '';
  let i = 0;
  let aspas = false;
  while (i < t.length) {
    const c = t[i];
    if (aspas) { saida += c; if (c === "'") { if (t[i + 1] === "'") { saida += t[++i]; } else aspas = false; } i++; continue; }
    if (c === "'") { aspas = true; saida += c; i++; continue; }
    if (c === '+' && t[i + 1] !== '=') {
      const esquerda = operandoAntes(t, i);
      const direita = operandoDepois(t, i + 1);
      if (ehTexto(esquerda, colunaTipo) || ehTexto(direita, colunaTipo)) { saida += '||'; i++; continue; }
    }
    saida += c;
    i++;
  }
  return saida;
}

function colunaIdentidade(insert, grafia) {
  const g = normalizarGrafia(grafia);
  const m = /^\s*INSERT\s+INTO\s+([^\s(]+)/i.exec(insert);
  if (!g || !g.identidades || !m) return 'id';
  const tabela = m[1].split('.').pop().replace(/[[\]"]/g, '').toLowerCase();
  const real = g.identidades.get(tabela);
  if (!real) return 'id';
  return real === real.toLowerCase() ? real : `"${real}"`;
}

function usarVariaveis(texto, vars) {
  if (!vars.size) return texto;
  return foraDeTexto(texto, (p) => p.replace(/(?<![@\w])@(\w+)(?!\w)/g, (m, n) => {
    const v = vars.get(n.toLowerCase());
    return v ? `CAST((${v.valor}) AS ${v.tipo})` : m;
  }));
}

function declararVariaveis(c, vars) {
  const dec = /^\s*DECLARE\s+([\s\S]+)$/i.exec(c);
  if (dec) {
    for (const item of dividirVirgulas(dec[1])) {
      const m = /^@(\w+)\s+(?:AS\s+)?([A-Za-z]\w*(?:\s*\(\s*(?:\d+|MAX)(?:\s*,\s*\d+)?\s*\))?)\s*(?:=\s*([\s\S]+))?$/i.exec(item.trim());
      if (!m || /^TABLE$/i.test(m[2])) throw new Error('DECLARE de variável de tabela não é suportado no PostgreSQL; escreva a variante desta consulta');
      vars.set(m[1].toLowerCase(), { tipo: m[2], valor: m[3] ? usarVariaveis(m[3].trim(), vars) : 'NULL' });
    }
    return true;
  }
  const set = /^\s*SET\s+@(\w+)\s*=\s*([\s\S]+)$/i.exec(c);
  if (set && vars.has(set[1].toLowerCase())) {
    vars.get(set[1].toLowerCase()).valor = usarVariaveis(set[2].trim(), vars);
    return true;
  }
  return false;
}

function traduzir(sqlTexto, params = {}, prefixo = '@', utc = false, grafia = null) {
  const comandos = dividirComandos(separarIdentidade(sqlTexto));
  const saida = [];
  const variaveis = new Map();
  for (let i = 0; i < comandos.length; i++) {
    if (declararVariaveis(comandos[i], variaveis)) continue;
    const c = usarVariaveis(comandos[i], variaveis);
    const identidade = /^\s*SELECT\s+(?:CAST\s*\(\s*)?SCOPE_IDENTITY\s*\(\s*\)(?:\s+AS\s+\w+\s*\))?\s+AS\s+(\w+)\s*$/i.exec(c) || /^\s*SELECT\s+@@IDENTITY\s+AS\s+(\w+)\s*$/i.exec(c);
    if (identidade && saida.length && /^\s*INSERT\b/i.test(comandos[i - 1])) {
      saida[saida.length - 1] = `${saida[saida.length - 1].trimEnd()} RETURNING ${colunaIdentidade(comandos[i - 1], grafia)} AS "${identidade[1]}"`;
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
  const tipos = new Map();
  const identidades = new Map();
  for (const l of linhas) if (l.i) identidades.set(l.t.toLowerCase(), l.c);
  for (const l of linhas) if (l.d) { const kt = l.t.toLowerCase(); if (!tipos.has(kt)) tipos.set(kt, new Map()); tipos.get(kt).set(l.c.toLowerCase(), l.d); }
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
  return { tabelas, colunas, global, esquemas, tipos, identidades };
}

const grafias = new Map();
function grafiaDoBanco(cliente) {
  if (process.env.PG_GRAFIA === 'minusculas') return Promise.resolve(null);
  const banco = (cliente && cliente.database) || process.env.PG_DATABASE || '';
  if (!grafias.has(banco)) {
    grafias.set(banco, cliente.query(`
      SELECT c.table_schema AS s, c.table_name AS t, c.column_name AS c, c.data_type AS d, (c.is_identity = 'YES' OR c.column_default LIKE 'nextval%') AS i FROM information_schema.columns c
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
  const banco = ESQUEMAS ? (padraoValido || [...citados][0] || padrao) : (citados.size === 1 ? [...citados][0] : padrao);
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
