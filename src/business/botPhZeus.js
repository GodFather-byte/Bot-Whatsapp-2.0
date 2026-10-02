// Base de conhecimento do Bot PH Zeus, extraída do folheto de preços do estúdio.
// Para atualizar preços, endereço ou contatos, edite só este arquivo: o prompt da IA e os
// comandos /precos e /endereco usam estes mesmos dados.

export const business = {
  name: 'Bot PH Zeus',
  slogan: 'Resultado lindo, pele dourada e muita auto estima.',
  // Bio do Instagram.
  tagline: 'Realçando sua melhor versão',
  positioning: 'Bronzeamento profissional',
  machine: 'Máquina vertical (frente e costas)',
  wifi: true,
  speedPitch: 'O que você levaria 1 hora, agora feito em até 30 minutinhos!',
  // Número em que este bot atende (o folheto traz (11) 97821-0334, que não vale mais).
  botWhatsapp: '(11) 99136-1386',
  // Os agendamentos são feitos com a dona do estúdio, pelo WhatsApp dela.
  bookingWhatsapp: '(11) 94578-8032',
  instagram: '@bronze_na_rapha',
  instagramUrl: 'https://www.instagram.com/bronze_na_rapha/',
  // Link que o estúdio divulga na bio do Instagram.
  bioLink: 'https://share.google/gm6G4VSD3dDOVdFMu',
  address: {
    street: 'R. Dona Primitiva Vianco, 145',
    floor: '3º Andar, Sala 312',
    district: 'Centro',
    city: 'Osasco',
    state: 'SP',
    reference: 'a 70 metros da Estação Osasco'
  },
  // O folheto não informa o horário de funcionamento. Preencha aqui (ex.: 'seg-sex 09:00-19:00')
  // quando tiver a informação confirmada; enquanto for null, o bot não inventa horários.
  openingHours: null,
  // "equivalente" é como o folheto descreve o rendimento da sessão na máquina.
  sessionLengths: [
    { minutes: 20, equivalentMinutes: 40 },
    { minutes: 30, equivalentMinutes: 60 }
  ],
  protocols: [
    {
      name: 'Protocolo Bronze',
      includes: ['ativador de marquinha', 'fitagem'],
      prices: { 20: 60, 30: 80 }
    },
    {
      name: 'Protocolo Prata',
      includes: ['ativador de marquinha', 'parafina', 'fitagem'],
      prices: { 20: 80, 30: 100 }
    },
    {
      name: 'Protocolo Ouro',
      includes: ['ativador de marquinha', 'parafina', 'banho de lua', 'fitagem'],
      prices: { 20: 100, 30: 120 }
    }
  ]
};

// Link de conversa direta no WhatsApp (assume DDI 55, Brasil).
export function whatsappUrl(phone) {
  return `https://wa.me/55${phone.replace(/\D/g, '')}`;
}

export function formatBooking(data = business) {
  return `${data.bookingWhatsapp} (${whatsappUrl(data.bookingWhatsapp)})`;
}

export function formatPrice(value) {
  return `R$ ${value.toFixed(2).replace('.', ',')}`;
}

function joinList(items) {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} e ${items.at(-1)}` : items[0] || '';
}

function sessionLabel({ minutes, equivalentMinutes }) {
  return `${minutes} minutos (equivalente a ${equivalentMinutes} minutos)`;
}

export function formatPriceList(data = business) {
  const blocks = data.protocols.map((protocol) => {
    const lines = data.sessionLengths.map((session) =>
      `- ${sessionLabel(session)}: *${formatPrice(protocol.prices[session.minutes])}*`);
    return [`*${protocol.name}*`, `_${joinList(protocol.includes)}_`, ...lines].join('\n');
  });
  return [
    `☀️ *Protocolos do ${data.name}*`,
    '',
    blocks.join('\n\n'),
    '',
    `${data.machine}. ${data.speedPitch}`,
    `📅 Para agendar, é só me dizer o dia e o horário que prefere. Se preferir falar com a dona do estúdio: ${formatBooking(data)}`
  ].join('\n');
}

export function formatAddress(data = business) {
  const { street, floor, district, city, state, reference } = data.address;
  return `${street}, ${floor} - ${district} de ${city}/${state} (${reference})`;
}

export function formatContact(data = business) {
  return [
    `📍 *${data.name}*`,
    formatAddress(data),
    '',
    `📅 Para agendar, é só me dizer o dia e o horário que prefere. Se preferir falar com a dona do estúdio: ${formatBooking(data)}`,
    `📸 Instagram: ${data.instagram} (${data.instagramUrl})`,
    data.bioLink ? `🔗 Mais informações: ${data.bioLink}` : null,
    data.openingHours ? `🕒 Horário: ${data.openingHours}` : null
  ].filter((line) => line !== null).join('\n');
}

// Instruções de sistema com tudo que a IA pode afirmar sobre o estúdio.
export function buildBusinessPrompt(data = business) {
  const priceLines = data.protocols.flatMap((protocol) => [
    `${protocol.name} (${joinList(protocol.includes)}):`,
    ...data.sessionLengths.map((session) =>
      `  - ${sessionLabel(session)}: ${formatPrice(protocol.prices[session.minutes])}`)
  ]);

  return [
    `Você é o assistente virtual de atendimento do ${data.name}, um estúdio de bronzeamento em ${data.address.city}/${data.address.state}. Fale em português do Brasil, com simpatia e objetividade, como uma boa atendente de estúdio de beleza. Seu objetivo é tirar dúvidas, informar preços e ajudar o cliente a decidir e a chegar ao estúdio. Você é um assistente virtual: se perguntarem, diga isso com naturalidade.`,
    '',
    'O que você sabe sobre o estúdio (esta é toda a informação confirmada):',
    `- Bio do Instagram: "${data.tagline}" — ${data.positioning}, em ${data.address.city}/${data.address.state}.`,
    `- Slogan: "${data.slogan}"`,
    `- Equipamento: ${data.machine}.${data.wifi ? ' Wi-Fi disponível no estúdio.' : ''}`,
    `- Economia de tempo: ${data.speedPitch}`,
    `- Endereço: ${formatAddress(data)}.`,
    `- Agendamento: você mesmo agenda, cancela e remarca com as ferramentas de agenda (veja "Como agendar"). A dona do estúdio atende pelo WhatsApp ${formatBooking(data)} quem preferir falar com uma pessoa.`,
    `- Você atende neste WhatsApp (${data.botWhatsapp}): o cliente já está falando com você, então nunca peça para ele chamar esse número.`,
    `- Instagram: ${data.instagram} (${data.instagramUrl}).${data.bioLink ? ` Link da bio: ${data.bioLink}.` : ''}`,
    `- Horário de funcionamento: ${data.openingHours || 'não informado'}.`,
    '',
    'Tabela de preços (todos os protocolos incluem a máquina vertical, frente e costas):',
    ...priceLines,
    '',
    'Regras de atendimento:',
    '- Use SOMENTE os preços e informações acima. Nunca invente descontos, pacotes, promoções, formas de pagamento, horários, vagas ou prazos.',
    '- Se o cliente pedir um valor total (várias sessões, mais de uma pessoa), some usando os preços da tabela e mostre a conta.',
    '- Ao apresentar os protocolos, explique a diferença pelo que cada um inclui e ajude a escolher; se o cliente quiser o melhor custo-benefício ou o mais completo, sugira com base na tabela.',
    '- Se faltar a informação (por exemplo, horário de funcionamento, formas de pagamento ou como funciona cada técnica em detalhe), diga com honestidade que não tem essa informação confirmada e indique a equipe. Não chute.',
    '- Perguntas de saúde (pele sensível, gravidez, medicamentos, doenças de pele, cuidados antes e depois, riscos) não são com você: não dê conselho médico nem prometa que é seguro ou garantido; recomende conversar com a equipe do estúdio e com um profissional de saúde.',
    '- Não prometa resultados específicos (cor, duração do bronze); o resultado varia de pessoa para pessoa.',
    '- Respostas curtas e fáceis de ler no celular: poucas frases, listas simples e no máximo alguns emojis (☀️ 🌞 ✨).',
    '- Se o assunto fugir do estúdio, responda brevemente com educação e volte para como você pode ajudar com o bronzeamento.',
    '',
    'Como agendar (você tem ferramentas de agenda):',
    '- Para saber horários livres, use SEMPRE consultar_horarios_livres. Nunca invente nem suponha horários ou vagas. Sem informar a data, ela mostra os próximos dias com vaga.',
    '- Converta "amanhã", "sexta", "dia 10" etc. para uma data usando a data de hoje informada, e confirme com o cliente o dia da semana e a data antes de agendar.',
    '- Antes de agendar, combine com o cliente: protocolo (Bronze, Prata ou Ouro), duração (20 ou 30 minutos), dia, horário e o nome para o agendamento. Pergunte só o que faltar, uma coisa por vez.',
    '- Só chame agendar_horario depois que o cliente confirmar esses dados. NUNCA diga que agendou antes de a ferramenta responder ok: true. Se ela devolver erro, explique com simpatia e ofereça os horários livres que ela informar.',
    '- Depois de agendar, confirme em poucas linhas: código, dia e hora, protocolo, duração, valor e endereço, e avise que o cliente receberá lembretes antes do horário e pode cancelar ou remarcar por aqui.',
    '- Para cancelar ou remarcar, use meus_agendamentos para achar o código (ou o que o cliente informar), confirme com ele e use cancelar_agendamento ou remarcar_agendamento. Para remarcar, consulte antes os horários livres do novo dia.',
    '- Se uma ferramenta de agenda disser que a agenda online não está disponível, mande o cliente chamar a dona do estúdio no WhatsApp (informado acima).'
  ].join('\n');
}
