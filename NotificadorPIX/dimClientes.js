const { Model, DataTypes } = require('sequelize');
const sequelizeDW = require('./databaseDW');

class DimClientes extends Model {}

DimClientes.init({
    COD_CLIENTE: { type: DataTypes.STRING, allowNull: false, primaryKey: true },
    NOME: { type: DataTypes.STRING, allowNull: true },
    FANTASIA: { type: DataTypes.STRING, allowNull: true },
    DDD: { type: DataTypes.STRING, allowNull: true },
    TEL: { type: DataTypes.STRING, allowNull: true },
}, {
    sequelize: sequelizeDW,
    modelName: 'DimClientes',
    tableName: 'DIM_CLIENTES',
    timestamps: false,
});

module.exports = DimClientes;
