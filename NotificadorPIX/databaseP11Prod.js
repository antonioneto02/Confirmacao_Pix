const { Sequelize } = require('sequelize');
require('dotenv').config();

const { DB_HOST, DB_USER, DB_PASSWORD_NERIAS } = process.env;
// Banco do Protheus no servidor remoto (o mesmo das demais APIs). O antigo p2510 não é mais usado.
const DB_NAME_P11PROD = process.env.DB_NAME_P11PROD || 'p2510';

const sequelizeP11Prod = require('./database/sequelizePg').criar(Sequelize, {
  banco: DB_NAME_P11PROD,
  usuario: DB_USER,
  senha: DB_PASSWORD_NERIAS,
  host: DB_HOST,
  opcoes: {
    dialectOptions: {
        options: {
            connectTimeout: 5000,
        },
    },
    logging: false,
    pool: {
        max: 5,
        min: 1,
        acquire: 30000,
        idle: 10000,
    },
  },
});

sequelizeP11Prod.authenticate()
    .then(() => console.log(`Conexão ao banco ${DB_NAME_P11PROD} (${DB_HOST}) bem-sucedida!`))
    .catch(err => console.error(`Erro ao conectar ao ${DB_NAME_P11PROD} (${DB_HOST}):`, err));

module.exports = sequelizeP11Prod;