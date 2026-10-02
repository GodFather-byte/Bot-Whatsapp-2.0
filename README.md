# 🕴️ Bot PH Zeus — o consigliere do seu WhatsApp

> *"Faça uma oferta que ele não possa recusar... ou pelo menos uma resposta educada enquanto o chefe não volta."*
>
> ⚠️ **Aviso:** a máfia aqui é de **brincadeira**. Ninguém é ameaçado, nenhuma cabeça de cavalo é entregue. O máximo que acontece é um contato receber uma resposta educada de um robô.

O **Bot PH Zeus** é o consigliere de confiança do chefe (você). Quando o **chefe não está online**, é ele quem atende a porta: se apresenta, anota o recado, resolve o que dá para resolver e depois **conta tudo ao chefe**. Por trás dos panos, usa o [Baileys](https://github.com/WhiskeySockets/Baileys) para se infiltrar no seu WhatsApp como "aparelho conectado" e o **Google Gemini** (`@google/genai`) como cérebro da operação. Trabalha 24/7 na nuvem (ex: [Render](https://render.com)), com a sessão guardada no **MongoDB** (o cofre da família) para sobreviver a reinícios.

## 🏛️ A hierarquia da família

| Cargo | Quem é |
|---|---|
| **Don (o chefe)** | Você. Dá as ordens pela conversa **"Você"** (consigo mesmo) com os comandos `/admin`. |
| **Consigliere** | O Bot PH Zeus. Fala em nome do chefe, mas **não decide nada sozinho**. |
| **Os contatos** | Quem bate à porta. São atendidos com educação, e quem for suspeito é ignorado em silêncio. |
| **A lista negra** | Quem foi `/admin bloquear`. Nem a porta abre. 🚪 |

## 🥃 Quando o chefe está "fora do escritório"

O WhatsApp não avisa a um bot quando você está online, então o consigliere vigia a sua atividade pelas mensagens que **você envia pelo celular**:

| Modo | Comportamento |
|---|---|
| `auto` (padrão) | Atende quando o chefe ficou **10 minutos** sem mandar mensagem (`AUSENTE_APOS_MIN`) ou dentro do *horário de ausência*. Se o chefe responder uma conversa, o consigliere **se cala nela por 1 hora** (`SILENCIAR_APOS_RESPOSTA_MIN`): chefe presente, consigliere de boca fechada. |
| `on` | "Hoje ninguém fala com o chefe." Responde sempre, a todos (viagem, reunião longa, noite). |
| `off` | "O consigliere tirou folga." Não responde ninguém. |

Troque o modo na conversa **"Você"**: `/admin ausente auto`, `/admin ausente on` ou `/admin ausente off`.

- **Horário de ausência** (o chefe só atende em certas horas): `/admin horarioausente seg-sex 09:00-18:00`. No modo `auto`, nesses horários o consigliere atende mesmo com o chefe online. `desligar` remove.
- **Ordens do chefe:** `/admin instrucoes Estou em viagem até sexta. Se for urgente, pode ligar.` O consigliere só repete o que está ali e na conversa: **nunca inventa** onde o chefe está, compromissos ou dados pessoais. Quem inventa história acaba dormindo com os peixes. 🐟
- **Apresentação:** na primeira mensagem de cada conversa (e depois de 6 h de silêncio) ele se apresenta como o Bot PH Zeus, assistente do chefe, e avisa que o chefe não está online.
- **Relatório ao chefe:** nesse momento você recebe na conversa "Você" um aviso com *quem* escreveu, o que disse e o que o consigliere respondeu (`AVISAR_DONO`). Nada acontece sem o chefe saber.
- **Código de silêncio (omertà):** ele **não toma decisões pelo chefe**: não aceita convites, não combina nada, e não entrega telefone, endereço, senhas nem códigos de verificação para ninguém, nem para quem jura que é primo do chefe.
- Entende imagens, áudios, PDFs e links, e consulta clima, notícias, câmbio, hora e contas quando as chaves estão configuradas.
- Quem está bloqueado (`/admin bloquear`) ou fora de `WHATSAPP_ALLOWED_NUMBERS` é ignorado em silêncio. Grupos ficam de fora por padrão (`GRUPOS_ATIVADOS=false`): reunião da família não é lugar de consigliere falando sozinho.

> ⚠️ O estado "chefe online" fica na memória: depois de um reinício, o consigliere assume que o chefe está ausente até ver uma mensagem sua. Use `/admin ausente off` se não quiser respostas durante deploys.

## ✨ O arsenal (funcionalidades)

- Conexão com o WhatsApp via **código de pareamento** (sem precisar escanear QR Code no terminal).
- Histórico de conversa por contato, com persona e idioma configuráveis nos seus comandos.
- Suporte multimodal a imagens, áudios, PDFs e documentos de texto (`.txt`, `.md`, `.csv`, `.json`...), com legenda ou sem.
- Leitura de links: o contato envia uma URL e o consigliere responde com base no conteúdo da página ou do PDF. Endereços da rede interna são bloqueados.
- Allowlist opcional, limite de cinco mensagens por contato por minuto (ninguém enche o saco do consigliere) e ferramentas do Gemini.
- Lembretes para o chefe (`/lembrete`), com datas, horários relativos e repetição, no fuso configurado.
- Comandos do dono (`/admin`), junção de mensagens enviadas em sequência e formatação do WhatsApp.
- Dashboard autenticado em `/dashboard` e verificação de saúde em `/health`.
- Persistência da sessão do WhatsApp em **MongoDB**, com fallback para arquivos locais (`auth_info_baileys`).

## 📋 O que a família precisa

- [Node.js](https://nodejs.org/) 18 ou superior
- Uma conta no [Google AI Studio](https://aistudio.google.com/) para gerar uma **API Key do Gemini**
- Um número de WhatsApp para parear com o bot
- (Opcional, mas recomendado para produção) Uma conta no [MongoDB Atlas](https://www.mongodb.com/atlas) — plano gratuito é suficiente

## 🚀 Contratando o consigliere (instalação local)

1. Clone o repositório:
   ```bash
   git clone https://github.com/GodFather-byte/Bot-Whatsapp-2.0.git
   cd Bot-Whatsapp-2.0
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

7. Pronto! Peça a alguém para mandar uma mensagem para o seu número, ou use `/admin ausente on` na conversa "Você" para testar: o assistente responde por você.

> ⚠️ Sem `MONGODB_URI` definida, a sessão é salva localmente na pasta `auth_info_baileys/`. **Não delete essa pasta** ou você precisará parear novamente.

## 🔑 Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|:---:|---|
| `GEMINI_API_KEY` | Para respostas IA | Chave obtida no [Google AI Studio](https://aistudio.google.com/). |
| `NUMEROS_BOT` | Para pareamento | **Seu** número do WhatsApp, com DDI e DDD (o assistente responde por ele). `NUMERO_BOT` continua aceito. |
| `NUMERO_DONO` | ⛔ Opcional | Outro número seu que também pode dar comandos `/admin` por mensagem. Não precisa: na conversa "Você" os comandos já funcionam. |
| `FUSO_HORARIO` | ⛔ Opcional | Fuso dos lembretes e do horário de ausência (padrão `America/Sao_Paulo`). |
| `JUNTAR_MENSAGENS_MS` | ⛔ Opcional | Espera, em ms, para juntar mensagens seguidas numa resposta só (padrão `2500`; `0` desliga). |
| `GRUPOS_ATIVADOS` | ⛔ Opcional | `true` deixa o assistente responder em grupos quando você é mencionado (padrão `false`). |
| `WHATSAPP_ALLOWED_NUMBERS` | ⛔ Opcional | Lista JSON ou separada por vírgulas. Sem configuração, o assistente responde qualquer contato. |
| `MONGODB_URI` | ⛔ Opcional | Persiste sessão e conversas; sem Mongo, conversas ficam em memória. |
| `MONGODB_DB_NAME` | ⛔ Opcional | Nome do banco no MongoDB (padrão `whatsapp-gemini-bot`). |
| `GEMINI_MODEL` | ⛔ Opcional | Modelo Gemini; padrão `gemini-3.5-flash-lite`. |
| `GEMINI_MAX_TOKENS` / `GEMINI_TIMEOUT` | ⛔ Opcional | Limite de saída e tempo limite das chamadas Gemini. |
| `GEMINI_LIMITE_DIARIO` | ⛔ Opcional | Limite de chamadas por dia do seu plano (veja em AI Studio > Rate limits); faz o `/admin uso` mostrar a porcentagem usada. |
| `PORT` / `LOG_LEVEL` | ⛔ Opcional | Porta HTTP (padrão `3000`) e nível dos logs. |
| `DASHBOARD_ENABLED` | ⛔ Opcional | Habilita `/dashboard`; requer `DASHBOARD_AUTH_TOKEN`. |
| `REMINDER_CHECK_INTERVAL` | ⛔ Opcional | Intervalo de verificação em milissegundos. |
| `NOME_DONO` | Recomendado | Seu nome, usado pelo assistente para falar de você ("assistente pessoal de Paulo"). |
| `AUSENTE_APOS_MIN` | ⛔ Opcional | Minutos sem enviar mensagens para você contar como ausente no modo `auto` (padrão `10`). |
| `SILENCIAR_APOS_RESPOSTA_MIN` | ⛔ Opcional | Minutos em que o assistente se cala numa conversa depois que você responde (padrão `60`). |
| `AVISAR_DONO` | ⛔ Opcional | `false` desliga o aviso na conversa "Você" quando o assistente atende uma conversa nova (padrão `true`). |
| `TOOL_WEATHER_API_KEY`, `TOOL_NEWS_API_KEY`, `TOOL_EXCHANGE_RATE_API_KEY` | ⛔ Opcional | Chaves de clima, notícias e conversão de moedas. |

## 📜 As ordens do chefe (comandos)

Escreva na conversa **"Você"** (consigo mesmo) do WhatsApp, ou de um número de `NUMERO_DONO`. Para os contatos, uma mensagem começando com `/` é texto comum: o consigliere conversa normalmente e não revela nada. Só o chefe dá ordens.

- `/lembrete <quando> <mensagem>`, `/lembretes` e `/cancelar_lembrete <id>` — lembretes que chegam para você. Aceitam `14:30`, `amanhã 09:00`, `25/12 10:00`, `25/12/2027 10:00`, `em 30 min`, `em 2 horas`, `todo dia 08:00` e `toda segunda 09:00`, no fuso de `FUSO_HORARIO`
- `/resumo`, `/reset`, `/ajuda`, `/status`, `/persona formal|engraçado|técnico`, `/idioma pt-BR|en|es` e `/imagem <prompt>`

### Ordens de administração (`/admin`)

- `/admin ausente [auto|on|off]` — veja a seção acima
- `/admin horarioausente seg-sex 09:00-18:00; sab 09:00-13:00` — horários em que o assistente responde mesmo com você online; `desligar` remove
- `/admin instrucoes <texto>` — o que o assistente pode saber e dizer por você; `limpar` remove
- `/admin status` — estatísticas e conexão
- `/admin uso` — chamadas e tokens da API do Gemini usados hoje, nos últimos 7 dias e no mês, e quando a cota diária zera. O Google não oferece uma API para consultar a cota, então o bot conta sozinho; os números oficiais ficam em [aistudio.google.com/usage](https://aistudio.google.com/usage)
- `/admin config` — configurações atuais
- `/admin bloquear <número>`, `/admin desbloquear <número>`, `/admin bloqueados` — números que o assistente ignora
- `/admin aviso <texto>` — envia um recado para todos os contatos que já conversaram com o assistente, um a cada 2 segundos

> ⚠️ Use `/admin aviso` com moderação: envios em massa são o principal motivo de banimento de números pelo WhatsApp.

## 🍃 O cofre da família (MongoDB)

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

## ☁️ Montando o esconderijo na nuvem (Render, plano gratuito)

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
   - `NOME_DONO` → seu nome
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

## 🗂️ O mapa do território (estrutura do projeto)

```
.
├── index.js             # Compatibilidade: encaminha para src/index.js
├── src/
│   ├── config.js
│   ├── assistant/        # Personalidade e regras do Bot PH Zeus
│   ├── services/         # WhatsApp, Gemini, presença (dono ausente) e persistência
│   ├── handlers/         # Mensagens, comandos, mídia, ferramentas e lembretes
│   ├── middleware/       # Allowlist e rate limit
│   ├── routes/           # Dashboard
│   └── utils/             # Logger
├── mongoAuthState.js     # Implementação de auth state do Baileys usando MongoDB
├── package.json
└── .env                  # Variáveis de ambiente (não versionar!)
```

## 🛠️ Os homens de confiança (tecnologias)

- [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) — biblioteca para conexão com o WhatsApp Web
- [@google/genai](https://www.npmjs.com/package/@google/genai) — SDK oficial do Google Gemini
- [mongodb](https://www.npmjs.com/package/mongodb) — driver oficial do MongoDB
- [express](https://expressjs.com/) — servidor HTTP mínimo para keep-alive
- [pino](https://github.com/pinojs/pino) — logger
- [dotenv](https://www.npmjs.com/package/dotenv) — carregamento de variáveis de ambiente

## ⚠️ Conselhos do chefe (observações importantes)

- O consigliere fala **em seu nome**: avise quem costuma te escrever, e mantenha `/admin instrucoes` atualizado. Ele sempre se identifica como assistente virtual. Aqui a máfia é só tema: ninguém recebe ameaça, só uma resposta educada.
- Usar o WhatsApp com bots não oficiais pode violar os termos do WhatsApp e levar ao banimento do número. Evite envios em massa e use por sua conta e risco.
- Seu telefone precisa abrir o WhatsApp de vez em quando para manter o aparelho conectado ativo.
- Proteja `/dashboard` com um `DASHBOARD_AUTH_TOKEN` forte e restrinja `WHATSAPP_ALLOWED_NUMBERS` se quiser que só algumas pessoas sejam atendidas.
