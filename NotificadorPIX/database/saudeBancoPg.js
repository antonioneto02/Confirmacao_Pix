'use strict';

const sql = require('./mssqlPg');

const pools = new Map();

function poolDe(banco) {
  if (!pools.has(banco)) {
    const pool = new sql.ConnectionPool({ database: banco });
    pools.set(banco, pool.connect().catch((e) => { pools.delete(banco); throw e; }));
  }
  return pools.get(banco);
}

module.exports = (consulta, banco = 'dw') => async (_req, res) => {
  const dialeto = sql.dialeto();
  if (dialeto !== 'postgres') return res.json({ ok: true, dialeto });
  try {
    const pool = await poolDe(banco);
    await pool.request().query(consulta);
    return res.json({ ok: true, dialeto });
  } catch (e) {
    return res.status(503).json({ ok: false, dialeto, erro: 'banco indisponível' });
  }
};
