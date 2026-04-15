const { Sequelize } = require('sequelize');
require('dotenv').config();

const { DB_HOST, DB_USER, DB_PASSWORD_NERIAS } = process.env;

const sequelizeP11Prod = new Sequelize('p11_prod', DB_USER, DB_PASSWORD_NERIAS, {
    host: DB_HOST,
    dialect: 'mssql',
    logging: false,
    pool: {
        max: 5,
        min: 1,
        acquire: 30000,
        idle: 10000,
    },
});

sequelizeP11Prod.authenticate()
    .then(() => console.log('Conexão ao banco p11_prod bem-sucedida!'))
    .catch(err => console.error('Erro ao conectar ao p11_prod:', err));

module.exports = sequelizeP11Prod;