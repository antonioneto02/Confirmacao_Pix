const { Model, DataTypes } = require('sequelize');
const sequelizeDW = require('./databaseDW');

class FatoCargas extends Model {}

FatoCargas.init({
    RECNO: { type: DataTypes.INTEGER, primaryKey: true },
    CODFIL: { type: DataTypes.STRING, allowNull: true },
    CARGA: { type: DataTypes.STRING, allowNull: true },
    DATA: { type: DataTypes.DATEONLY, allowNull: true },
    CODMOTORI: { type: DataTypes.STRING, allowNull: true },
}, {
    sequelize: sequelizeDW,
    modelName: 'FatoCargas',
    tableName: 'FATO_CARGAS',
    timestamps: false,
});

module.exports = FatoCargas;
