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
    return storage;
  } catch (error) {
    await client.close().catch(() => {});
    logger.warn({ err: error }, 'MongoDB indisponível; usando armazenamento em memória');
    return new MemoryStorage();
  }
}
