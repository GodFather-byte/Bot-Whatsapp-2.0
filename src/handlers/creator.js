import { normalizePhoneNumber } from '../middleware/security.js';
import { formatDateTime } from '../utils/time.js';
import { resolvePatroa } from '../assistant/extras.js';

const creatorHelp = [
  'Comandos do criador (só funcionam em conversa privada):',
  '/criador ping — confirma que o bot está vivo e que reconheceu você',
  '/criador sistema — tempo ligado, memória, versão do Node e números conectados',
  '/criador contatos — quantas pessoas já conversaram com o bot e quem foram as últimas',
  '/criador historico <número> [quantidade] — últimas mensagens trocadas com esse número (padrão 10)',
  '/criador limpar <número> — apaga o histórico da conversa com esse número',
  '/criador falar <número> <texto> — o bot envia a mensagem para esse número',
  '/criador silencio [número] <tempo> — o bot para de responder aos contatos (ex.: 2 minutos, 30 min, 1 hora); com número, só essa conversa; "cancelar" volta ao normal. Sem número, ele também se cala com você até você mandar /pode falar meu filho',
  '/criador pix [chave | desligar] — mostra, troca ou desliga a chave Pix que o bot solta de brincadeira no fim das respostas',
  '/criador vip <número> <descrição> — o bot passa a reconhecer esse número (ex.: /criador vip 5511999999999 irmã do PH e chefe)',
  '/criador vips — lista os contatos reconhecidos; /criador vip remover <número> tira um',
  '/criador tom <texto> | limpar — muda o jeito de falar do bot com todos (ex.: bem debochado, ou só em rimas)',
  '/criador ficha <número> — resumo do contato: mensagens trocadas, última conversa, se é VIP ou está bloqueado',
  '/criador patroa [número nome | remover] — a esposa do PH: o bot NUNCA responde a ela, de jeito nenhum (e ela fica fora dos avisos em massa)',
  '/criador config — painel com tudo que está configurado (modo, Pix, VIPs, patroa, tom, silêncio, modelo)',
  '/criador ligar | desligar — liga o bot para todos (modo on) ou desliga de vez (modo off)',
  '/criador modelo [nome] — mostra ou troca o modelo do Gemini com o bot no ar (vale até reiniciar)',
  '/criador reiniciar — reinicia o bot (o Render o sobe de novo em segundos)',
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
export async function findChatJid(storage, number) {
  const contacts = await storage.listContacts();
  return contacts.find((jid) => jidNumber(jid) === number) || `${number}@s.whatsapp.net`;
}

const MAX_SILENCE_MINUTES = 24 * 60;

// "2 minutos", "2min", "30 s", "1 hora", "por 5": sem unidade são minutos. Devolve minutos (podem ser fração) ou null.
export function parseDuration(text = '') {
  const match = text.trim().toLowerCase().replace(/^por\s+/, '').match(/^(\d+(?:[.,]\d+)?)\s*(segundos?|seg|s|minutos?|min|m|horas?|h)?$/);
  if (!match) return null;
  const amount = Number(match[1].replace(',', '.'));
  const unit = match[2] || 'min';
  const minutes = unit.startsWith('s') ? amount / 60 : unit.startsWith('h') ? amount * 60 : amount;
  return minutes > 0 ? Math.min(minutes, MAX_SILENCE_MINUTES) : null;
}

export function parseNumber(value) {
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
  presence,
  config = {},
  gemini,
  exit = () => process.exit(0)
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
    case 'pix': {
      const settings = await storage.getBotSettings();
      if (!value) {
        const key = settings.pix === 'desligado' ? '' : (settings.pix || config.pixKey || '');
        return key ? `Pix ativo: ${key}\nPara trocar: /criador pix <chave>. Para desligar: /criador pix desligar` : 'O Pix está desligado. Para ligar: /criador pix <chave>';
      }
      if (['desligar', 'desligado', 'off', 'remover', 'limpar'].includes(value.toLowerCase())) {
        await storage.updateBotSettings({ pix: 'desligado' });
        return 'Pix desligado: o bot não solta mais a brincadeira do Pix.';
      }
      if (value.length > 100 || /\s/.test(value)) return 'Chave inválida: informe só a chave, sem espaços (CPF, telefone, e-mail ou chave aleatória).';
      await storage.updateBotSettings({ pix: value });
      return 'Pix atualizado. O bot passa a soltar a brincadeira no fim das respostas aos contatos (menos aos VIPs e a você).';
    }
    case 'vip': {
      const [first = '', ...others] = value.split(/\s+/);
      const settings = await storage.getBotSettings();
      const vips = { ...(settings.vips || {}) };
      if (['remover', 'tirar', 'apagar'].includes(first.toLowerCase())) {
        const number = parseNumber(others[0]);
        if (!number) return 'Use: /criador vip remover 5511999999999';
        if (!vips[number]) return config.vipContacts?.[number] ? `${number} vem da configuração (CONTATOS_VIP); tire de lá.` : `${number} não era VIP.`;
        delete vips[number];
        await storage.updateBotSettings({ vips: Object.keys(vips).length ? vips : null });
        return `${number} não é mais VIP.`;
      }
      const number = parseNumber(first);
      const description = others.join(' ').trim();
      if (!number || !description) return 'Use: /criador vip 5511999999999 irmã do PH e chefe';
      if (description.length > 80) return 'Descrição longa demais: até 80 caracteres.';
      vips[number] = description;
      await storage.updateBotSettings({ vips });
      return `${number} agora é reconhecido como: ${description}. O bot trata essa pessoa com respeito e não manda a brincadeira do Pix para ela.`;
    }
    case 'vips': {
      const settings = await storage.getBotSettings();
      const entries = Object.entries({ ...(config.vipContacts || {}), ...(settings.vips || {}) });
      return entries.length ? `Contatos reconhecidos:\n${entries.map(([number, description]) => `- ${number}: ${description}`).join('\n')}` : 'Nenhum VIP ainda. Use /criador vip <número> <descrição>.';
    }
    case 'tom': {
      if (!value) return `Tom atual: ${(await storage.getBotSettings()).tom || '(padrão de consigliere)'}\nPara mudar: /criador tom <texto>. Para voltar: /criador tom limpar`;
      if (['limpar', 'desligar', 'remover', 'padrao', 'padrão'].includes(value.toLowerCase())) {
        await storage.updateBotSettings({ tom: null });
        return 'Tom restaurado: o bot volta ao jeito padrão de consigliere.';
      }
      if (value.length > 300) return 'Texto longo demais: até 300 caracteres.';
      await storage.updateBotSettings({ tom: value });
      return `Tom atualizado: ${value}`;
    }
    case 'ficha': {
      const number = parseNumber(value);
      if (!number) return 'Use: /criador ficha 5511999999999';
      const chatJid = await findChatJid(storage, number);
      const [history, blocked, settings] = await Promise.all([storage.getHistory(chatJid, 30), storage.isBlocked([number]), storage.getBotSettings()]);
      const vip = { ...(config.vipContacts || {}), ...(settings.vips || {}) }[number];
      const last = history.at(-1);
      return [
        `Ficha de ${number}`,
        `Mensagens guardadas: ${history.length}${history.length === 30 ? '+' : ''}`,
        last?.timestamp ? `Última conversa: ${formatDateTime(new Date(last.timestamp), timeZone)}` : 'Ainda não conversou com o bot.',
        `VIP: ${vip || 'não'}`,
        `Bloqueado: ${blocked ? 'sim' : 'não'}`
      ].join('\n');
    }
    case 'patroa': {
      const settings = await storage.getBotSettings();
      const current = resolvePatroa(config.patroa, settings.patroa);
      if (!value) {
        return current
          ? `Patroa: ${current.name} (${current.number}). O bot nunca responde a ela e a deixa de fora dos avisos em massa.\nTroque com /criador patroa <número> <nome> ou tire com /criador patroa remover.`
          : 'Nenhuma patroa definida. Use /criador patroa 558699028292 Paulina';
      }
      const [first = '', ...others] = value.split(/\s+/);
      if (['remover', 'tirar', 'apagar'].includes(first.toLowerCase())) {
        if (!settings.patroa && config.patroa) return 'A patroa vem da configuração (NUMERO_PATROA); tire de lá.';
        await storage.updateBotSettings({ patroa: null });
        return 'Patroa removida: o número dela volta a ser tratado como contato comum.';
      }
      const number = parseNumber(first);
      if (!number) return 'Use: /criador patroa 558699028292 Paulina';
      const name = others.join(' ').trim() || 'Patroa';
      await storage.updateBotSettings({ patroa: { number, name } });
      return `Patroa definida: ${name} (${number}). O bot não responde mais a ela, de jeito nenhum, e ela fica fora dos avisos em massa.`;
    }
    case 'config': {
      const settings = await storage.getBotSettings();
      const patroa = resolvePatroa(config.patroa, settings.patroa);
      const vips = Object.entries({ ...(config.vipContacts || {}), ...(settings.vips || {}) });
      const pixKey = settings.pix === 'desligado' ? '' : (settings.pix || config.pixKey || '');
      const silenced = presence?.silencedUntil?.();
      return [
        '*Painel do criador*',
        `Modo: ${settings.ausencia || 'on'} (on = responde a todos; auto = só quando o dono está offline; off = calado)`,
        `Modelo do Gemini: ${gemini?.getModel?.() || config.geminiModel || '(desconhecido)'}`,
        `Pix: ${pixKey ? 'ligado (a chave só sai quando alguém pede)' : 'desligado'}`,
        `Patroa (nunca respondida): ${patroa ? `${patroa.name} (${patroa.number})` : '(nenhuma)'}`,
        `VIPs: ${vips.length ? vips.map(([number, description]) => `${number} (${description})`).join('; ') : '(nenhum)'}`,
        `Tom extra: ${settings.tom || '(nenhum)'}`,
        `Instruções do dono: ${settings.instrucoes || '(nenhuma)'}`,
        `Horário de ausência: ${settings.ausenciaHorario || '(nenhum)'}`,
        `Silêncio geral: ${silenced ? `até ${formatDateTime(new Date(silenced), timeZone)}` : 'não'}`,
        `Bloqueados: ${(await storage.listBlocked()).length}`
      ].join('\n');
    }
    case 'ligar':
      await storage.updateBotSettings({ ausencia: 'on' });
      return 'Bot ligado: responde a todos os contatos.';
    case 'desligar':
      await storage.updateBotSettings({ ausencia: 'off' });
      return 'Bot desligado: não responde a nenhum contato até você mandar /criador ligar.';
    case 'modelo': {
      if (!gemini?.getModel) return 'A troca de modelo não está disponível.';
      if (!value) return `Modelo atual: ${gemini.getModel()}\nPara trocar: /criador modelo <nome> (ex.: gemini-2.5-flash). Vale até reiniciar.`;
      if (!/^[a-z0-9][a-z0-9._-]{2,60}$/i.test(value)) return 'Nome de modelo inválido.';
      const previous = gemini.getModel();
      gemini.setModel(value);
      return `Modelo trocado: ${previous} → ${value}. Vale até reiniciar; se der erro, volte com /criador modelo ${previous}`;
    }
    case 'reiniciar': {
      setTimeout(exit, 1500).unref?.();
      return 'Reiniciando em instantes, meu criador. 🕴️ Volto já, já.';
    }
    default:
      return `Comando de criador desconhecido.\n\n${creatorHelp}`;
  }
}
