const { Model, DataTypes } = require('sequelize');
const sequelizeDW = require('./databaseDW');

class FatoItensCargas extends Model {}

FatoItensCargas.init({
    RECNO: { type: DataTypes.INTEGER, primaryKey: true },
    CODFIL: { type: DataTypes.STRING, allowNull: true },
    NF: { type: DataTypes.STRING, allowNull: true },
    CARGA: { type: DataTypes.STRING, allowNull: true },
}, {
    sequelize: sequelizeDW,
    modelName: 'FatoItensCargas',
    tableName: 'FATO_ITENS_CARGAS',
    timestamps: false,
});

module.exports = FatoItensCargas;
