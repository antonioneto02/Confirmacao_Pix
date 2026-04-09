const { Sequelize } = require('sequelize');
require('dotenv').config();

const { DB_HOST, DB_USER, DB_PASSWORD_NERIAS } = process.env;

const sequelizeDW = new Sequelize('dw', DB_USER, DB_PASSWORD_NERIAS, {
    host: DB_HOST,
    dialect: 'mssql',
    logging: false,
});

sequelizeDW.authenticate()
    .then(() => console.log('Conexão ao banco dw bem-sucedida!'))
    .catch(err => console.error('Erro ao conectar ao dw:', err));

module.exports = sequelizeDW;