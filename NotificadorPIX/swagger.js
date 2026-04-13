const swaggerUi = require('swagger-ui-express');

const swaggerDocument = {
  openapi: '3.0.0',
  info: {
    title: 'NotificadorPIX',
    version: '1.0.0',
    description: 'Serviço que monitora pagamentos PIX confirmados e envia notificações WhatsApp aos motoristas via fila. Opera principalmente por polling automático da tabela Z16010 a cada 30 segundos.',
  },
  servers: [{ url: 'http://localhost:3003', description: 'Servidor local' }],
  tags: [
    { name: 'Notificação', description: 'Disparo manual de notificações PIX' },
  ],
  paths: {
    '/notificar': {
      post: {
        tags: ['Notificação'],
        summary: 'Aciona notificação para um TXID específico',
        description: `Busca o pagamento PIX pelo TXID, localiza o motorista responsável pela carga e enfileira mensagem de confirmação na FATO_FILA_NOTIFICACOES.

**Fluxo interno:**
1. Busca TXID em V_PAGAMENTOS_PIX
2. Localiza NF → FATO_ITENS_CARGAS → FATO_CARGAS → DIM_MOTORISTAS
3. Insere mensagem na fila com TIPO_MENSAGEM = confirmacao_pix_bot ou confirmacao_pix_template
4. Atualiza Z16_STENVW = '1' na Z16010

**Observação:** Se o TXID começar com "RE", é ignorado (estorno).`,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['txid'],
                properties: {
                  txid: { type: 'string', description: 'TXID do pagamento PIX', example: 'cini20240110123456789' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Notificação processada ou enfileirada para polling',
            content: {
              'application/json': {
                examples: {
                  ok:              { value: { status: 'ok', txid: 'cini20240110123456789' } },
                  aguardando:      { value: { status: 'aguardando_polling', txid: 'cini20240110123456789' } },
                  ignorado:        { value: { status: 'ignorado', txid: 'RE20240110123456' } },
                },
              },
            },
          },
          400: { description: 'txid não informado' },
          500: { description: 'Erro interno ao processar o TXID' },
        },
      },
    },
  },
};

module.exports = { swaggerUi, swaggerDocument };
