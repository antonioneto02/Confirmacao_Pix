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
    const dddLimpo = String(ddd || '').replace(/\D/g, '');
    const telLimpo = String(tel || '').replace(/\D/g, '');
    if (!telLimpo) return null;

    // Em alguns cadastros o TEL já vem com o DDD embutido (ex.: DDD=41,
    // TEL=41987042945) — concatenar o DDD de novo nesse caso gerava um número
    // com dígitos a mais (inválido), e o bot ficava tentando várias formas de
    // resolver esse número quebrado, chegando a mandar a mensagem mais de uma vez.
    const telJaTemDDD = dddLimpo && telLimpo.startsWith(dddLimpo) && [10, 11].includes(telLimpo.length);
    const numeroLocal = telJaTemDDD ? telLimpo : (dddLimpo + telLimpo);

    if (numeroLocal.length < 10) return null;
    return numeroLocal.startsWith('55') ? numeroLocal : `55${numeroLocal}`;
}

// Gera as variantes "com o 9" e "sem o 9" de um número (DDI+DDD+número) pra
// comparar dois telefones sem se importar com essa diferença de formatação —
// uma comparação de string exata deixaria passar duplicidade real (mesmo
// número, um com o 9 e outro sem, chegando como "diferentes").
function candidatosTelefone(tel) {
    let limpo = String(tel || '').replace(/\D/g, '');
    if (!limpo) return [];
    if (!limpo.startsWith('55')) limpo = '55' + limpo;
    const candidatos = new Set([limpo]);
    if (limpo.length === 13) {
        candidatos.add(limpo.slice(0, 4) + limpo.slice(5));
    } else if (limpo.length === 12) {
        candidatos.add(limpo.slice(0, 4) + '9' + limpo.slice(4));
    }
    return [...candidatos];
}

function mesmoTelefone(a, b) {
    if (!a || !b) return false;
    const candidatosA = candidatosTelefone(a);
    const candidatosB = candidatosTelefone(b);
    return candidatosA.some(c => candidatosB.includes(c));
}

// Junta uma lista de telefones removendo duplicados "de verdade" (considerando
// a variação do 9), mantendo a primeira grafia encontrada de cada um.
function juntarTelefonesSemDuplicar(...telefones) {
    const unicos = [];
    for (const tel of telefones) {
        if (!tel) continue;
        if (unicos.some(existente => mesmoTelefone(existente, tel))) continue;
        unicos.push(tel);
    }
    return unicos;
}

async function buscarTelefonePixManual(nf) {
    try {
        // No fluxo manual (motorista pede um QR/copia-e-cola pelo bot pra mandar pro
        // cliente — ver WhatsAppWebNode/enviarMensagensPixPara), o número usado nem
        // sempre é o mesmo cadastrado em DIM_CLIENTES (pode ser outro contato da
        // pessoa que realmente vai pagar). Isso fica registrado na própria fila com
        // METADADOS.tipo='pix_automatico' — usamos o registro mais recente pra essa NF.
        const registro = await FilaNotificacoes.findOne({
            where: {
                TIPO_MENSAGEM: 'texto',
                METADADOS: { [Op.like]: `%"tipo":"pix_automatico"%"nf":"${nf}"%` },
            },
            order: [['DTINC', 'DESC']],
            raw: true,
        });
        return registro ? registro.DESTINATARIO : null;
    } catch (err) {
        logger.error(`[Cliente] Erro ao buscar telefone do fluxo manual de PIX (NF ${nf}): ${err.message}`);
        return null;
    }
}

async function enviarParConfirmacaoCliente(telefone, mensagemConfirmacao, mensagemPadrao, metadadosBase) {
    const tarefaConfirmacao = await FilaNotificacoes.create({
        TIPO_MENSAGEM: 'texto',
        DESTINATARIO: telefone,
        MENSAGEM: mensagemConfirmacao,
        STATUS: 'PENDENTE',
        TENTATIVAS: 0,
        METADADOS: JSON.stringify({ ...metadadosBase, tipo: 'confirmacao_pagamento_cliente' }),
    });

    // Espera a confirmação de pagamento REALMENTE sair antes de enfileirar o
    // aviso padrão — um delay fixo não bastava: quando o primeiro envio
    // precisava de retentativa (acontece, o bot às vezes demora/falha), o
    // aviso padrão (que costuma dar certo de primeira) furava a fila e chegava
    // antes. Aqui checamos o status de verdade, com um teto de segurança pra
    // não travar o processamento do TXID indefinidamente se algo travar.
    const ESPERA_MAX_MS = 3 * 60 * 1000;
    const INTERVALO_CHECAGEM_MS = 3000;
    const inicioEspera = Date.now();
    let statusFinal = null;
    while (Date.now() - inicioEspera < ESPERA_MAX_MS) {
        await sleep(INTERVALO_CHECAGEM_MS);
        const atual = await FilaNotificacoes.findOne({ where: { ID: tarefaConfirmacao.ID }, raw: true });
        if (!atual) break;
        if (['ENVIADA', 'FALHA', 'FALHA_DEFINITIVA'].includes(atual.STATUS)) {
            statusFinal = atual.STATUS;
            break;
        }
    }
    if (statusFinal !== 'ENVIADA') {
        logger.warn(`[Cliente] Confirmação de pagamento (ID ${tarefaConfirmacao.ID}, ${telefone}) não confirmou ENVIADA a tempo (status: ${statusFinal || 'ainda processando'}) — enfileirando aviso padrão mesmo assim.`);
    }

    await FilaNotificacoes.create({
        TIPO_MENSAGEM: 'texto',
        DESTINATARIO: telefone,
        MENSAGEM: mensagemPadrao,
        STATUS: 'PENDENTE',
        TENTATIVAS: 0,
        METADADOS: JSON.stringify({ ...metadadosBase, tipo: 'aviso_padrao_cliente' }),
    });
}

async function enfileirarConfirmacaoParaCliente(pagamento, hrPagto) {
    try {
        const documentoInfo = await FatoDocumentosSaidaCapa.findOne({ where: { NF: pagamento.NF }, raw: true });
        const cliente = documentoInfo && documentoInfo.COD_PESSOA
            ? await DimClientes.findOne({ where: { COD_CLIENTE: documentoInfo.COD_PESSOA }, raw: true })
            : null;
        const telefoneDB = cliente && montarTelefoneCliente(cliente.DDD, cliente.TEL);
        const telefoneManual = await buscarTelefonePixManual(pagamento.NF);

        // Junta os dois números possíveis sem duplicar quando forem o mesmo
        // (considerando a variação do 9, não só string igual).
        const candidatos = juntarTelefonesSemDuplicar(telefoneDB, telefoneManual);
        // Rede de segurança contra outras inconsistências de cadastro (DDI+DDD+número
        // válido tem 12 ou 13 dígitos) — número fora disso é rejeitado em vez de
        // mandado, pra não repetir o problema do DDD embutido em dobro no TEL.
        const telefones = candidatos.filter(tel => {
            const valido = [12, 13].includes(tel.length);
            if (!valido) {
                logger.warn(`[Cliente] Telefone "${tel}" com formato inválido (NF ${pagamento.NF}) — não enviando pra evitar duplicidade/erro.`);
            }
            return valido;
        });
        if (telefones.length === 0) {
            logger.info(`[Cliente] Nenhum telefone encontrado (nem cadastro, nem fluxo manual) pra NF ${pagamento.NF} — não é possível notificar o cliente.`);
            return;
        }

        const nomeCliente = (cliente && (cliente.FANTASIA || cliente.NOME)) || pagamento.CLIENTE || 'Cliente';
        const valorFormatado = Number(pagamento.VALOR || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const mensagemConfirmacao =
            `🎉 Olá! Recebemos aqui na *Cini Bebidas* o pagamento de *${nomeCliente}*!\n\n` +
            `📄 Número da Nota: ${pagamento.NF}\n` +
            `📅 Data Emissão: ${pagamento.DT_EMISSAO}\n` +
            `💰 Valor: R$ ${valorFormatado}\n` +
            `✅ Data/Hora Pagto: ${pagamento.DT_PAGTO} às ${hrPagto}\n` +
            `🔖 ID da confirmação de pagamento: ${pagamento.TXID}\n\n` +
            `Muito obrigado! 😊`;
        const mensagemPadrao =
            `👋 Olá! Você entrou em contato com o número que fornece mensagens operacionais da CINI BEBIDAS.\n` +
            `Não monitoramos mensagens recebidas neste canal.\n` +
            `Para mais informações, entre em contato com o número: ${NUMERO_CONTATO_CINI}`;
        const metadadosBase = { nf: pagamento.NF, txid: pagamento.TXID, origem: 'NotificadorPIX-cliente' };

        await Promise.all(telefones.map(telefone =>
            enviarParConfirmacaoCliente(telefone, mensagemConfirmacao, mensagemPadrao, metadadosBase)
        ));
        logger.info(`[Cliente] Confirmação de pagamento enfileirada para ${telefones.join(', ')} — NF ${pagamento.NF}, TXID: ${pagamento.TXID}`);
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
