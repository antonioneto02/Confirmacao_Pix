const express = require('express');
const { Op } = require('sequelize');
require('dotenv').config();
const logger = require('./logger');
const Z16010 = require('./z16010');
const VPagamentosPix = require('./vPagamentosPix');
const FatoItensCargas = require('./fatoItensCargas');
const FatoCargas = require('./fatoCargas');
const DimMotoristas = require('./dimMotoristas');
const FilaNotificacoes = require('./filaNotificacoes');
const METODO_ENVIO_CONFIRMACAO_PIX = 'bot'; // Mude para "template" para usar API oficial do Facebook
const INTERVALO_POLLING_MS = 120_000;
const PORT = parseInt(process.env.PORT);

// ex: '20260415'
const POLLING_DATA_FIXA = null;

function getDataPolling() {
    if (POLLING_DATA_FIXA) return POLLING_DATA_FIXA;
    const hoje = new Date();
    const ano = hoje.getFullYear();
    const mes = String(hoje.getMonth() + 1).padStart(2, '0');
    const dia = String(hoje.getDate()).padStart(2, '0');
    return `${ano}${mes}${dia}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const txidsEmProcessamento = new Set();
const txidsPendentesPolling = new Set();
const txidsBoleto = new Set();
const txidsFalhos = new Map(); 
const TTL_FALHOS_MS = 60 * 60 * 1000; 

function limparFalhosExpirados() {
    const agora = Date.now();
    for (const [txid, entry] of txidsFalhos) {
        if (agora - entry.timestamp > TTL_FALHOS_MS) {
            txidsFalhos.delete(txid);
        }
    }
}

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

async function processarTxid(txid, fromPolling = false) {
    if (txidsEmProcessamento.has(txid)) {
        return null;
    }
    if (txidsBoleto.has(txid)) {
        return null;
    }
    if (txidsFalhos.has(txid)) {
        return null;
    }
    txidsEmProcessamento.add(txid);

    try {
        if (!fromPolling) {
            const baixaExistente = await Z16010.findOne({ where: { Z16_TXID: txid } });
            if (baixaExistente && baixaExistente.Z16_STENVW === '1') {
                return null;
            }
        }

        return await _processarTxidInterno(txid);
    } finally {
        txidsEmProcessamento.delete(txid);
    }
}

async function _processarTxidInterno(txid) {
    const pagamento = await VPagamentosPix.findOne({
        where: {
            TXID: txid,
            FRMPAG: { [Op.ne]: 'BOL' },
        },
        raw: true,
    });
    if (!pagamento) {
        const boleto = await VPagamentosPix.findOne({ where: { TXID: txid, FRMPAG: 'BOL' }, raw: true });
        if (boleto) {
            txidsBoleto.add(txid);
            logger.info(`[Ignorado] TXID ${txid} é boleto — encontrado em V_PAGAMENTOS_PIX.`);
        } else {
            txidsFalhos.set(txid, { motivo: 'sem registro em V_PAGAMENTOS_PIX', timestamp: Date.now() });
            logger.warn(`[Falho] TXID ${txid} — sem registro em V_PAGAMENTOS_PIX.`);
        }
        return false;
    }

    const itemCarga = await FatoItensCargas.findOne({ where: { NF: pagamento.NF }, raw: true });
    if (!itemCarga) {
        txidsFalhos.set(txid, { motivo: `NF ${pagamento.NF} não encontrada em FATO_ITENS_CARGAS`, timestamp: Date.now() });
        logger.warn(`[Falho] TXID ${txid} — NF ${pagamento.NF} não encontrada em FATO_ITENS_CARGAS.`);
        return false;
    }

    const carga = await FatoCargas.findOne({ where: { CARGA: itemCarga.CARGA }, raw: true });
    if (!carga) {
        txidsFalhos.set(txid, { motivo: `CARGA ${itemCarga.CARGA} não encontrada em FATO_CARGAS`, timestamp: Date.now() });
        logger.warn(`[Falho] TXID ${txid} — CARGA ${itemCarga.CARGA} não encontrada em FATO_CARGAS.`);
        return false;
    }

    const motorista = await DimMotoristas.findOne({ where: { COD_MOTORISTA: carga.CODMOTORI }, raw: true });
    if (!motorista) {
        txidsFalhos.set(txid, { motivo: `CODMOTORI "${carga.CODMOTORI}" não encontrado em DIM_MOTORISTAS`, timestamp: Date.now() });
        logger.warn(`[Falho] TXID ${txid} — CODMOTORI "${carga.CODMOTORI}" não encontrado em DIM_MOTORISTAS.`);
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

    txidsPendentesPolling.delete(txid);
    logger.info(`Notificação enfileirada para ${motorista.WHATSAPP} — TXID: ${txid}`);

    await enfileirarAlertaGoogleChat(mensagem);
    const [linhasAfetadas] = await Z16010.update(
        { Z16_STENVW: '1' },
        { where: { Z16_TXID: txid } }
    );
    if (linhasAfetadas > 0) {
        logger.info(`Z16_STENVW atualizado para '1' — TXID: ${txid}`);
    }

    return true;
}

const { swaggerUi, swaggerDocument } = require('./swagger');

const app = express();
app.use(express.json());
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
app.post('/notificar', async (req, res) => {
    const { txid } = req.body;
    if (!txid) {
        return res.status(400).json({ erro: 'txid é obrigatório' });
    }

    if (txid.toUpperCase().startsWith('RE')) {
        return res.status(200).json({ status: 'ignorado', txid });
    }

    if (txidsPendentesPolling.has(txid)) {
        return res.status(200).json({ status: 'aguardando_polling', txid });
    }

    logger.info(`[API] Recebido pedido de notificação — TXID: ${txid}`);

    try {
        const ok = await processarTxid(txid);
        if (ok === false) {
            txidsPendentesPolling.add(txid);
            logger.warn(`[API] TXID não encontrado na view — será processado pelo polling: ${txid}`);
        }
        return res.status(200).json({ status: 'ok', txid });
    } catch (err) {
        logger.error(`[API] Erro ao processar TXID ${txid}: ${err.message}`);
        await enfileirarAlertaGoogleChat(`Erro ao processar confirmação PIX. TXID: ${txid}: ${err.message}`);
        return res.status(500).json({ erro: err.message });
    }
});

const LIMITE_POLLING   = 100;
const CONCORRENCIA     = 3;
const INTERVALO_CURTO  = 120_000;   // 2 min — quando há pendentes conhecidos
const INTERVALO_LONGO  = 600_000;   // 10 min — quando está tudo processado

async function pollingLoop() {
    // Delay inicial aleatório (15-45s) para desincronizar do log-watcher
    const jitter = 15_000 + Math.floor(Math.random() * 30_000);
    logger.info(`[Polling] Iniciado — primeiro ciclo em ${Math.round(jitter / 1000)}s.`);
    await sleep(jitter);

    while (true) {
        let intervalo = INTERVALO_LONGO;
        try {
            limparFalhosExpirados();

            const dataPolling = getDataPolling();
            const pendentes = await Z16010.findAll({
                attributes: ['Z16_TXID'],
                where: {
                    Z16_STENVW: '0',
                    Z16_DTBAIX: dataPolling,
                    Z16_TXID: {
                        [Op.and]: [
                            { [Op.ne]: null },
                            { [Op.gt]: ' ' },
                            { [Op.notLike]: 'RE%' },
                        ],
                    },
                },
                limit: LIMITE_POLLING,
                raw: true,
            });

            if (pendentes.length === 0) {
                logger.info(`[Polling] ${dataPolling} — nenhum pendente. Próximo em ${INTERVALO_LONGO / 60000} min.`);
            } else {
                intervalo = INTERVALO_CURTO; // tem trabalho: volta em 2 min
                const paraProcessar = pendentes.filter(b =>
                    !txidsBoleto.has(b.Z16_TXID) &&
                    !txidsFalhos.has(b.Z16_TXID) &&
                    !txidsEmProcessamento.has(b.Z16_TXID)
                );
                logger.info(
                    `[Polling] ${dataPolling} — ${pendentes.length} pendente(s), ` +
                    `${paraProcessar.length} novo(s). Próximo em ${intervalo / 60000} min.`
                );
                for (let i = 0; i < paraProcessar.length; i += CONCORRENCIA) {
                    const lote = paraProcessar.slice(i, i + CONCORRENCIA);
                    await Promise.all(lote.map(async (baixa) => {
                        try {
                            await processarTxid(baixa.Z16_TXID, true);
                        } catch (err) {
                            logger.error(`[Polling] Erro ao processar TXID ${baixa.Z16_TXID}: ${err.message}`);
                            await enfileirarAlertaGoogleChat(`[Polling] Erro ao processar PIX. TXID: ${baixa.Z16_TXID}: ${err.message}`);
                        }
                    }));
                }
            }
        } catch (err) {
            logger.error(`[Polling] Erro ao buscar pendentes: ${err.message}`);
        }
        await sleep(intervalo);
    }
}

app.listen(PORT, () => {
    logger.info(`NotificadorPIX API ouvindo na porta ${PORT}`);
    pollingLoop();
});
