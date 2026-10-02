# ☀️ Bot PH Zeus — Bot de WhatsApp com IA

Bot de atendimento do estúdio **Bot PH Zeus** (Osasco/SP). Usa o [Baileys](https://github.com/WhiskeySockets/Baileys) para se conectar ao WhatsApp e a API do **Google Gemini** (`@google/genai`) para responder clientes automaticamente: preços dos protocolos Bronze, Prata e Ouro, endereço, contatos e dúvidas sobre o bronzeamento. Feito para rodar 24/7 na nuvem (ex: [Render](https://render.com)), com persistência de sessão no **MongoDB** para sobreviver a reinícios.

## 🌞 Sobre o atendimento do Bot PH Zeus

Todo o conhecimento do estúdio fica em [`src/business/botPhZeus.js`](src/business/botPhZeus.js), extraído do folheto de preços:

| Protocolo | Inclui | 20 min (equiv. a 40) | 30 min (equiv. a 60) |
|---|---|---:|---:|
| **Bronze** | ativador de marquinha e fitagem | R$ 60,00 | R$ 80,00 |
| **Prata** | ativador de marquinha, parafina e fitagem | R$ 80,00 | R$ 100,00 |
| **Ouro** | ativador de marquinha, parafina, banho de lua e fitagem | R$ 100,00 | R$ 120,00 |

- A IA recebe esses dados em **toda** resposta (inclusive com `/persona`, que só muda o tom) e foi instruída a **não inventar** descontos, pacotes, formas de pagamento, horários ou vagas, a não dar conselho médico e a agendar só pelas ferramentas da agenda (veja a seção abaixo).
- `/precos` e `/endereco` respondem com os dados exatos, **sem gastar chamada do Gemini**.
- **Números:** o bot atende em `(11) 99136-1386` (`botWhatsapp`; `NUMEROS_BOT=5511991361386`). Quem prefere falar com uma pessoa, ou quando a agenda ainda não foi liberada, é encaminhado ao WhatsApp da dona do estúdio, `(11) 94578-8032` (`bookingWhatsapp`), com link direto (`wa.me`). O bot nunca manda o cliente chamar o próprio número.
- **Dona como administradora:** com `NUMERO_DONO=5511945788032`, a dona usa os comandos `/admin` do próprio WhatsApp (sem limite de mensagens ou horário). O número do dono não pode ser o do bot, e aqui são diferentes.
- Para **mudar preços, endereço ou contatos**, edite só o arquivo acima: o prompt da IA e os comandos usam os mesmos dados.
- O folheto **não informa o horário de funcionamento**, então o bot diz que não tem essa informação. Preencha `openingHours` no arquivo acima, ou use `/admin instrucoes` (ex.: `/admin instrucoes Funcionamos de segunda a sábado, das 9h às 19h`) para ensinar novidades à IA sem mexer no código, como promoções do mês.
- Dica: `/admin boasvindas Olá! ☀️ Aqui é o Bot PH Zeus. Quer ver os preços? Envie /precos` define uma mensagem para o primeiro contato.

## 📅 Agenda: o bot agenda e a dona recebe tudo no WhatsApp

O bot marca, cancela e remarca horários **sozinho**, conversando com o cliente. O WhatsApp não tem uma agenda própria que um bot possa preencher, então a agenda do estúdio aparece onde a dona realmente olha:

| Onde | O que a dona recebe |
|---|---|
| **WhatsApp dela** | A cada agendamento, remarcação ou cancelamento, uma mensagem com cliente (e link da conversa), protocolo, valor e horário. |
| **Agenda do celular** | A mensagem de agendamento vem com um arquivo de calendário (`.ics`): **um toque** e o horário entra na agenda do celular, com alarme 30 min antes. |
| **Resumo diário** | Todo dia, às 8h (`AGENDA_RESUMO_HORA`), a lista do dia, se houver agendamentos. |
| **Google Agenda** (opcional) | O evento é criado, remarcado e apagado automaticamente na agenda Google dela. |

### Como a dona começa (1 minuto)

1. Do WhatsApp dela (`NUMERO_DONO`), mandar ao bot: `/admin agenda horario seg-sex 09:00-19:00; sab 09:00-14:00` (os dias e horas em que atende).
2. Pronto: a IA já agenda clientes nesses horários. Antes disso, ela encaminha o cliente para o WhatsApp da dona.
3. Para folgas e feriados: `/admin fechar 25/12 natal`. Para reabrir: `/admin abrir 25/12`.

### Como o cliente agenda

Basta conversar: *"quero um bronze sábado de manhã"*. A IA consulta os horários **de verdade** (nunca inventa), combina protocolo, duração, dia, horário e nome, pede a confirmação e só então agenda. O cliente recebe código, valor e endereço, e **lembretes 24 h e 2 h antes** do horário. Também pode remarcar ou cancelar por ali.

### Regras que protegem a agenda

- **Só há uma máquina**: cada horário atende um cliente. A reserva é atômica, então duas pessoas disputando o mesmo horário nunca ficam as duas com ele (no MongoDB isso é garantido por um índice único).
- Horários de `AGENDA_INTERVALO_MIN` em `AGENDA_INTERVALO_MIN` minutos (30 por padrão), com antecedência mínima, limite de dias à frente e de agendamentos ativos por cliente (veja as variáveis).
- O preço sai da tabela do estúdio, não do que a IA "acha". Cada cliente só enxerga e altera os próprios agendamentos. Em grupos, a agenda fica desligada.
- Remarcar reserva o novo horário **antes** de liberar o antigo: se falhar, o cliente não perde o que tinha.
- Falha no aviso à dona ou no Google Agenda nunca desfaz um agendamento.

> ⚠️ **Use o MongoDB (`MONGODB_URI`)**. Sem ele, os agendamentos e lembretes ficam só na memória e **somem quando o serviço reinicia** (o que acontece com frequência no plano gratuito do Render).

### Ligando o Google Agenda (opcional)

1. No [Google Cloud Console](https://console.cloud.google.com/), crie um projeto, ative a **Google Calendar API** e crie uma **conta de serviço**. Gere uma chave **JSON** para ela.
2. No Google Agenda da dona, abra as configurações da agenda que vai receber os horários > **Compartilhar com pessoas** e adicione o e-mail da conta de serviço (`...@...iam.gserviceaccount.com`) com a permissão **Fazer alterações em eventos**.
3. Configure `GOOGLE_CALENDAR_ID` (o e-mail da agenda, ou o ID em *Integrar agenda*) e `GOOGLE_SERVICE_ACCOUNT_JSON` (o conteúdo do JSON; se preferir, em base64: `base64 -w0 chave.json`).
4. Reinicie. O log mostra "Google Agenda ligado". No celular, a dona vê os eventos no app Google Agenda, com notificação 1 h e 15 min antes.

## ✨ Funcionalidades

- **Agenda**: a IA consulta horários livres, agenda, remarca e cancela; a dona é avisada no WhatsApp (com arquivo para a agenda do celular), recebe o resumo do dia e pode ligar o Google Agenda.
- Conexão com o WhatsApp via **código de pareamento** (sem precisar escanear QR Code esticado no terminal).
- Histórico de conversa, comandos, personas e idiomas configuráveis por usuário.
- Suporte multimodal a imagens, áudios, PDFs e documentos de texto (`.txt`, `.md`, `.csv`, `.json`...), com legenda ou sem.
- Leitura de links: envie uma URL (com ou sem pergunta) e o bot responde com base no conteúdo da página ou do PDF. Endereços da rede interna são bloqueados.
- Allowlist opcional, limite de cinco mensagens por usuário por minuto e ferramentas do Gemini.
- Lembretes com datas, horários relativos e repetição (`todo dia`, `toda segunda`), no fuso configurado.
- Comandos de dono (`/admin`): instruções, boas-vindas e horário de atendimento por número, bloqueios e avisos.
- Respostas em grupos quando o bot é mencionado, formatação do WhatsApp e junção de mensagens enviadas em sequência.
- Dashboard autenticado em `/dashboard` e verificação de saúde em `/health`.
- Servidor HTTP (Express) usado para manter o serviço "vivo" em provedores como o Render.
- Persistência da sessão do WhatsApp em **MongoDB**, evitando reautenticação sempre que o container reinicia.
- Fallback para histórico em memória quando o MongoDB não está configurado ou fica indisponível; a sessão do WhatsApp usa arquivos locais (`auth_info_baileys`).

## 📋 Pré-requisitos

- [Node.js](https://nodejs.org/) 18 ou superior
- Uma conta no [Google AI Studio](https://aistudio.google.com/) para gerar uma **API Key do Gemini**
- Um número de WhatsApp para parear com o bot
- (Opcional, mas recomendado para produção) Uma conta no [MongoDB Atlas](https://www.mongodb.com/atlas) — plano gratuito é suficiente

## 🚀 Instalação e execução local

1. Clone o repositório:
   ```bash
   git clone https://github.com/GodFather-byte/whatsapp-gemini-bot.git
   cd whatsapp-gemini-bot
   ```

2. Instale as dependências:
   ```bash
   npm install
   ```

3. Copie `.env.example` para `.env` e configure as chaves e o número do WhatsApp:
   ```bash
   cp .env.example .env
   ```

4. Inicie o bot:
   ```bash
   npm start
   ```

6. No terminal, será exibido um **código de pareamento**, algo como:
   ```
   =========================================================
   🤖 SEU CÓDIGO DE PAREAMENTO É: ABC1-DEF2-GHI3
   =========================================================
   ```
   No seu celular, abra o WhatsApp e vá em:
   **Configurações (ou Aparelhos Conectados) → Conectar um aparelho → Vincular com número de telefone em vez disso**
   Digite o código exibido no terminal para concluir o pareamento.

7. Pronto! Envie uma mensagem privada (não em grupo) para o número conectado e o bot responderá usando o Gemini.

> ⚠️ Sem `MONGODB_URI` definida, a sessão é salva localmente na pasta `auth_info_baileys/`. **Não delete essa pasta** ou você precisará parear novamente.

## 🔑 Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|:---:|---|
| `GEMINI_API_KEY` | Para respostas IA | Chave obtida no [Google AI Studio](https://aistudio.google.com/). |
| `NUMEROS_BOT` | Para pareamento | Número(s) do bot com DDI e DDD, separados por vírgula. `NUMERO_BOT` (um número) continua aceito. |
| `NUMERO_DONO` | Recomendado | Seu número (com DDI e DDD) como dono do bot: libera os comandos `/admin` e não sofre limite, bloqueio nem horário. Aceita vários, separados por vírgula. |
| `FUSO_HORARIO` | ⛔ Opcional | Fuso dos lembretes e do horário de atendimento (padrão `America/Sao_Paulo`). |
| `JUNTAR_MENSAGENS_MS` | ⛔ Opcional | Espera, em ms, para juntar mensagens seguidas numa resposta só (padrão `2500`; `0` desliga). |
| `GRUPOS_ATIVADOS` | ⛔ Opcional | `false` faz o bot ignorar grupos (padrão `true`: responde quando mencionado). |
| `WHATSAPP_ALLOWED_NUMBERS` | ⛔ Opcional | Lista JSON ou separada por vírgulas. Sem configuração, qualquer número pode usar o bot. |
| `MONGODB_URI` | ⛔ Opcional | Persiste sessão e conversas; sem Mongo, conversas ficam em memória. |
| `MONGODB_DB_NAME` | ⛔ Opcional | Nome do banco no MongoDB (padrão `whatsapp-gemini-bot`). |
| `GEMINI_MODEL` | ⛔ Opcional | Modelo Gemini; padrão `gemini-3.5-flash-lite`. |
| `GEMINI_MAX_TOKENS` / `GEMINI_TIMEOUT` | ⛔ Opcional | Limite de saída e tempo limite das chamadas Gemini. |
| `GEMINI_LIMITE_DIARIO` | ⛔ Opcional | Limite de chamadas por dia do seu plano (veja em AI Studio > Rate limits); faz o `/admin uso` mostrar a porcentagem usada. |
| `PORT` / `LOG_LEVEL` | ⛔ Opcional | Porta HTTP (padrão `3000`) e nível dos logs. |
| `DASHBOARD_ENABLED` | ⛔ Opcional | Habilita `/dashboard`; requer `DASHBOARD_AUTH_TOKEN`. |
| `REMINDER_CHECK_INTERVAL` | ⛔ Opcional | Intervalo de verificação em milissegundos. |
| `AGENDA_INTERVALO_MIN` | ⛔ Opcional | Minutos entre os horários da agenda (padrão `30`, o mínimo, por causa da maior sessão). |
| `AGENDA_ANTECEDENCIA_MIN` | ⛔ Opcional | Antecedência mínima para agendar, em minutos (padrão `60`). |
| `AGENDA_DIAS_A_FRENTE` | ⛔ Opcional | Até quantos dias à frente se pode agendar (padrão `30`). |
| `AGENDA_MAX_POR_CLIENTE` | ⛔ Opcional | Máximo de agendamentos ativos por cliente (padrão `2`). |
| `AGENDA_RESUMO_HORA` | ⛔ Opcional | Hora (0-23) do resumo diário da agenda enviado à dona (padrão `8`; `desligado` não envia). |
| `GOOGLE_CALENDAR_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON` | ⛔ Opcional | Ligam o Google Agenda (as duas juntas); veja a seção da agenda. |
| `TOOL_WEATHER_API_KEY`, `TOOL_NEWS_API_KEY`, `TOOL_EXCHANGE_RATE_API_KEY` | ⛔ Opcional | Chaves de clima, notícias e conversão de moedas. |

## Comandos do WhatsApp

- `/precos` (ou `/valores`, `/protocolos`) e `/endereco` (ou `/contato`)
- `/horarios [data]` (ex.: `/horarios amanhã`, `/horarios 25/12`), `/agendamentos` (ou `/agenda`) e `/cancelar_agendamento <código>`
- `/reset`, `/ajuda` e `/status`
- `/resumo`, `/persona formal|engraçado|técnico` e `/idioma pt-BR|en|es`
- `/imagem <prompt>`
- `/lembrete <quando> <mensagem>`, `/lembretes` e `/cancelar_lembrete <id>`

Lembretes usam o fuso de `FUSO_HORARIO` e aceitam: `14:30`, `amanhã 09:00`, `25/12 10:00`, `25/12/2027 10:00`, `em 30 min`, `em 2 horas`, `todo dia 08:00` e `toda segunda 09:00`.

### Grupos

Em grupos, o bot só responde quando é **mencionado** (@bot) ou quando alguém **responde a uma mensagem dele**, citando a mensagem original.

### Comandos do dono (`/admin`)

Disponíveis para os números de `NUMERO_DONO` e também na conversa **"Você"** (consigo mesmo) do WhatsApp no celular de cada número do bot, mesmo sem `NUMERO_DONO`. O número do dono não pode ser um dos números do bot: o bot ignora mensagens enviadas pelo próprio número (para não responder a si mesmo) e mensagens entre os próprios números. As configurações valem para o número do bot com que você está conversando, então cada número pode ter as suas:

- `/admin status` — estatísticas e conexão de todos os números
- `/admin uso` — chamadas e tokens da API do Gemini usados hoje, nos últimos 7 dias e no mês, e quando a cota diária zera. O Google não oferece uma API para consultar a cota, então o bot conta sozinho a partir desta versão; os números oficiais ficam em [aistudio.google.com/usage](https://aistudio.google.com/usage)
- `/admin config` — configurações deste número
- `/admin instrucoes <texto>` — instruções extras para a IA (ex.: "Funcionamos de segunda a sábado, das 9h às 19h"); `limpar` remove
- `/admin boasvindas <texto>` — mensagem para o primeiro contato; `limpar` remove
- `/admin horario seg-sex 09:00-18:00; sab 09:00-13:00` — horário de atendimento; `desligar` remove
- `/admin foradehorario <texto>` — resposta fora do horário (enviada no máximo uma vez a cada 6h por contato)
- `/admin agenda [hoje|amanhã|DD/MM|semana]` — agendamentos do dia, com valor, código e link para falar com o cliente
- `/admin agenda horario seg-sex 09:00-19:00; sab 09:00-14:00` — dias e horas em que a IA pode agendar (`desligar` desliga a agenda). Não confundir com `/admin horario`, que é o horário em que o bot **responde**
- `/admin agenda config` — mostra a configuração da agenda e os dias fechados
- `/admin cancelar <código> [motivo]` — cancela um agendamento e **avisa o cliente**
- `/admin fechar <data> [motivo]` e `/admin abrir <data>` — fecha ou reabre um dia (feriado, folga); agendamentos já marcados não são cancelados sozinhos, a dona é avisada
- `/admin bloquear <número>`, `/admin desbloquear <número>`, `/admin bloqueados` — vale para todos os números do bot
- `/admin aviso <texto>` — envia um recado para todos os contatos deste número, um a cada 2 segundos

> ⚠️ Use `/admin aviso` com moderação: envios em massa são o principal motivo de banimento de números pelo WhatsApp.

## 🍃 Configurando o MongoDB (persistência de sessão)

Sem MongoDB, toda vez que o serviço reiniciar (o que acontece com frequência em planos gratuitos como o do Render), a sessão do WhatsApp é perdida e é preciso gerar um novo código de pareamento. Para evitar isso, siga o passo a passo:

### 1. Criar uma conta e um cluster no MongoDB Atlas

1. Acesse [https://www.mongodb.com/atlas](https://www.mongodb.com/atlas) e crie uma conta gratuita (ou faça login).
2. Crie um novo **Project** (ou use o padrão).
3. Clique em **Build a Database** e escolha o plano **M0 (Free)**.
4. Escolha um provedor de nuvem e região (qualquer uma, de preferência próxima de onde o bot vai rodar) e clique em **Create**.

### 2. Criar um usuário de banco de dados

1. No menu lateral, vá em **Database Access**.
2. Clique em **Add New Database User**.
3. Defina um **usuário** e uma **senha** (guarde-os, você vai precisar deles na connection string).
4. Em **Database User Privileges**, selecione `Read and write to any database`.
5. Clique em **Add User**.

### 3. Liberar o acesso de rede

1. No menu lateral, vá em **Network Access**.
2. Clique em **Add IP Address**.
3. Para simplificar (especialmente se o bot roda em um provedor com IP dinâmico, como o Render), clique em **Allow Access from Anywhere** (`0.0.0.0/0`).
   > Isso libera o acesso de qualquer IP para o cluster, mas o acesso ainda exige usuário e senha válidos. Para maior segurança em produção, restrinja aos IPs do seu provedor de hospedagem, se souber quais são.
4. Confirme.

### 4. Obter a connection string

1. No menu lateral, vá em **Database** (ou **Clusters**).
2. Clique em **Connect** no seu cluster.
3. Escolha **Drivers**.
4. Copie a connection string exibida, parecida com:
   ```
   mongodb+srv://<usuario>:<senha>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
5. Substitua `<usuario>` e `<senha>` pelos dados do usuário criado no passo 2 (lembre-se de **codificar caracteres especiais da senha**, se houver, usando [URL encoding](https://www.urlencoder.org/)).

### 5. Configurar a variável de ambiente

Use essa connection string como valor da variável `MONGODB_URI`:

- **Localmente:** adicione no arquivo `.env`:
  ```
  MONGODB_URI=mongodb+srv://usuario:senha@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
  ```
- **No Render:** adicione em *Environment Variables* do serviço (veja seção de deploy abaixo).

Ao iniciar, o bot detecta automaticamente a variável `MONGODB_URI` e passa a salvar as credenciais do WhatsApp (`creds`) e as chaves de criptografia (`keys`) na coleção `auth_state` do banco `whatsapp-gemini-bot`, em vez de usar arquivos locais. Se a conexão falhar por qualquer motivo, o bot registra o erro no log e cai automaticamente para o armazenamento local (`auth_info_baileys`), garantindo que ele continue funcionando.

## ☁️ Deploy no Render (plano gratuito)

1. Crie uma conta em [render.com](https://render.com) e conecte sua conta do GitHub.
2. Clique em **New +** → **Web Service** e selecione este repositório.
3. Configure:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Runtime:** Node
4. Em **Environment Variables**, adicione:
   - `GEMINI_API_KEY` → sua chave do Gemini
   - `MONGODB_URI` → a connection string do MongoDB Atlas (veja seção acima)
   - `NUMEROS_BOT` → seu número com DDI e DDD
5. Clique em **Create Web Service** e aguarde o deploy.
6. Acesse a aba **Logs** do serviço no Render para visualizar o **código de pareamento** gerado e vincular seu WhatsApp, como descrito no passo 6 da seção [Instalação e execução local](#-instalação-e-execução-local).

### Vários números no mesmo bot

Um único serviço pode atender vários números de WhatsApp, todos usando o mesmo MongoDB. Liste-os em `NUMEROS_BOT`:

```env
NUMEROS_BOT=5511999999999,5521888888888
```

- Cada número gera o próprio **código de pareamento** nos logs (`Código de pareamento do WhatsApp 55...`).
- Cada número tem sessão, histórico, persona/idioma e lembretes **separados**: um contato que fala com os dois bots tem duas conversas independentes. No MongoDB, a sessão fica em `auth_state_<número>` e os dados levam o campo `botId`.
- Ao adicionar números a um bot que já existia, a sessão atual é movida automaticamente para o número dono dela e as conversas antigas passam para o **primeiro** número da lista, sem precisar parear de novo.
- Os números do próprio bot nunca respondem uns aos outros.
- `WHATSAPP_ALLOWED_NUMBERS` vale para todos os números do bot.

> ⚠️ Não rode o mesmo número em dois serviços ao mesmo tempo (por exemplo, no Render e no Codespace): as duas conexões se derrubam.

### Mantendo o bot vivo no Render (plano gratuito)

O plano gratuito do Render "congela" o serviço depois de 15 minutos sem receber requisições HTTP, o que derruba a conexão do WhatsApp. Para evitar isso, configure um monitor gratuito de uptime (ex: [UptimeRobot](https://uptimerobot.com/)) para acessar `https://seu-bot.onrender.com/health` a cada 5 minutos. Esse endereço responde `200` quando todos os números estão conectados e `503` quando algum caiu, então o UptimeRobot também te avisa por e-mail se o WhatsApp desconectar.

## 🗂️ Estrutura do projeto

```
.
├── index.js             # Compatibilidade: encaminha para src/index.js
├── src/
│   ├── config.js
│   ├── business/         # Preços, endereço e regras de atendimento do Bot PH Zeus
│   ├── services/         # WhatsApp, Gemini e persistência
│   ├── handlers/         # Mensagens, comandos, mídia, ferramentas e lembretes
│   ├── middleware/       # Allowlist e rate limit
│   ├── routes/           # Dashboard
│   └── utils/             # Logger
├── mongoAuthState.js     # Implementação de auth state do Baileys usando MongoDB
├── package.json
└── .env                  # Variáveis de ambiente (não versionar!)
```

## 🛠️ Tecnologias utilizadas

- [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) — biblioteca para conexão com o WhatsApp Web
- [@google/genai](https://www.npmjs.com/package/@google/genai) — SDK oficial do Google Gemini
- [mongodb](https://www.npmjs.com/package/mongodb) — driver oficial do MongoDB
- [express](https://expressjs.com/) — servidor HTTP mínimo para keep-alive
- [pino](https://github.com/pinojs/pino) — logger
- [dotenv](https://www.npmjs.com/package/dotenv) — carregamento de variáveis de ambiente

## ⚠️ Observações importantes

- Não use o número principal do seu WhatsApp pessoal, se possível — prefira um número dedicado ao bot.
- O bot **ignora mensagens enviadas em grupos** (`@g.us`), respondendo apenas em conversas privadas.
- Proteja `/dashboard` com um `DASHBOARD_AUTH_TOKEN` forte e restrinja `WHATSAPP_ALLOWED_NUMBERS` em produção.
- Nunca faça commit do seu arquivo `.env` ou de credenciais reais. Adicione-os ao `.gitignore` (já configurado neste projeto).
- Se o WhatsApp desconectar por logout (`DisconnectReason.loggedOut`), será necessário gerar um novo código de pareamento — isso é esperado e não é um bug.

## 📄 Licença

ISC
