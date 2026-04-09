const { Model, DataTypes } = require('sequelize');
const sequelizeP11Prod = require('./databaseP11Prod');

class Z16010 extends Model {}

Z16010.init({
    R_E_C_N_O_: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    Z16_TXID: { type: DataTypes.STRING, allowNull: true },
    Z16_FILIAL: { type: DataTypes.STRING, allowNull: true },
    Z16_DTBAIX: { type: DataTypes.STRING, allowNull: true },
    Z16_HRBAIX: { type: DataTypes.STRING, allowNull: true },
    Z16_VALOR: { type: DataTypes.FLOAT, allowNull: true },
    Z16_STATUS: { type: DataTypes.STRING, allowNull: true },
    Z16_DTPROC: { type: DataTypes.STRING, allowNull: true },
    Z16_HRPROC: { type: DataTypes.STRING, allowNull: true },
    Z16_STENVW: { type: DataTypes.STRING, allowNull: true },
    Z16_E2EID: { type: DataTypes.STRING, allowNull: true },
}, {
    sequelize: sequelizeP11Prod,
    modelName: 'Z16010',
    tableName: 'Z16010',
    timestamps: false,
});

module.exports = Z16010;
