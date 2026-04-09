const { Model, DataTypes } = require('sequelize');
const sequelizeP11Prod = require('./databaseP11Prod');

class VPagamentosPix extends Model {}

VPagamentosPix.init({
    TXID: { type: DataTypes.STRING, primaryKey: true },
    CLIENTE: { type: DataTypes.STRING, allowNull: true },
    NF: { type: DataTypes.STRING, allowNull: true },
    PARCELA: { type: DataTypes.STRING, allowNull: true },
    DT_EMISSAO: { type: DataTypes.STRING, allowNull: true },
    VALOR: { type: DataTypes.FLOAT, allowNull: true },
    DT_PAGTO: { type: DataTypes.STRING, allowNull: true },
    HR_PAGTO: { type: DataTypes.STRING, allowNull: true },
    STENVW: { type: DataTypes.STRING, allowNull: true },
    FRMPAG: { type: DataTypes.STRING, allowNull: true },
}, {
    sequelize: sequelizeP11Prod,
    modelName: 'VPagamentosPix',
    tableName: 'V_PAGAMENTOS_PIX',
    timestamps: false,
});

module.exports = VPagamentosPix;
