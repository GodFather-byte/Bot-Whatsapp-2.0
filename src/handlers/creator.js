import { normalizePhoneNumber } from '../middleware/security.js';
import { formatDateTime } from '../utils/time.js';

const creatorHelp = [
  'Comandos do criador (só funcionam em conversa privada):',
  '/criador ping — confirma que o bot está vivo e que reconheceu você',
  '/criador sistema — tempo ligado, memória, versão do Node e números conectados',
  '/criador contatos — quantas pessoas já conversaram com o bot e quem foram as últimas',
  '/criador historico <número> [quantidade] — últimas mensagens trocadas com esse número (padrão 10)',
  '/criador limpar <número> — apaga o histórico da conversa com esse número',
  '/criador falar <número> <texto> — o bot envia a mensagem para esse número',
  '/criador silencio [número] <tempo> — o bot para de responder aos contatos (ex.: 2 minutos, 30 min, 1 hora); com número, só essa conversa; "cancelar" volta ao normal. Sem número, ele também se cala com você até você mandar /pode falar meu filho',
  '/admin ajuda — o criador também tem todas as ordens de dono'
].join('\n');

const orEmpty = (value) => value || '(vazio)';
const jidNumber = (jid) => normalizePhoneNumber(jid);

function formatDuration(totalSeconds) {
  const seconds = Math.floor(totalSeconds);
  const parts = [[Math.floor(seconds / 86400), 'd'], [Math.floor(seconds / 3600) % 24, 'h'], [Math.floor(seconds / 60) % 60, 'min']]
    .filter(([amount]) => amount > 0)
    .map(([amount, unit]) => `${amount}${unit}`);
  return parts.length ? parts.join(' ') : `${seconds % 60}s`;
}

// Acha a conversa do número entre os contatos conhecidos (o WhatsApp pode usar JID de telefone ou LID).
async function findChatJid(storage, number) {
  const contacts = await storage.listContacts();
  return contacts.find((jid) => jidNumber(jid) === number) || `${number}@s.whatsapp.net`;
}

const MAX_SILENCE_MINUTES = 24 * 60;

// "2 minutos", "2min", "30 s", "1 hora", "por 5": sem unidade são minutos. Devolve minutos (podem ser fração) ou null.
function parseDuration(text = '') {
  const match = text.trim().toLowerCase().replace(/^por\s+/, '').match(/^(\d+(?:[.,]\d+)?)\s*(segundos?|seg|s|minutos?|min|m|horas?|h)?$/);
  if (!match) return null;
  const amount = Number(match[1].replace(',', '.'));
  const unit = match[2] || 'min';
  const minutes = unit.startsWith('s') ? amount / 60 : unit.startsWith('h') ? amount * 60 : amount;
  return minutes > 0 ? Math.min(minutes, MAX_SILENCE_MINUTES) : null;
}

function parseNumber(value) {
  const number = normalizePhoneNumber(value || '');
  return number.length >= 10 && number.length <= 15 ? number : null;
}

export async function handleCreatorCommand(argument, {
  storage,
  stats,
  getStatus = () => ({}),
  sock,
  timeZone = 'America/Sao_Paulo',
  uptimeSeconds = () => process.uptime(),
  memoryUsage = () => process.memoryUsage(),
  nodeVersion = process.version,
  presence
}) {
  const [, subcommand = '', rest = ''] = argument.match(/^(\S*)\s*([\s\S]*)$/) || [];
  const value = rest.trim();

  switch (subcommand.toLowerCase()) {
    case '':
    case 'ajuda':
      return creatorHelp;
    case 'ping':
      return `Pong! 🕴️ Reconheço você, meu criador. No ar há ${formatDuration(uptimeSeconds())}.`;
    case 'sistema': {
      const status = getStatus();
      const bots = (status.bots || []).map(({ numero, conectado }) => `${conectado ? '🟢' : '🔴'} ${numero}`).join('\n');
      return [
        `No ar há ${formatDuration(uptimeSeconds())}`,
        `Memória: ${Math.round(memoryUsage().rss / 1024 / 1024)} MB · Node ${nodeVersion}`,
        `MongoDB: ${status.mongoConnected ? 'conectado' : 'não conectado'}`,
        `Mensagens processadas: ${stats.totalMessages} · erros em 24h: ${stats.errorEvents.length} · limites acionados em 24h: ${stats.rateLimitEvents?.length ?? 0}`,
        bots && `Números do bot:\n${bots}`
      ].filter(Boolean).join('\n');
    }
    case 'contatos': {
      const contacts = await storage.listContacts();
      if (!contacts.length) return 'Ninguém conversou com o bot ainda.';
      const recent = stats.recentMessages.slice(0, 5)
        .map(({ de, timestamp }) => `- ${jidNumber(de)} (${formatDateTime(new Date(timestamp), timeZone)})`);
      return [
        `${contacts.length} contatos já conversaram com o bot.`,
        recent.length && `Últimas mensagens:\n${recent.join('\n')}`
      ].filter(Boolean).join('\n');
    }
    case 'historico':
    case 'histórico': {
      const [numberText, limitText] = value.split(/\s+/);
      const number = parseNumber(numberText);
      if (!number) return 'Informe o número com DDI e DDD: /criador historico 5511999999999 [quantidade]';
      const limit = Math.min(Math.max(Number.parseInt(limitText, 10) || 10, 1), 30);
      const history = await storage.getHistory(await findChatJid(storage, number), limit);
      if (!history.length) return `Nenhuma mensagem guardada com ${number}.`;
      return history.map(({ role, conteudo }) => `${role === 'assistant' ? 'Bot' : 'Contato'}: ${orEmpty(String(conteudo).slice(0, 300))}`).join('\n');
    }
    case 'limpar': {
      const number = parseNumber(value);
      if (!number) return 'Informe o número com DDI e DDD: /criador limpar 5511999999999';
      await storage.resetHistory(await findChatJid(storage, number));
      return `Histórico com ${number} apagado.`;
    }
    case 'falar': {
      const [, numberText = '', text = ''] = value.match(/^(\S+)\s+([\s\S]+)$/) || [];
      const number = parseNumber(numberText);
      if (!number || !text.trim()) return 'Use: /criador falar 5511999999999 <texto>';
      await sock.sendMessage(`${number}@s.whatsapp.net`, { text: text.trim() });
      return `Mensagem enviada para ${number}.`;
    }
    case 'silencio':
    case 'silêncio': {
      if (!presence?.silence) return 'O controle de silêncio não está disponível.';
      const usage = 'Use: /criador silencio 2 minutos | /criador silencio 5511999999999 10 min | /criador silencio cancelar';
      const [first = '', ...others] = value.split(/\s+/);
      const target = parseNumber(first);
      const chatJid = target ? await findChatJid(storage, target) : undefined;
      const argumentText = target ? others.join(' ') : value;
      if (['cancelar', 'desligar', 'voltar', 'off'].includes(argumentText.toLowerCase())) {
        return presence.clearSilence(chatJid) ? 'Silêncio cancelado: o bot voltou a responder.' : 'O bot não estava em silêncio.';
      }
      const minutes = parseDuration(argumentText);
      if (!minutes) return usage;
      const until = presence.silence({ chatJid, minutes });
      return `Bico calado ${target ? `na conversa com ${target}` : 'com todos os contatos e com você'} até ${formatDateTime(new Date(until), timeZone)}. Para eu voltar a falar com você: /pode falar meu filho. Para encerrar tudo antes: /criador silencio cancelar`;
    }
    default:
      return `Comando de criador desconhecido.\n\n${creatorHelp}`;
  }
}
