const { Model, DataTypes } = require('sequelize');
const sequelizeDW = require('./databaseDW');
class FilaNotificacoes extends Model {}

FilaNotificacoes.init({
    ID: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    TIPO_MENSAGEM: { type: DataTypes.STRING, allowNull: false },
    DESTINATARIO: { type: DataTypes.STRING, allowNull: false },
    MENSAGEM: { type: DataTypes.STRING, allowNull: true },
    TEMPLATE_NAME: { type: DataTypes.STRING, allowNull: true },
    TEMPLATE_PARAMS: { type: DataTypes.STRING, allowNull: true },
    STATUS: { type: DataTypes.STRING, defaultValue: 'PENDENTE' },
    TENTATIVAS: { type: DataTypes.INTEGER, defaultValue: 0 },
    ERRO: { type: DataTypes.STRING, allowNull: true },
    DTINC: { type: DataTypes.DATE, allowNull: true },
    DTENVIO: { type: DataTypes.DATE, allowNull: true },
    MESSAGE_ID: { type: DataTypes.STRING, allowNull: true },
    METADADOS: { type: DataTypes.STRING, allowNull: true },
}, {
    sequelize: sequelizeDW,
    modelName: 'FilaNotificacoes',
    tableName: 'FATO_FILA_NOTIFICACOES',
    timestamps: false,
});

module.exports = FilaNotificacoes;
