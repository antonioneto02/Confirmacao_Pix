const fs = require('fs');
const path = require('path');
const { QueryTypes } = require('sequelize');
const sequelizeDW = require('./databaseDW');
const logger = require('./logger');
const FilaNotificacoes = require('./filaNotificacoes');
const PROTHEUS_DB = process.env.DB_NAME_P11PROD || 'p11_prod';
const INTERVALO_MS = 15 * 60 * 1000;          
const JANELA_BUSCA_ORFAOS_DIAS = 60;          
const JANELA_TITULO_EMISSAO_DIAS = 60;        
const ARQUIVO_ESTADO = path.join(__dirname, 'state', 'orfaos-alertados.json');
const RETENCAO_ESTADO_DIAS = 120;            

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatarYYYYMMDD(data) {
    const ano = data.getFullYear();
    const mes = String(data.getMonth() + 1).padStart(2, '0');
    const dia = String(data.getDate()).padStart(2, '0');
    return `${ano}${mes}${dia}`;
}

function parseDataZ16(yyyymmdd) {
    const s = String(yyyymmdd || '').trim();
    if (s.length !== 8) return null;
    return new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
}

function carregarAlertados() {
    try {
        const registros = JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, 'utf8'));
        const corte = Date.now() - RETENCAO_ESTADO_DIAS * 24 * 60 * 60 * 1000;
        const filtrados = {};
        for (const [recno, quando] of Object.entries(registros)) {
            if (quando >= corte) filtrados[recno] = quando;
        }
        return filtrados;
    } catch {
        return {};
    }
}

function salvarAlertados(registros) {
    try {
        fs.mkdirSync(path.dirname(ARQUIVO_ESTADO), { recursive: true });
        fs.writeFileSync(ARQUIVO_ESTADO, JSON.stringify(registros, null, 2));
    } catch (err) {
        logger.error(`[ReconciliadorOrfaos] Erro ao salvar estado de alertados: ${err.message}`);
    }
}

async function buscarOrfaos() {
    const dataCorte = formatarYYYYMMDD(new Date(Date.now() - JANELA_BUSCA_ORFAOS_DIAS * 24 * 60 * 60 * 1000));
    return sequelizeDW.query(
        `SELECT R_E_C_N_O_ AS RECNO, Z16_FILIAL AS FILIAL, Z16_DTBAIX AS DTBAIX,
                Z16_HRBAIX AS HRBAIX, Z16_VALOR AS VALOR, Z16_STATUS AS STATUS, Z16_BANCO AS BANCO
         FROM ${PROTHEUS_DB}.dbo.Z16010 WITH (NOLOCK)
         WHERE RTRIM(ISNULL(Z16_TXID,'')) = ''
           AND RTRIM(ISNULL(Z16_TPLIQ,'')) = '2'
           AND Z16_DTBAIX >= :dataCorte
         ORDER BY Z16_DTBAIX DESC, Z16_HRBAIX DESC`,
        { replacements: { dataCorte }, type: QueryTypes.SELECT }
    );
}

async function buscarCandidatos(orfao) {
    const dtBaixa = parseDataZ16(orfao.DTBAIX);
    if (!dtBaixa) return [];
    const dataMin = formatarYYYYMMDD(new Date(dtBaixa.getTime() - JANELA_TITULO_EMISSAO_DIAS * 24 * 60 * 60 * 1000));
    const dataMax = formatarYYYYMMDD(new Date(dtBaixa.getTime() + 24 * 60 * 60 * 1000)); 

    return sequelizeDW.query(
        `SELECT A.CODFIL, A.CODCLI, A.LOJACLI, A.PREFIXO, A.NUMERO, A.PARCELA, A.TIPO,
                A.DATA, A.VENCTO, A.VENCREA, A.VALOR, A.SALDO,
                C.NOME AS CLIENTE_NOME, C.FANTASIA AS CLIENTE_FANTASIA
         FROM dw.dbo.FATO_TITULOS_RECEBER A WITH (NOLOCK)
         LEFT JOIN dw.dbo.DIM_CLIENTES C WITH (NOLOCK)
                ON A.CODCLI = C.COD_CLIENTE AND A.LOJACLI = C.LOJA
         WHERE A.SALDO > 0
           AND A.TIPO NOT IN ('RA','NCC','NDC')
           AND RTRIM(A.CODFIL) = RTRIM(:filial)
           AND CAST(A.SALDO AS DECIMAL(18,2)) = CAST(:valor AS DECIMAL(18,2))
           AND CONVERT(VARCHAR(8), A.DATA, 112) BETWEEN :dataMin AND :dataMax`,
        {
            replacements: { filial: orfao.FILIAL, valor: orfao.VALOR, dataMin, dataMax },
            type: QueryTypes.SELECT,
        }
    );
}

function montarMensagemAlerta(orfao, titulo) {
    const nomeCliente = titulo.CLIENTE_FANTASIA || titulo.CLIENTE_NOME || `Cód. cliente ${titulo.CODCLI}`;
    const hrBaixa = String(orfao.HRBAIX || '').trim();
    return (
        `⚠️ PIX recebido sem TXID (possível baixa manual) — candidato encontrado\n\n` +
        `Baixa Z16010 (RECNO ${orfao.RECNO}):\n` +
        `  Filial: ${orfao.FILIAL}\n` +
        `  Data/Hora: ${orfao.DTBAIX} ${hrBaixa}\n` +
        `  Valor: R$ ${Number(orfao.VALOR).toFixed(2)}\n` +
        `  Banco: ${orfao.BANCO}\n\n` +
        `Único título em aberto batendo no valor dentro da janela de ${JANELA_TITULO_EMISSAO_DIAS} dias:\n` +
        `  Cliente: ${nomeCliente} (cód. ${titulo.CODCLI}/${titulo.LOJACLI})\n` +
        `  Nota: ${titulo.PREFIXO}-${titulo.NUMERO} Parc. ${titulo.PARCELA} (${titulo.TIPO})\n` +
        `  Emissão: ${titulo.DATA} | Vencimento: ${titulo.VENCREA || titulo.VENCTO}\n` +
        `  Saldo em aberto: R$ ${Number(titulo.SALDO).toFixed(2)}\n\n` +
        `Isso é uma SUGESTÃO automática (valor exato + candidato único) — confirme e faça o ` +
        `vínculo/baixa e o aviso ao motorista manualmente. Esta rotina não altera nada sozinha.`
    );
}

async function enfileirarAlerta(mensagem) {
    await FilaNotificacoes.create({
        TIPO_MENSAGEM: 'google_chat',
        DESTINATARIO: 'google_chat_webhook',
        MENSAGEM: mensagem,
        TEMPLATE_NAME: null,
        TEMPLATE_PARAMS: JSON.stringify({}),
        STATUS: 'PENDENTE',
        TENTATIVAS: 0,
        METADADOS: JSON.stringify({ origem: 'ReconciliadorOrfaosPix' }),
    });
}

async function processarCiclo() {
    const alertados = carregarAlertados();

    let orfaos;
    try {
        orfaos = await buscarOrfaos();
    } catch (err) {
        logger.error(`[ReconciliadorOrfaos] Erro ao buscar órfãos: ${err.message}`);
        return;
    }

    if (orfaos.length === 0) {
        logger.info('[ReconciliadorOrfaos] Nenhuma baixa PIX órfã (TXID vazio) na janela.');
        return;
    }

    let novosAlertas = 0;
    for (const orfao of orfaos) {
        if (alertados[orfao.RECNO]) continue;

        let candidatos;
        try {
            candidatos = await buscarCandidatos(orfao);
        } catch (err) {
            logger.error(`[ReconciliadorOrfaos] Erro ao buscar candidatos pro RECNO ${orfao.RECNO}: ${err.message}`);
            continue;
        }

        if (candidatos.length === 1) {
            try {
                await enfileirarAlerta(montarMensagemAlerta(orfao, candidatos[0]));
                alertados[orfao.RECNO] = Date.now();
                novosAlertas++;
                logger.info(
                    `[ReconciliadorOrfaos] Alerta enfileirado — RECNO ${orfao.RECNO} (R$ ${orfao.VALOR}) ` +
                    `-> Nota ${candidatos[0].PREFIXO}-${candidatos[0].NUMERO} Parc. ${candidatos[0].PARCELA}.`
                );
            } catch (err) {
                logger.error(`[ReconciliadorOrfaos] Erro ao enfileirar alerta pro RECNO ${orfao.RECNO}: ${err.message}`);
            }
        } else if (candidatos.length > 1) {
            logger.info(
                `[ReconciliadorOrfaos] RECNO ${orfao.RECNO} (R$ ${orfao.VALOR}) — ${candidatos.length} ` +
                `títulos em aberto batendo no valor: ambíguo, não alertado.`
            );
        }
    }

    if (novosAlertas > 0) {
        salvarAlertados(alertados);
    }
    logger.info(`[ReconciliadorOrfaos] Ciclo concluído — ${orfaos.length} órfão(s) na janela, ${novosAlertas} novo(s) alerta(s).`);
}

async function bootstrapSeVirgem() {
    if (fs.existsSync(ARQUIVO_ESTADO)) return;

    let orfaos;
    try {
        orfaos = await buscarOrfaos();
    } catch (err) {
        logger.error(`[ReconciliadorOrfaos] Erro ao buscar backlog inicial: ${err.message}`);
        return; 
    }

    const agora = Date.now();
    const alertados = {};
    for (const orfao of orfaos) {
        alertados[orfao.RECNO] = agora;
    }
    salvarAlertados(alertados);
    logger.info(
        `[ReconciliadorOrfaos] Primeira execução — ${orfaos.length} órfão(s) já existentes marcado(s) ` +
        `como visto(s) sem alerta retroativo. A partir de agora só órfãos novos geram alerta.`
    );
}

async function iniciar() {
    logger.info(`[ReconciliadorOrfaos] Iniciado — verificação a cada ${INTERVALO_MS / 60000} min.`);
    await sleep(20_000); 
    await bootstrapSeVirgem();
    while (true) {
        try {
            await processarCiclo();
        } catch (err) {
            logger.error(`[ReconciliadorOrfaos] Erro inesperado no ciclo: ${err.message}`);
        }
        await sleep(INTERVALO_MS);
    }
}

module.exports = { iniciar };
