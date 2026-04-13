# 📲 Notificador PIX

> Monitora pagamentos PIX na tabela Z16010 e enfileira mensagens de confirmação via WhatsApp para motoristas.

## 📋 Sobre o Projeto

O **Notificador PIX** é um serviço de background que roda continuamente, fazendo **polling a cada 30 segundos** na tabela `Z16010` do Protheus em busca de novos pagamentos PIX. Quando um pagamento é detectado, o sistema rastreia a cadeia de dados até encontrar o motorista responsável pela carga e enfileira uma mensagem de confirmação de pagamento na fila de notificações (`FATO_FILA_NOTIFICACOES`).

Essa mensagem será processada pelo **central-notificacoes** e enviada ao motorista via **WhatsApp** pelo **whatsapp-bot**. Além disso, alertas são enviados ao **Google Chat** para a equipe acompanhar os pagamentos.

## 🛠️ Tecnologias

| Tecnologia | Descrição |
|---|---|
| **Node.js** | Runtime JavaScript |
| **Express** | Framework web (endpoint de notificação manual) |
| **Sequelize** | ORM para SQL Server |
| **Tedious** | Driver SQL Server para Sequelize |
| **winston** | Logs estruturados |
| **Swagger UI** | Documentação interativa |
| **PM2** | Gerenciador de processos (`notificador-pix`) |
| **Porta** | `3013` |

## 🔧 Como Funciona

O serviço segue um fluxo de **polling + cadeia de consultas**:

1. **Polling** — A cada 30 segundos, consulta a tabela `Z16010` procurando registros com `Z16_STENVW != '1'` (não enviados)
2. **Filtragem** — Ignora TXIDs já em processamento, já marcados como boleto ou que já falharam
3. **Consulta V_PAGAMENTOS_PIX** — Busca os dados do pagamento PIX pelo TXID. Se `FRMPAG = 'BOL'`, ignora (é boleto)
4. **Cadeia de rastreamento do motorista**:
   - `V_PAGAMENTOS_PIX` → Identifica a NF/pagamento
   - `FATO_ITENS_CARGAS` → Localiza o item de carga relacionado
   - `FATO_CARGAS` → Identifica a carga
   - `DIM_MOTORISTAS` → Encontra o motorista responsável
5. **Enfileiramento** — Cria um registro na `FATO_FILA_NOTIFICACOES` com tipo `bot` ou `template`, contendo o número do motorista e a mensagem de confirmação
6. **Alerta Google Chat** — Enfileira alertas no Google Chat para a equipe
7. **Atualização** — Marca o registro na `Z16010` como enviado (`Z16_STENVW = '1'`)

## 📡 Endpoints

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/notificar` | Dispara notificação manual para um TXID |
| `GET` | `/docs` | Documentação Swagger |

> **Nota:** O serviço principal é o **polling automático**, não depende de chamadas externas à API.

## 🗄️ Banco de Dados

O sistema usa **dois bancos SQL Server** via Sequelize/Tedious:

### Banco P11_Prod (Protheus)

| Tabela/View | Uso |
|---|---|
| `Z16010` | Tabela de baixas PIX — fonte do polling (monitora `Z16_TXID`, `Z16_STENVW`) |
| `V_PAGAMENTOS_PIX` | View que cruza dados de pagamento PIX (TXID, NF, FRMPAG) |

### Banco DW (Data Warehouse)

| Tabela/View | Uso |
|---|---|
| `FATO_ITENS_CARGAS` | Itens das cargas — vincula NF à carga |
| `FATO_CARGAS` | Cargas — vincula carga ao motorista |
| `DIM_MOTORISTAS` | Dimensão de motoristas — nome, telefone |
| `FATO_FILA_NOTIFICACOES` | Fila de mensagens — onde as notificações são enfileiradas |

## 🔗 Integrações

| Sistema | Tipo | Descrição |
|---|---|---|
| **central-notificacoes** | Consumidor da fila | Processa mensagens da `FATO_FILA_NOTIFICACOES` |
| **whatsapp-bot** | Envio de mensagens | Envia a confirmação PIX via WhatsApp para o motorista |
| **Google Chat** | Alertas | Recebe alertas da equipe sobre novos pagamentos via fila |
| **Protheus (P11_Prod)** | Banco de dados | Leitura da Z16010 e V_PAGAMENTOS_PIX |

## ⚙️ Variáveis de Ambiente

```env
PORT=3013                          # Porta do servidor Express

# Banco de Dados
DB_HOST=                           # Host do SQL Server
DB_USER=                           # Usuário do banco
DB_PASSWORD_NERIAS=                # Senha do banco
DB_NAME_P11PROD=                   # Nome do banco Protheus (p11_prod)

# Configurações
METODO_ENVIO_CONFIRMACAO_PIX=bot   # Método de envio: "bot" ou "template"
INTERVALO_MS=30000                 # Intervalo de polling em ms (padrão: 30s)
```

## 🚀 Como Rodar

```bash
# 1. Instalar dependências
npm install

# 2. Configurar variáveis de ambiente
# Copiar e preencher o arquivo .env

# 3. Rodar em desenvolvimento
npm run dev

# 4. Rodar em produção com PM2
pm2 start app.js --name notificador-pix

# 5. Acessar
# Documentação: http://localhost:3013/docs
# O serviço inicia o polling automaticamente ao subir
```
