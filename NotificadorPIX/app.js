const express = require('express');
const { Op } = require('sequelize');
const winston = require('winston');
require('dotenv').config();

const Z16010 = require('./z16010');
const VPagamentosPix = require('./vPagamentosPix');
const FatoItensCargas = require('./fatoItensCargas');
const FatoCargas = require('./fatoCargas');
const DimMotoristas = require('./dimMotoristas');
const FilaNotificacoes = require('./filaNotificacoes');

const METODO_ENVIO_CONFIRMACAO_PIX = 'bot'; // Mude para "template" para usar API oficial do Facebook
const INTERVALO_FALLBACK_MS = parseInt(process.env.INTERVALO_MS || '30000', 10);
const PORT = parseInt(process.env.PORT || '3001', 10);

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`)
    ),
    transports: [new winston.transports.Console()],
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function enfileirarAlertaGoogleChat(mensagem) {
    try {
        await FilaNotificacoes.create({
            TIPO_MENSAGEM: 'google_chat',
            DESTINATARIO: 'google_chat_webhook',
            MENSAGEM: mensagem,
            TEMPLATE_NAME: null,
            TEMPLATE_PARAMS: JSON.stringify({}),
            STATUS: 'PENDENTE',
            TENTATIVAS: 0,
            METADADOS: JSON.stringify({ origem: 'NotificadorPIX' }),
        });
    } catch (err) {
        logger.error(`Erro ao enfileirar alerta Google Chat: ${err.message}`);
    }
}

// Lógica central: busca tudo pelo txid e salva na fila.
// Retorna true se processou com sucesso, false se não encontrou dados, lança erro em falhas de banco.
async function processarTxid(txid) {
    const pagamento = await VPagamentosPix.findOne({
        where: {
            TXID: txid,
            FRMPAG: { [Op.ne]: 'BOL' },
        },
    });
    if (!pagamento) {
        logger.warn(`V_PAGAMENTOS_PIX não encontrado para TXID: ${txid}`);
        return false;
    }

    const itemCarga = await FatoItensCargas.findOne({ where: { NF: pagamento.NF } });
    if (!itemCarga) {
        logger.warn(`FATO_ITENS_CARGAS não encontrado para NF: ${pagamento.NF}`);
        return false;
    }

    const carga = await FatoCargas.findOne({ where: { CARGA: itemCarga.CARGA } });
    if (!carga) {
        logger.warn(`FATO_CARGAS não encontrada para CARGA: ${itemCarga.CARGA}`);
        return false;
    }

    const motorista = await DimMotoristas.findOne({ where: { COD_MOTORISTA: carga.CODMOTORI } });
    if (!motorista) {
        logger.warn(`DIM_MOTORISTAS não encontrado para CODMOTORI: ${carga.CODMOTORI}`);
        return false;
    }

    const tipoMsg = METODO_ENVIO_CONFIRMACAO_PIX === 'template'
        ? 'confirmacao_pix_template'
        : 'confirmacao_pix_bot';

    const mensagem =
        `CONFIRMAÇÃO DE PAGAMENTO - PIX\n` +
        `Cliente: ${pagamento.CLIENTE}\n` +
        `Número da Nota: ${pagamento.NF}\n` +
        `Data Emissão: ${pagamento.DT_EMISSAO}\n` +
        `Valor: *${pagamento.VALOR}*\n` +
        `Data Pagto: ${pagamento.DT_PAGTO}\n` +
        `Hora Pagto: ${pagamento.HR_PAGTO}\n` +
        `TXID: ${pagamento.TXID}`;

    await FilaNotificacoes.create({
        TIPO_MENSAGEM: tipoMsg,
        DESTINATARIO: motorista.WHATSAPP,
        MENSAGEM: mensagem,
        TEMPLATE_NAME: tipoMsg === 'confirmacao_pix_template' ? 'confirmacao_pagamento_pix' : null,
        TEMPLATE_PARAMS: JSON.stringify({
            cliente: pagamento.CLIENTE,
            nf: pagamento.NF,
            dt_emissao: pagamento.DT_EMISSAO,
            valor: String(pagamento.VALOR),
            dt_pagto: pagamento.DT_PAGTO,
            hr_pagto: pagamento.HR_PAGTO,
            txid,
        }),
        STATUS: 'PENDENTE',
        TENTATIVAS: 0,
        METADADOS: JSON.stringify({ nf: pagamento.NF, txid, origem: 'NotificadorPIX' }),
    });

    logger.info(`Notificação enfileirada para ${motorista.WHATSAPP} — TXID: ${txid}`);

    await enfileirarAlertaGoogleChat(mensagem);

    // Marca como processado na Z16010
    const baixa = await Z16010.findOne({ where: { Z16_TXID: txid } });
    if (baixa) {
        baixa.Z16_STENVW = '1';
        await baixa.save();
        logger.info(`Z16_STENVW atualizado para '1' — TXID: ${txid}`);
    }

    return true;
}

// ─── API HTTP ────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// POST /notificar  { txid: "...", ...outrosDadosOpcionais }
app.post('/notificar', async (req, res) => {
    const { txid } = req.body;
    if (!txid) {
        return res.status(400).json({ erro: 'txid é obrigatório' });
    }

    logger.info(`[API] Recebido pedido de notificação — TXID: ${txid}`);
    try {
        const ok = await processarTxid(txid);
        if (!ok) {
            return res.status(404).json({ aviso: 'Dados não encontrados para este txid. Ficará pendente no fallback.' });
        }
        return res.status(200).json({ status: 'ok', txid });
    } catch (err) {
        logger.error(`[API] Erro ao processar TXID ${txid}: ${err.message}`);
        await enfileirarAlertaGoogleChat(`Erro ao processar confirmação PIX. TXID: ${txid}: ${err.message}`);
        return res.status(500).json({ erro: err.message });
    }
});

// ─── FALLBACK: polling da Z16010 ─────────────────────────────────────────────

async function fallbackLoop() {
    while (true) {
        await sleep(INTERVALO_FALLBACK_MS);
        try {
            const pendentes = await Z16010.findAll({
                where: {
                    Z16_STENVW: '0',
                    Z16_TXID: { [Op.and]: [{ [Op.ne]: null }, { [Op.gt]: ' ' }] },
                },
            });

            if (pendentes.length > 0) {
                logger.info(`[Fallback] ${pendentes.length} registro(s) pendente(s) na Z16010.`);
                for (const baixa of pendentes) {
                    try {
                        await processarTxid(baixa.Z16_TXID);
                    } catch (err) {
                        logger.error(`[Fallback] Erro ao processar TXID ${baixa.Z16_TXID}: ${err.message}`);
                        await enfileirarAlertaGoogleChat(`[Fallback] Erro ao processar PIX. TXID: ${baixa.Z16_TXID}: ${err.message}`);
                    }
                }
            }
        } catch (err) {
            logger.error(`[Fallback] Erro ao buscar pendentes: ${err.message}`);
        }
    }
}

// ─── INICIALIZAÇÃO ────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    logger.info(`NotificadorPIX API ouvindo na porta ${PORT}`);
    logger.info(`Fallback polling a cada ${INTERVALO_FALLBACK_MS / 1000}s`);
    fallbackLoop();
});
