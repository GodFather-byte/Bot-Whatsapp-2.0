import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';

export class MemoryStorage {
  constructor() {
    this.conversations = new Map();
    this.users = new Map();
    this.reminders = new Map();
    this.blocked = new Set();
    this.botSettings = {};
    this.usage = new Map();
    this.appointments = new Map();
    this.closedDays = new Map();
  }

  async getHistory(remoteJid, limit = 10) {
    return (this.conversations.get(remoteJid) || []).slice(-limit);
  }

  async addMessage(message) {
    const messages = this.conversations.get(message.remoteJid) || [];
    messages.push({ ...message, timestamp: message.timestamp || new Date() });
    this.conversations.set(message.remoteJid, messages.slice(-100));
  }

  async resetHistory(remoteJid) {
    this.conversations.delete(remoteJid);
  }

  async getUser(remoteJid) {
    return this.users.get(remoteJid) || {};
  }

  async updateUser(remoteJid, changes) {
    const user = { ...(this.users.get(remoteJid) || {}), ...changes, remoteJid, atualizadoEm: new Date() };
    this.users.set(remoteJid, user);
    return user;
  }

  async createReminder(reminder) {
    const stored = {
      ...reminder,
      id: reminder.id || randomUUID(),
      enviado: false,
      criadoEm: new Date()
    };
    this.reminders.set(stored.id, stored);
    return stored;
  }

  async getReminders(remoteJid) {
    return [...this.reminders.values()]
      .filter((reminder) => reminder.usuarioId === remoteJid && !reminder.enviado)
      .sort((left, right) => new Date(left.agendadoPara) - new Date(right.agendadoPara));
  }

  async cancelReminder(remoteJid, id) {
    const reminder = this.reminders.get(id);
    if (!reminder || reminder.usuarioId !== remoteJid || reminder.enviado) return false;
    this.reminders.delete(id);
    return true;
  }

  async getDueReminders(now = new Date()) {
    return [...this.reminders.values()].filter(
      (reminder) => !reminder.enviado && new Date(reminder.agendadoPara) <= now
    );
  }

  async markReminderSent(id) {
    const reminder = this.reminders.get(id);
    if (reminder) this.reminders.set(id, { ...reminder, enviado: true });
  }

  async rescheduleReminder(id, agendadoPara) {
    const reminder = this.reminders.get(id);
    if (reminder) this.reminders.set(id, { ...reminder, agendadoPara });
  }

  async listContacts() {
    return [...this.conversations.keys()].filter((jid) => !jid.endsWith('@g.us'));
  }

  // A lista de bloqueados vale para todos os números do bot.
  async blockNumber(number) {
    this.blocked.add(number);
  }

  async unblockNumber(number) {
    return this.blocked.delete(number);
  }

  async isBlocked(numbers) {
    return numbers.some((number) => this.blocked.has(number));
  }

  async listBlocked() {
    return [...this.blocked];
  }

  // Configurações de cada número do bot: instruções, boas-vindas e horário de atendimento.
  async getBotSettings() {
    return { ...this.botSettings };
  }

  async updateBotSettings(changes) {
    this.botSettings = { ...this.botSettings, ...changes };
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) delete this.botSettings[key];
    }
    return this.getBotSettings();
  }

  // Agendamentos: cada horário (inicio) aceita no máximo um agendamento confirmado.
  async createAppointment(appointment) {
    const start = new Date(appointment.inicio).getTime();
    const taken = [...this.appointments.values()].some(
      (stored) => stored.status === 'confirmado' && new Date(stored.inicio).getTime() === start
    );
    if (taken) return { ok: false, motivo: 'ocupado' };
    const stored = { ...appointment, status: 'confirmado', criadoEm: new Date() };
    this.appointments.set(stored.id, stored);
    return { ok: true, appointment: stored };
  }

  async getAppointment(id) {
    return this.appointments.get(id) || null;
  }

  async updateAppointment(id, changes) {
    const stored = this.appointments.get(id);
    if (!stored) return null;
    const updated = { ...stored, ...changes };
    this.appointments.set(id, updated);
    return updated;
  }

  // Cancela só o que está confirmado; devolve o agendamento cancelado, ou null.
  async cancelAppointment(id, { por, motivo } = {}) {
    const stored = this.appointments.get(id);
    if (!stored || stored.status !== 'confirmado') return null;
    return this.updateAppointment(id, {
      status: 'cancelado',
      canceladoEm: new Date(),
      ...(por && { canceladoPor: por }),
      ...(motivo && { canceladoMotivo: motivo })
    });
  }

  // Agendamentos confirmados com início em [from, to), do mais cedo para o mais tarde.
  async listAppointments({ from, to } = {}) {
    return [...this.appointments.values()]
      .filter((stored) => stored.status === 'confirmado'
        && (!from || new Date(stored.inicio) >= from)
        && (!to || new Date(stored.inicio) < to))
      .sort((left, right) => new Date(left.inicio) - new Date(right.inicio));
  }

  async listClientAppointments(clienteJid, { from = new Date() } = {}) {
    return (await this.listAppointments({ from })).filter((stored) => stored.clienteJid === clienteJid);
  }

  // Dias em que o estúdio não atende (feriado, folga). A chave do dia é "AAAA-MM-DD".
  async closeDay(day, motivo = '') {
    this.closedDays.set(day, { dia: day, motivo });
  }

  async openDay(day) {
    return this.closedDays.delete(day);
  }

  async listClosedDays(fromDay = '') {
    return [...this.closedDays.values()].filter(({ dia }) => dia >= fromDay).sort((a, b) => a.dia.localeCompare(b.dia));
  }

  // Uso da API do Gemini por dia de cota, somado para todos os números do bot.
  async incrementUsage(day, changes) {
    const entry = this.usage.get(day) || {};
    for (const [key, value] of Object.entries(changes)) {
      const path = key.split('.');
      let target = entry;
      for (const part of path.slice(0, -1)) target = target[part] ||= {};
      target[path.at(-1)] = (target[path.at(-1)] || 0) + value;
    }
    this.usage.set(day, entry);
  }

  async getUsage(days) {
    return Object.fromEntries(days.filter((day) => this.usage.has(day)).map((day) => [day, this.usage.get(day)]));
  }

  async loadStats() {
    return null;
  }

  async saveStats() {}

  forBot() {
    const storage = new MemoryStorage();
    storage.blocked = this.blocked;
    return storage;
  }

  async adoptUntaggedData() {}

  async close() {}
}

const withId = ({ _id, ...stored }) => ({ ...stored, id: stored.id || _id });

export class MongoStorage extends MemoryStorage {
  // Com botId, cada número do bot enxerga apenas os próprios históricos, usuários e lembretes.
  constructor(client, dbName = 'whatsapp-gemini-bot', botId = null) {
    super();
    this.client = client;
    this.dbName = dbName;
    this.botId = botId;
    this.scope = botId ? { botId } : {};
    const database = client.db(dbName);
    this.conversas = database.collection('conversas');
    this.usuarios = database.collection('usuarios');
    this.lembretes = database.collection('lembretes');
    this.bloqueados = database.collection('bloqueados');
    this.configBots = database.collection('config_bots');
    this.estatisticas = database.collection('estatisticas');
    this.usoApi = database.collection('uso_api');
    this.agendamentos = database.collection('agendamentos');
    this.diasFechados = database.collection('dias_fechados');
  }

  // Garante, no próprio banco, que um horário nunca receba dois agendamentos confirmados.
  async ensureIndexes() {
    await this.agendamentos.createIndex(
      { botId: 1, inicio: 1 },
      { unique: true, partialFilterExpression: { status: 'confirmado' }, name: 'horario_unico_confirmado' }
    );
    await this.agendamentos.createIndex({ clienteJid: 1, inicio: 1 }, { name: 'cliente_inicio' });
  }

  async getHistory(remoteJid, limit = 10) {
    try {
      const messages = await this.conversas.find({ ...this.scope, remoteJid }).sort({ timestamp: -1 }).limit(limit).toArray();
      return messages.reverse().map(({ _id, ...message }) => message);
    } catch {
      return super.getHistory(remoteJid, limit);
    }
  }

  async addMessage(message) {
    const stored = { ...message, ...this.scope, timestamp: message.timestamp || new Date() };
    await super.addMessage(stored);
    try {
      await this.conversas.insertOne(stored);
      await this.conversas.deleteMany(
        { ...this.scope, remoteJid: message.remoteJid, _id: { $nin: await this.conversas.find({ ...this.scope, remoteJid: message.remoteJid })
          .sort({ timestamp: -1 }).limit(100).project({ _id: 1 }).map(({ _id }) => _id).toArray() } }
      );
    } catch {
      return;
    }
  }

  async resetHistory(remoteJid) {
    await super.resetHistory(remoteJid);
    try {
      await this.conversas.deleteMany({ ...this.scope, remoteJid });
    } catch {
      return;
    }
  }

  async getUser(remoteJid) {
    try {
      const user = await this.usuarios.findOne({ ...this.scope, remoteJid });
      return user ? { ...user, remoteJid } : super.getUser(remoteJid);
    } catch {
      return super.getUser(remoteJid);
    }
  }

  async updateUser(remoteJid, changes) {
    const user = await super.updateUser(remoteJid, changes);
    try {
      await this.usuarios.updateOne(
        { ...this.scope, remoteJid },
        { $set: { ...user, ...this.scope }, $setOnInsert: { criadoEm: new Date() } },
        { upsert: true }
      );
    } catch {
      return user;
    }
    return user;
  }

  async createReminder(reminder) {
    const stored = await super.createReminder(reminder);
    try {
      await this.lembretes.insertOne({ ...stored, ...this.scope, _id: stored.id });
    } catch {
      return stored;
    }
    return stored;
  }

  async getReminders(remoteJid) {
    try {
      const reminders = await this.lembretes.find({ ...this.scope, usuarioId: remoteJid, enviado: false })
        .sort({ agendadoPara: 1 }).toArray();
      return reminders.map(({ _id, ...reminder }) => ({ ...reminder, id: reminder.id || _id }));
    } catch {
      return super.getReminders(remoteJid);
    }
  }

  async cancelReminder(remoteJid, id) {
    const cancelled = await super.cancelReminder(remoteJid, id);
    try {
      const result = await this.lembretes.deleteOne({ ...this.scope, _id: id, usuarioId: remoteJid, enviado: false });
      return result.deletedCount > 0 || cancelled;
    } catch {
      return cancelled;
    }
  }

  async getDueReminders(now = new Date()) {
    try {
      const reminders = await this.lembretes.find({
        ...this.scope,
        agendadoPara: { $lte: now },
        enviado: false
      }).toArray();
      return reminders.map(({ _id, ...reminder }) => ({ ...reminder, id: reminder.id || _id }));
    } catch {
      return super.getDueReminders(now);
    }
  }

  async markReminderSent(id) {
    await super.markReminderSent(id);
    try {
      await this.lembretes.updateOne({ _id: id }, { $set: { enviado: true } });
    } catch {
      return;
    }
  }

  async rescheduleReminder(id, agendadoPara) {
    await super.rescheduleReminder(id, agendadoPara);
    try {
      await this.lembretes.updateOne({ _id: id }, { $set: { agendadoPara } });
    } catch {
      return;
    }
  }

  async listContacts() {
    try {
      return await this.conversas.distinct('remoteJid', { ...this.scope, remoteJid: { $not: /@g\.us$/ } });
    } catch {
      return super.listContacts();
    }
  }

  async blockNumber(number) {
    await super.blockNumber(number);
    await this.bloqueados.updateOne({ _id: number }, { $set: { bloqueadoEm: new Date() } }, { upsert: true });
  }

  async unblockNumber(number) {
    const removed = await super.unblockNumber(number);
    const result = await this.bloqueados.deleteOne({ _id: number });
    return result.deletedCount > 0 || removed;
  }

  async isBlocked(numbers) {
    try {
      return (await this.bloqueados.countDocuments({ _id: { $in: numbers } })) > 0;
    } catch {
      return super.isBlocked(numbers);
    }
  }

  async listBlocked() {
    try {
      return (await this.bloqueados.find().toArray()).map(({ _id }) => _id);
    } catch {
      return super.listBlocked();
    }
  }

  async getBotSettings() {
    try {
      const { _id, ...settings } = (await this.configBots.findOne({ _id: this.botId || 'principal' })) || {};
      return settings;
    } catch {
      return super.getBotSettings();
    }
  }

  async updateBotSettings(changes) {
    await super.updateBotSettings(changes);
    const $set = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== null));
    const $unset = Object.fromEntries(Object.entries(changes).filter(([, value]) => value === null).map(([key]) => [key, '']));
    await this.configBots.updateOne(
      { _id: this.botId || 'principal' },
      { ...(Object.keys($set).length && { $set }), ...(Object.keys($unset).length && { $unset }) },
      { upsert: true }
    );
    return this.getBotSettings();
  }

  async createAppointment(appointment) {
    const result = await super.createAppointment(appointment);
    if (!result.ok) return result;
    try {
      await this.agendamentos.insertOne({ ...result.appointment, ...this.scope, _id: result.appointment.id });
    } catch (error) {
      // Índice único: outro agendamento confirmado já ocupa este horário.
      if (error?.code === 11000) {
        this.appointments.delete(result.appointment.id);
        return { ok: false, motivo: 'ocupado' };
      }
    }
    return result;
  }

  async getAppointment(id) {
    try {
      const stored = await this.agendamentos.findOne({ ...this.scope, _id: id });
      return stored ? withId(stored) : super.getAppointment(id);
    } catch {
      return super.getAppointment(id);
    }
  }

  async updateAppointment(id, changes) {
    await super.updateAppointment(id, changes);
    try {
      await this.agendamentos.updateOne({ ...this.scope, _id: id }, { $set: changes });
    } catch {
      return super.getAppointment(id);
    }
    return this.getAppointment(id);
  }

  async cancelAppointment(id, { por, motivo } = {}) {
    const cancelledInMemory = await super.cancelAppointment(id, { por, motivo });
    try {
      const stored = await this.agendamentos.findOneAndUpdate(
        { ...this.scope, _id: id, status: 'confirmado' },
        { $set: {
          status: 'cancelado',
          canceladoEm: new Date(),
          ...(por && { canceladoPor: por }),
          ...(motivo && { canceladoMotivo: motivo })
        } },
        { returnDocument: 'after' }
      );
      return stored ? withId(stored) : cancelledInMemory;
    } catch {
      return cancelledInMemory;
    }
  }

  async listAppointments({ from, to } = {}) {
    try {
      const inicio = { ...(from && { $gte: from }), ...(to && { $lt: to }) };
      const stored = await this.agendamentos
        .find({ ...this.scope, status: 'confirmado', ...(Object.keys(inicio).length && { inicio }) })
        .sort({ inicio: 1 }).toArray();
      return stored.map(withId);
    } catch {
      return super.listAppointments({ from, to });
    }
  }

  async listClientAppointments(clienteJid, { from = new Date() } = {}) {
    try {
      const stored = await this.agendamentos
        .find({ ...this.scope, status: 'confirmado', clienteJid, inicio: { $gte: from } })
        .sort({ inicio: 1 }).toArray();
      return stored.map(withId);
    } catch {
      return super.listClientAppointments(clienteJid, { from });
    }
  }

  async closeDay(day, motivo = '') {
    await super.closeDay(day, motivo);
    await this.diasFechados.updateOne(
      { _id: `${this.botId || 'principal'}:${day}` },
      { $set: { ...this.scope, dia: day, motivo } },
      { upsert: true }
    );
  }

  async openDay(day) {
    const removed = await super.openDay(day);
    const result = await this.diasFechados.deleteOne({ _id: `${this.botId || 'principal'}:${day}` });
    return result.deletedCount > 0 || removed;
  }

  async listClosedDays(fromDay = '') {
    try {
      const stored = await this.diasFechados.find({ ...this.scope, dia: { $gte: fromDay } }).sort({ dia: 1 }).toArray();
      return stored.map(({ dia, motivo }) => ({ dia, motivo }));
    } catch {
      return super.listClosedDays(fromDay);
    }
  }

  async incrementUsage(day, changes) {
    await super.incrementUsage(day, changes);
    await this.usoApi.updateOne({ _id: day }, { $inc: changes }, { upsert: true });
  }

  async getUsage(days) {
    try {
      const entries = await this.usoApi.find({ _id: { $in: days } }).toArray();
      return Object.fromEntries(entries.map(({ _id, ...usage }) => [_id, usage]));
    } catch {
      return super.getUsage(days);
    }
  }

  async loadStats() {
    try {
      return await this.estatisticas.findOne({ _id: 'geral' });
    } catch {
      return null;
    }
  }

  async saveStats({ totalMessages, users }) {
    await this.estatisticas.updateOne(
      { _id: 'geral' },
      { $set: { totalMessages, users, atualizadoEm: new Date() } },
      { upsert: true }
    );
  }

  forBot(botId) {
    const storage = new MongoStorage(this.client, this.dbName, botId);
    storage.close = async () => {};
    return storage;
  }

  // Dados gravados antes do suporte a vários números passam a pertencer ao primeiro número.
  async adoptUntaggedData(botId) {
    await Promise.all([this.conversas, this.usuarios, this.lembretes].map((collection) =>
      collection.updateMany({ botId: { $exists: false } }, { $set: { botId } })));
  }

  async close() {
    await this.client.close();
  }
}

export async function createStorage(mongoUri, logger = console, dbName) {
  if (!mongoUri) return new MemoryStorage();
  const client = new MongoClient(mongoUri);
  try {
    await client.connect();
    const storage = new MongoStorage(client, dbName);
    await storage.ensureIndexes().catch((error) =>
      logger.warn({ err: error }, 'Não foi possível criar os índices da agenda no MongoDB'));
    return storage;
  } catch (error) {
    await client.close().catch(() => {});
    logger.warn({ err: error }, 'MongoDB indisponível; usando armazenamento em memória');
    return new MemoryStorage();
  }
}
