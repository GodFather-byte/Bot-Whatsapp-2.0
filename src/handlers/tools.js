import { business } from '../business/botPhZeus.js';

export const toolDeclarations = [
  {
    name: 'consultar_horarios_livres',
    description: 'Consulta os horários livres do estúdio para agendamento. Com a data (AAAA-MM-DD) mostra aquele dia; sem data, mostra os próximos dias com horário livre. Use sempre antes de oferecer ou confirmar um horário.',
    parameters: {
      type: 'OBJECT',
      properties: { data: { type: 'STRING', description: 'Data no formato AAAA-MM-DD (opcional).' } }
    }
  },
  {
    name: 'agendar_horario',
    description: 'Agenda um horário para o cliente desta conversa. Só chame depois de o cliente confirmar protocolo, duração, data, horário e nome.',
    parameters: {
      type: 'OBJECT',
      properties: {
        data: { type: 'STRING', description: 'Data no formato AAAA-MM-DD.' },
        hora: { type: 'STRING', description: 'Horário HH:MM, um dos horários livres informados pela ferramenta.' },
        protocolo: { type: 'STRING', description: 'Bronze, Prata ou Ouro.' },
        duracao_minutos: { type: 'INTEGER', description: '20 ou 30.' },
        nome: { type: 'STRING', description: 'Nome do cliente para o agendamento.' }
      },
      required: ['data', 'hora', 'protocolo', 'duracao_minutos', 'nome']
    }
  },
  {
    name: 'meus_agendamentos',
    description: 'Lista os agendamentos futuros do cliente desta conversa, com o código de cada um.'
  },
  {
    name: 'cancelar_agendamento',
    description: 'Cancela um agendamento do cliente desta conversa, depois de ele confirmar.',
    parameters: {
      type: 'OBJECT',
      properties: { codigo: { type: 'STRING', description: 'Código do agendamento, como A7K3Q.' } },
      required: ['codigo']
    }
  },
  {
    name: 'remarcar_agendamento',
    description: 'Muda um agendamento do cliente desta conversa para outro horário livre, mantendo protocolo e duração. Consulte os horários livres antes.',
    parameters: {
      type: 'OBJECT',
      properties: {
        codigo: { type: 'STRING', description: 'Código do agendamento, como A7K3Q.' },
        data: { type: 'STRING', description: 'Nova data no formato AAAA-MM-DD.' },
        hora: { type: 'STRING', description: 'Novo horário HH:MM.' }
      },
      required: ['codigo', 'data', 'hora']
    }
  },
  {
    name: 'obter_clima',
    description: 'Consulta o clima atual de uma cidade.',
    parameters: { type: 'OBJECT', properties: { cidade: { type: 'STRING' } }, required: ['cidade'] }
  },
  {
    name: 'buscar_noticias',
    description: 'Busca notícias recentes sobre um tópico.',
    parameters: { type: 'OBJECT', properties: { topico: { type: 'STRING' } }, required: ['topico'] }
  },
  {
    name: 'converter_moeda',
    description: 'Converte um valor entre duas moedas.',
    parameters: {
      type: 'OBJECT',
      properties: {
        valor: { type: 'NUMBER' },
        de: { type: 'STRING' },
        para: { type: 'STRING' }
      },
      required: ['valor', 'de', 'para']
    }
  },
  {
    name: 'consultar_horario',
    description: 'Consulta a hora atual de um fuso horário IANA.',
    parameters: { type: 'OBJECT', properties: { fuso: { type: 'STRING' } }, required: ['fuso'] }
  },
  {
    name: 'calcular_expressao',
    description: 'Calcula uma expressão aritmética simples.',
    parameters: { type: 'OBJECT', properties: { expr: { type: 'STRING' } }, required: ['expr'] }
  }
];

function calculate(expression) {
  const tokens = expression.match(/\d+(?:\.\d+)?|[()+\-*/]/g);
  if (!tokens || tokens.join('') !== expression.replace(/\s/g, '') || tokens.length > 100) {
    throw new Error('Expressão inválida.');
  }
  let position = 0;

  function factor() {
    const token = tokens[position++];
    if (token === '+' || token === '-') {
      const value = factor();
      return token === '-' ? -value : value;
    }
    if (token === '(') {
      const value = sum();
      if (tokens[position++] !== ')') throw new Error('Parêntese não fechado.');
      return value;
    }
    const value = Number(token);
    if (!Number.isFinite(value)) throw new Error('Número inválido.');
    return value;
  }

  function product() {
    let value = factor();
    while (tokens[position] === '*' || tokens[position] === '/') {
      const operator = tokens[position++];
      const right = factor();
      value = operator === '*' ? value * right : value / right;
    }
    return value;
  }

  function sum() {
    let value = product();
    while (tokens[position] === '+' || tokens[position] === '-') {
      const operator = tokens[position++];
      const right = product();
      value = operator === '+' ? value + right : value - right;
    }
    return value;
  }

  const result = sum();
  if (position !== tokens.length || !Number.isFinite(result)) throw new Error('Expressão inválida.');
  return result;
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Serviço externo retornou HTTP ${response.status}.`);
  return response.json();
}

const agendaUnavailable = {
  ok: false,
  indisponivel: true,
  erro: 'A agenda online não está disponível nesta conversa.',
  orientacao: `Peça para o cliente agendar direto com a dona do estúdio, pelo WhatsApp ${business.bookingWhatsapp}.`
};

// `agenda` e `client` vêm do bot (não da IA): o cliente só enxerga e altera os próprios agendamentos.
export async function executeTool(name, args = {}, { apiKeys = {}, agenda, client } = {}) {
  const text = (value) => String(value ?? '').trim();
  switch (name) {
    case 'consultar_horarios_livres':
      if (!agenda) return agendaUnavailable;
      return args.data ? agenda.availability(text(args.data)) : agenda.nextAvailability();
    case 'agendar_horario':
      if (!agenda || !client) return agendaUnavailable;
      return agenda.book({
        clientJid: client.jid,
        clientNumber: client.number,
        clientName: text(args.nome) || client.name,
        protocol: args.protocolo,
        durationMin: args.duracao_minutos,
        date: text(args.data),
        time: text(args.hora)
      });
    case 'meus_agendamentos':
      if (!agenda || !client) return agendaUnavailable;
      return { ok: true, agendamentos: await agenda.listClient(client.jid) };
    case 'cancelar_agendamento':
      if (!agenda || !client) return agendaUnavailable;
      return agenda.cancel({ id: args.codigo, requesterJid: client.jid, by: 'cliente' });
    case 'remarcar_agendamento':
      if (!agenda || !client) return agendaUnavailable;
      return agenda.reschedule({ id: args.codigo, requesterJid: client.jid, date: text(args.data), time: text(args.hora) });
    case 'obter_clima': {
      if (!apiKeys.weather) return { erro: 'Consulta de clima indisponível: configure TOOL_WEATHER_API_KEY.' };
      const url = new URL('https://api.openweathermap.org/data/2.5/weather');
      url.search = new URLSearchParams({ q: args.cidade, appid: apiKeys.weather, units: 'metric', lang: 'pt_br' });
      const weather = await fetchJson(url);
      return { cidade: weather.name, temperatura: weather.main?.temp, descricao: weather.weather?.[0]?.description };
    }
    case 'buscar_noticias': {
      if (!apiKeys.news) return { erro: 'Busca de notícias indisponível: configure TOOL_NEWS_API_KEY.' };
      const url = new URL('https://newsapi.org/v2/everything');
      url.search = new URLSearchParams({ q: args.topico, sortBy: 'publishedAt', pageSize: '5', apiKey: apiKeys.news });
      const news = await fetchJson(url);
      return { artigos: (news.articles || []).map(({ title, url: link, description }) => ({ title, url: link, description })) };
    }
    case 'converter_moeda': {
      if (!apiKeys.exchangeRate) return { erro: 'Conversão de moeda indisponível: configure TOOL_EXCHANGE_RATE_API_KEY.' };
      const url = new URL(`https://v6.exchangerate-api.com/v6/${encodeURIComponent(apiKeys.exchangeRate)}/pair/${encodeURIComponent(args.de)}/${encodeURIComponent(args.para)}/${encodeURIComponent(args.valor)}`);
      const result = await fetchJson(url);
      if (result.result !== 'success') throw new Error('Não foi possível converter essa moeda.');
      return { valor: args.valor, de: args.de.toUpperCase(), para: args.para.toUpperCase(), convertido: result.conversion_result };
    }
    case 'consultar_horario': {
      const date = new Date();
      return { fuso: args.fuso, horario: new Intl.DateTimeFormat('pt-BR', {
        timeZone: args.fuso,
        dateStyle: 'full',
        timeStyle: 'long'
      }).format(date) };
    }
    case 'calcular_expressao':
      return { resultado: calculate(String(args.expr || '')) };
    default:
      throw new Error(`Ferramenta desconhecida: ${name}`);
  }
}
