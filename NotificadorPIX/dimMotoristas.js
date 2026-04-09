const { Model, DataTypes } = require('sequelize');
const sequelizeDW = require('./databaseDW');

class DimMotoristas extends Model {}

DimMotoristas.init({
    RECNO: { type: DataTypes.INTEGER, primaryKey: true },
    COD_MOTORISTA: { type: DataTypes.STRING, allowNull: true },
    NOME: { type: DataTypes.STRING, allowNull: true },
    WHATSAPP: { type: DataTypes.STRING, allowNull: true },
    ENVIAR_HANDSHAKE: { type: DataTypes.STRING, allowNull: true },
}, {
    sequelize: sequelizeDW,
    modelName: 'DimMotoristas',
    tableName: 'DIM_MOTORISTAS',
    timestamps: false,
});

module.exports = DimMotoristas;
