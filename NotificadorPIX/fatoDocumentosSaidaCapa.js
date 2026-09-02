const { Model, DataTypes } = require('sequelize');
const sequelizeDW = require('./databaseDW');

class FatoDocumentosSaidaCapa extends Model {}

FatoDocumentosSaidaCapa.init({
    NF: { type: DataTypes.STRING, allowNull: false, primaryKey: true },
    COD_PESSOA: { type: DataTypes.STRING, allowNull: true },
}, {
    sequelize: sequelizeDW,
    modelName: 'FatoDocumentosSaidaCapa',
    tableName: 'FATO_DOCUMENTOS_SAIDA_CAPA',
    timestamps: false,
});

module.exports = FatoDocumentosSaidaCapa;
