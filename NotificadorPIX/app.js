const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');
require('dotenv').config();
const logger = require('./logger');
const Z16010 = require('./z16010');
const VPagamentosPix = require('./vPagamentosPix');
const FatoItensCargas = require('./fatoItensCargas');
const FatoCargas = require('./fatoCargas');
const DimMotoristas = require('./dimMotoristas');
const FatoDocumentosSaidaCapa = require('./fatoDocumentosSaidaCapa');
const DimClientes = require('./dimClientes');
const FilaNotificacoes = require('./filaNotificacoes');
const NUMERO_CONTATO_CINI = process.env.NUMERO_CONTATO || '4130013000';
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
    if (txidsFalhos.has(txid)) {
        return null;
    }
    txidsEmProcessamento.add(txid);

    try {
        // Revalida sempre, mesmo vindo do polling: a lista de pendentes do polling é um
        // snapshot da query SQL, e pode ficar desatualizada durante o processamento em lote
        // (alguns segundos) — se uma chamada /notificar concorrente já tiver processado e
        // marcado STENVW='1' nesse meio tempo, processar de novo pelo polling duplicava a
        // notificação (mesmo TXID enfileirado 2x).
        const baixaExistente = await Z16010.findOne({ where: { Z16_TXID: txid } });
        if (baixaExistente && baixaExistente.Z16_STENVW === '1') {
            return null;
        }
        if (!fromPolling) {
            if (baixaExistente && parseInt(baixaExistente.Z16_TPLIQ) !== 2) {
                logger.info(`[Skip] TXID ${txid} — Z16_TPLIQ=${baixaExistente.Z16_TPLIQ}, notificação ignorada (não é PIX).`);
                return null;
            }
        }

        return await _processarTxidInterno(txid);
    } finally {
        txidsEmProcessamento.delete(txid);
    }
}

function registrarFalha(txid, motivo) {
    txidsFalhos.set(txid, { motivo, timestamp: Date.now() });
    logger.warn(`[Falho] TXID ${txid} — ${motivo}.`);
}

function montarTelefoneCliente(ddd, tel) {
    const limpo = (String(ddd || '') + String(tel || '')).replace(/\D/g, '');
    if (limpo.length < 10) return null;
    return limpo.startsWith('55') ? limpo : `55${limpo}`;
}

async function enfileirarConfirmacaoParaCliente(pagamento, hrPagto) {
    try {
        const documentoInfo = await FatoDocumentosSaidaCapa.findOne({ where: { NF: pagamento.NF }, raw: true });
        if (!documentoInfo || !documentoInfo.COD_PESSOA) {
            logger.info(`[Cliente] NF ${pagamento.NF} sem COD_PESSOA em FATO_DOCUMENTOS_SAIDA_CAPA — não é possível notificar o cliente.`);
            return;
        }

        const cliente = await DimClientes.findOne({ where: { COD_CLIENTE: documentoInfo.COD_PESSOA }, raw: true });
        const telefoneCliente = cliente && montarTelefoneCliente(cliente.DDD, cliente.TEL);
        if (!telefoneCliente) {
            logger.info(`[Cliente] Telefone não encontrado/inválido para COD_PESSOA ${documentoInfo.COD_PESSOA} (NF ${pagamento.NF}) — não é possível notificar o cliente.`);
            return;
        }

        const valorFormatado = Number(pagamento.VALOR || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const mensagemConfirmacao =
            `🎉 Olá! Recebemos aqui na *Cini Bebidas* o seu pagamento via PIX no valor de *R$ ${valorFormatado}*!\n\n` +
            `✅ Pagamento confirmado, muito obrigado! 😊`;
        const mensagemPadrao =
            `👋 Olá! Você entrou em contato com o número que fornece mensagens operacionais da CINI BEBIDAS.\n` +
            `Não monitoramos mensagens recebidas neste canal.\n` +
            `Para mais informações, entre em contato com o número: ${NUMERO_CONTATO_CINI}`;

        const metadadosBase = { nf: pagamento.NF, txid: pagamento.TXID, origem: 'NotificadorPIX-cliente' };
        await FilaNotificacoes.create({
            TIPO_MENSAGEM: 'texto',
            DESTINATARIO: telefoneCliente,
            MENSAGEM: mensagemConfirmacao,
            STATUS: 'PENDENTE',
            TENTATIVAS: 0,
            METADADOS: JSON.stringify({ ...metadadosBase, tipo: 'confirmacao_pagamento_cliente' }),
        });
        // Delay proposital antes de enfileirar o segundo aviso: se o primeiro envio
        // precisar de uma retentativa (raro, mas acontece), inserir os dois quase
        // juntos deixava esse segundo ser processado antes do primeiro, invertendo
        // a ordem que o cliente vê no WhatsApp.
        await sleep(8000);
        await FilaNotificacoes.create({
            TIPO_MENSAGEM: 'texto',
            DESTINATARIO: telefoneCliente,
            MENSAGEM: mensagemPadrao,
            STATUS: 'PENDENTE',
            TENTATIVAS: 0,
            METADADOS: JSON.stringify({ ...metadadosBase, tipo: 'aviso_padrao_cliente' }),
        });
        logger.info(`[Cliente] Confirmação de pagamento enfileirada para ${telefoneCliente} — NF ${pagamento.NF}, TXID: ${pagamento.TXID}`);
    } catch (err) {
        logger.error(`[Cliente] Erro ao enfileirar confirmação para o cliente (NF ${pagamento.NF}, TXID: ${pagamento.TXID}): ${err.message}`);
    }
}

async function _processarTxidInterno(txid) {
    const pagamento = await VPagamentosPix.findOne({
        where: { TXID: txid },
        raw: true,
    });
    if (!pagamento) {
        registrarFalha(txid, 'sem registro em V_PAGAMENTOS_PIX');
        return false;
    }

    const itemCarga = await FatoItensCargas.findOne({ where: { NF: pagamento.NF }, raw: true });
    if (!itemCarga) {
        registrarFalha(txid, `NF ${pagamento.NF} não encontrada em FATO_ITENS_CARGAS`);
        return false;
    }

    const carga = await FatoCargas.findOne({ where: { CARGA: itemCarga.CARGA }, raw: true });
    if (!carga) {
        registrarFalha(txid, `CARGA ${itemCarga.CARGA} não encontrada em FATO_CARGAS`);
        return false;
    }

    const motorista = await DimMotoristas.findOne({ where: { COD_MOTORISTA: carga.CODMOTORI }, raw: true });
    if (!motorista) {
        registrarFalha(txid, `CODMOTORI "${carga.CODMOTORI}" não encontrado em DIM_MOTORISTAS`);
        return false;
    }

    const tipoMsg = METODO_ENVIO_CONFIRMACAO_PIX === 'template'
        ? 'confirmacao_pix_template'
        : 'confirmacao_pix_bot';

    const hrPagto = (() => {
        const s = String(pagamento.HR_PAGTO || '').trim();
        return (s.length === 4 && !s.includes(':')) ? `${s.slice(0, 2)}:${s.slice(2)}` : s;
    })();

    const mensagem =
        `CONFIRMAÇÃO DE PAGAMENTO - PIX\n` +
        `Cliente: ${pagamento.CLIENTE}\n` +
        `Número da Nota: ${pagamento.NF}\n` +
        `Data Emissão: ${pagamento.DT_EMISSAO}\n` +
        `Valor: *${pagamento.VALOR}*\n` +
        `Data Pagto: ${pagamento.DT_PAGTO}\n` +
        `Hora Pagto: ${hrPagto}\n` +
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
            hr_pagto: hrPagto,
            txid,
        }),
        STATUS: 'PENDENTE',
        TENTATIVAS: 0,
        METADADOS: JSON.stringify({ nf: pagamento.NF, txid, origem: 'NotificadorPIX' }),
    });

    txidsPendentesPolling.delete(txid);
    logger.info(`Notificação enfileirada para ${motorista.WHATSAPP} — TXID: ${txid}`);

    // Sem await: enfileirarConfirmacaoParaCliente tem um delay proposital antes do
    // segundo aviso (ver comentário lá dentro) — não faz sentido segurar o
    // processamento do TXID (Z16_STENVW, próximo item do polling) por causa disso.
    // Erros já são tratados dentro da própria função.
    enfileirarConfirmacaoParaCliente(pagamento, hrPagto);

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

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', service: 'notificador-pix' });
});

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
                    Z16_TPLIQ: 2,
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

const CERT_DIR = process.env.CERT_DIR || 'C:\\Projetos\\Certificados';
const sslOptions = {
    key: fs.readFileSync(path.join(CERT_DIR, 'cini.key')),
    cert: fs.readFileSync(path.join(CERT_DIR, 'cini.crt')),
};

https.createServer(sslOptions, app).listen(PORT, () => {
    logger.info(`NotificadorPIX API ouvindo na porta ${PORT} (https)`);
    pollingLoop();
});
