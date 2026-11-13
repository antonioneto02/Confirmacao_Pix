'use strict';

const sqlPg = require('./mssqlPg');

const PG = sqlPg.dialeto() === 'postgres';
const SQL_CATALOGO = `SELECT c.table_schema AS s, c.table_name AS t, c.column_name AS c FROM information_schema.columns c
  WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')`;
const DDL = /\b(CREATE\s+(TABLE|UNIQUE|INDEX|VIEW|SCHEMA|SEQUENCE|TYPE|TRIGGER|FUNCTION|PROCEDURE|OR\s+REPLACE)|ALTER\s+(TABLE|VIEW|SCHEMA|SEQUENCE|TYPE|INDEX)|DROP\s+(TABLE|INDEX|VIEW|SCHEMA|SEQUENCE|TYPE|CONSTRAINT|TRIGGER|FUNCTION|PROCEDURE)|TRUNCATE(\s+TABLE)?\s+[\w"[])/i;
const PARECE_TSQL =/\[[A-Za-z_][\w ]*\]|\bTOP\s*\(?\s*[\d@:]|\bGETDATE\s*\(|\bISNULL\s*\(|\bNOLOCK\b|\bdbo\.|\bNVARCHAR\b|\bOUTPUT\s+INSERTED\b|\bDATEADD\s*\(|\bDATEDIFF\s*\(|\bCONVERT\s*\(|\bLEN\s*\(|\bCHARINDEX\s*\(|@@|\bIIF\s*\(|\bTRY_CONVERT\s*\(|\bTRY_CAST\s*\(|\bMERGE\b|\bOUTER\s+APPLY\b|\bCROSS\s+APPLY\b|\bFORMAT\s*\(|\bYEAR\s*\(|\bMONTH\s*\(|\bDAY\s*\(|\bCOLLATE\b/i;

const bancoNoPostgres = (nome) => process.env[`PG_BANCO_${String(nome).toUpperCase()}`] || nome;

const grafias = new Map();
function carregarGrafia(original, banco) {
  if (process.env.PG_GRAFIA === 'minusculas') return Promise.resolve(null);
  if (!grafias.has(banco)) {
    const p = new Promise((ok, falha) => original(SQL_CATALOGO, (e, r) => (e ? falha(e) : ok(sqlPg.__interno.montarGrafia(r.rows)))));
    grafias.set(banco, p.catch((e) => { grafias.delete(banco); throw e; }));
  }
  return grafias.get(banco);
}

function envolverConexao(conexao, banco) {
  if (conexao.__grafiaCini) return;
  conexao.__grafiaCini = true;
  const original = conexao.query.bind(conexao);
  conexao.query = function query(texto, ...resto) {
    const cb = typeof resto[resto.length - 1] === 'function' ? resto.pop() : null;
    if (typeof texto !== 'string') return original(texto, ...resto, ...(cb ? [cb] : []));
    const executar = async () => {
      const grafia = await carregarGrafia(original, banco);
      const ajustado = sqlPg.__interno.ajustarGrafia(texto.replace(/"dbo"\s*\.\s*(?=")/gi, ''), grafia);
      const r = await new Promise((ok, falha) => original(ajustado, ...resto, (e, res) => (e ? falha(e) : ok(res))));
      if (r && Array.isArray(r.rows) && r.rows.length) r.rows = sqlPg.__interno.grafiaDasChaves(texto, r.rows);
      return r;
    };
    const promessa = executar();
    if (cb) { promessa.then((r) => cb(null, r), (e) => cb(e)); return undefined; }
    return promessa;
  };
}

function criar(Sequelize, { banco: bancoInformado, usuario, senha, host, porta, opcoes = {}, opcoesPostgres = {} }) {
  const banco = bancoInformado || (PG ? process.env.PG_DATABASE : bancoInformado);
  if (!PG || sqlPg.destinoDaConsulta('', banco).tipo === 'mssql') return new Sequelize(banco, usuario, senha, { host, port: porta ? Number(porta) : undefined, dialect: 'mssql', ...opcoes });

  const nome = bancoNoPostgres(banco);
  const esquemas = sqlPg.modoEsquemas();
  const bancoPg = esquemas ? process.env.PG_DATABASE : nome;
  const { dialectOptions: _ignorado, ...semDialeto } = opcoes;
  const ssl = process.env.PG_SSL === '1' ? { ssl: { rejectUnauthorized: false } } : {};
  const instancia = new Sequelize(bancoPg, process.env.PG_USER, process.env.PG_PASSWORD, {
    ...semDialeto,
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT || 5432),
    dialect: 'postgres',
    timezone: opcoes.timezone || 'America/Sao_Paulo',
    dialectOptions: esquemas ? { ...ssl, options: `-c search_path="${nome}",public` } : ssl,
    ...opcoesPostgres,
    hooks: { ...(opcoes.hooks || {}), afterConnect: (conexao) => envolverConexao(conexao, bancoPg) },
  });

  let legado = null;
  const sqlServer = () => {
    if (!legado) legado = new Sequelize(banco, usuario, senha, { host, port: porta ? Number(porta) : undefined, dialect: 'mssql', ...opcoes });
    return legado;
  };

  const queryOriginal = instancia.query.bind(instancia);
  instancia.query = function query(sqlOuObjeto, opcoesQuery = {}) {
    const texto = typeof sqlOuObjeto === 'string' ? sqlOuObjeto : sqlOuObjeto && sqlOuObjeto.query;
    const vazio = () => Promise.resolve(opcoesQuery && opcoesQuery.type === 'SELECT' ? [] : [[], 0]);
    if (typeof texto === 'string' && DDL.test(texto.replace(/'(?:[^']|'')*'/g, "''"))) return vazio();
    if (typeof texto !== 'string' || (opcoesQuery && (opcoesQuery.model || opcoesQuery.instance))) return queryOriginal(sqlOuObjeto, opcoesQuery);
    const destino = sqlPg.destinoDaConsulta(texto, banco);
    if (destino.tipo === 'mssql') return sqlServer().query(sqlOuObjeto, opcoesQuery);
    if (!esquemas && destino.banco !== nome) throw new Error(`consulta do banco ${destino.banco} feita pela conexão de ${nome}: use a conexão desse banco`);
    if (!PARECE_TSQL.test(texto)) return queryOriginal(sqlOuObjeto, opcoesQuery);
    const traduzido = sqlPg.traduzir(texto, {}, '@').filter((c) => !c.startsWith('--ROWCOUNT')).join(';\n');
    if (!traduzido.trim()) return vazio();
    return queryOriginal(typeof sqlOuObjeto === 'string' ? traduzido : { ...sqlOuObjeto, query: traduzido }, opcoesQuery);
  };
  const fecharOriginal = instancia.close.bind(instancia);
  instancia.close = async () => {
    await fecharOriginal();
    if (legado) await legado.close();
  };
  const semAlterarTabelas = async function () { return this; };
  instancia.sync = semAlterarTabelas;
  instancia.drop = semAlterarTabelas;
  instancia.addHook('afterDefine', (model) => {
    model.sync = semAlterarTabelas;
    model.drop = semAlterarTabelas;
  });
  return instancia;
}

module.exports = { criar, envolverConexao, bancoNoPostgres, dialeto: sqlPg.dialeto };
