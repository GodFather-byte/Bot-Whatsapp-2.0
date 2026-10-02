import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { MongoClient } from 'mongodb';
import { MemoryStorage, MongoStorage } from '../src/services/storage.js';

const mongoUri = process.env.MONGODB_TEST_URI;
const skipMongo = mongoUri ? false : 'defina MONGODB_TEST_URI para testar com MongoDB';

const MARIA = '5511911111111@s.whatsapp.net';
const ANA = '5511922222222@s.whatsapp.net';
const at = (iso) => new Date(iso);
const appointment = (id, inicio, extra = {}) => ({
  id,
  clienteJid: MARIA,
  clienteNome: 'Maria',
  protocolo: 'Protocolo Prata',
  duracaoMin: 30,
  valor: 100,
  inicio: at(inicio),
  fim: new Date(at(inicio).getTime() + 30 * 60_000),
  lembreteIds: [],
  ...extra
});

// Coleção mínima que imita o que o MongoStorage usa: índice único parcial, filtros e findOneAndUpdate.
const same = (left, right) => (left instanceof Date && right instanceof Date ? left.getTime() === right.getTime() : left === right);

function matches(doc, filter) {
  return Object.entries(filter).every(([key, condition]) => {
    const value = doc[key];
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      return Object.entries(condition).every(([operator, operand]) => ({
        $gte: () => value >= operand,
        $lt: () => value < operand
      })[operator]());
    }
    return same(value, condition);
  });
}

class FakeCollection {
  constructor() {
    this.docs = [];
    this.uniqueIndexes = [];
    this.broken = false;
  }

  guard() {
    if (this.broken) throw new Error('MongoDB fora do ar');
  }

  async createIndex(keys, options = {}) {
    if (options.unique) this.uniqueIndexes.push({ keys: Object.keys(keys), partial: options.partialFilterExpression });
  }

  async insertOne(doc) {
    this.guard();
    const duplicate = () => Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    if (this.docs.some((stored) => stored._id === doc._id)) throw duplicate();
    for (const { keys, partial } of this.uniqueIndexes) {
      if (partial && !matches(doc, partial)) continue;
      const clash = this.docs.some((stored) => (!partial || matches(stored, partial)) && keys.every((key) => same(stored[key], doc[key])));
      if (clash) throw duplicate();
    }
    this.docs.push(structuredClone(doc));
  }

  async findOne(filter) {
    this.guard();
    const found = this.docs.find((doc) => matches(doc, filter));
    return found ? structuredClone(found) : null;
  }

  find(filter) {
    this.guard();
    let found = this.docs.filter((doc) => matches(doc, filter));
    const cursor = {
      sort: (spec) => {
        const [[key, direction]] = Object.entries(spec);
        found = [...found].sort((left, right) => (left[key] > right[key] ? 1 : -1) * direction);
        return cursor;
      },
      toArray: async () => found.map((doc) => structuredClone(doc))
    };
    return cursor;
  }

  async updateOne(filter, update, { upsert = false } = {}) {
    this.guard();
    let doc = this.docs.find((stored) => matches(stored, filter));
    if (!doc && upsert) {
      doc = { ...filter };
      this.docs.push(doc);
    }
    if (doc) Object.assign(doc, update.$set);
  }

  async findOneAndUpdate(filter, update) {
    this.guard();
    const doc = this.docs.find((stored) => matches(stored, filter));
    if (!doc) return null;
    Object.assign(doc, update.$set);
    return structuredClone(doc);
  }

  async deleteOne(filter) {
    this.guard();
    const index = this.docs.findIndex((doc) => matches(doc, filter));
    if (index >= 0) this.docs.splice(index, 1);
    return { deletedCount: index >= 0 ? 1 : 0 };
  }
}

function fakeMongo() {
  const collections = {};
  return {
    collections,
    db: () => ({ collection: (name) => (collections[name] ||= new FakeCollection()) }),
    close: async () => {}
  };
}

async function openBot(client, botId) {
  const storage = new MongoStorage(client, 'teste', botId);
  await storage.ensureIndexes();
  return storage;
}

test('memory storage keeps one confirmed booking per slot and lets a cancelled slot be reused', async () => {
  const storage = new MemoryStorage();
  assert.equal((await storage.createAppointment(appointment('AAAAA', '2026-10-03T13:00:00Z'))).ok, true);
  assert.deepEqual(await storage.createAppointment(appointment('BBBBB', '2026-10-03T13:00:00Z', { clienteJid: ANA })), { ok: false, motivo: 'ocupado' });
  assert.equal((await storage.createAppointment(appointment('CCCCC', '2026-10-03T13:30:00Z'))).ok, true);

  const cancelled = await storage.cancelAppointment('AAAAA', { por: 'dona', motivo: 'imprevisto' });
  assert.equal(cancelled.status, 'cancelado');
  assert.equal(cancelled.canceladoPor, 'dona');
  assert.equal(cancelled.canceladoMotivo, 'imprevisto');
  assert.equal(await storage.cancelAppointment('AAAAA'), null, 'só cancela o que está confirmado');
  assert.equal(await storage.cancelAppointment('NAOEXISTE'), null);
  assert.equal((await storage.createAppointment(appointment('DDDDD', '2026-10-03T13:00:00Z', { clienteJid: ANA }))).ok, true);

  const range = await storage.listAppointments({ from: at('2026-10-03T00:00:00Z'), to: at('2026-10-03T13:30:00Z') });
  assert.deepEqual(range.map(({ id }) => id), ['DDDDD']);
  assert.deepEqual((await storage.listClientAppointments(MARIA, { from: at('2026-10-01T00:00:00Z') })).map(({ id }) => id), ['CCCCC']);
  assert.deepEqual((await storage.listClientAppointments(MARIA, { from: at('2026-10-04T00:00:00Z') })), []);

  assert.equal((await storage.updateAppointment('CCCCC', { googleEventId: 'g1' })).googleEventId, 'g1');
  assert.equal(await storage.updateAppointment('NAOEXISTE', {}), null);
});

test('memory storage tracks closed days in order', async () => {
  const storage = new MemoryStorage();
  await storage.closeDay('2026-12-25', 'natal');
  await storage.closeDay('2026-10-12');
  assert.deepEqual((await storage.listClosedDays('2026-10-01')).map(({ dia }) => dia), ['2026-10-12', '2026-12-25']);
  assert.deepEqual((await storage.listClosedDays('2026-11-01')).map(({ dia }) => dia), ['2026-12-25']);
  assert.equal(await storage.openDay('2026-10-12'), true);
  assert.equal(await storage.openDay('2026-10-12'), false);
});

test('the MongoDB unique index stops a double booking even after a restart', async () => {
  const client = fakeMongo();
  const beforeRestart = await openBot(client, '5511991361386');
  const afterRestart = await openBot(client, '5511991361386'); // memória vazia, mesmo banco

  assert.equal((await beforeRestart.createAppointment(appointment('AAAAA', '2026-10-03T13:00:00Z'))).ok, true);
  const clash = await afterRestart.createAppointment(appointment('BBBBB', '2026-10-03T13:00:00Z', { clienteJid: ANA }));
  assert.deepEqual(clash, { ok: false, motivo: 'ocupado' });
  assert.equal(afterRestart.appointments.size, 0, 'a reserva recusada não fica na memória');
  assert.equal(client.collections.agendamentos.docs.length, 1);

  // Cancelar a partir do processo que não conhece a reserva funciona e libera o horário.
  const cancelled = await afterRestart.cancelAppointment('AAAAA', { por: 'cliente' });
  assert.equal(cancelled.status, 'cancelado');
  assert.equal(cancelled.id, 'AAAAA');
  assert.equal(await afterRestart.cancelAppointment('AAAAA'), null);
  assert.equal((await afterRestart.createAppointment(appointment('BBBBB', '2026-10-03T13:00:00Z', { clienteJid: ANA }))).ok, true);
});

test('MongoDB bookings are scoped by bot number and listed by time', async () => {
  const client = fakeMongo();
  const botA = await openBot(client, '5511991361386');
  const botB = await openBot(client, '5521888888888');

  await botA.createAppointment(appointment('AAAAA', '2026-10-03T14:00:00Z'));
  await botA.createAppointment(appointment('BBBBB', '2026-10-03T13:00:00Z'));
  await botB.createAppointment(appointment('CCCCC', '2026-10-03T13:00:00Z'));
  await botA.createAppointment(appointment('DDDDD', '2026-10-05T13:00:00Z', { clienteJid: ANA }));

  const day = await botA.listAppointments({ from: at('2026-10-03T00:00:00Z'), to: at('2026-10-04T00:00:00Z') });
  assert.deepEqual(day.map(({ id }) => id), ['BBBBB', 'AAAAA']);
  assert.deepEqual((await botB.listAppointments()).map(({ id }) => id), ['CCCCC']);
  assert.deepEqual((await botA.listClientAppointments(MARIA, { from: at('2026-10-01T00:00:00Z') })).map(({ id }) => id), ['BBBBB', 'AAAAA']);
  assert.equal((await botA.getAppointment('CCCCC'))?.id, undefined, 'não enxerga o agendamento do outro número');
  assert.equal((await botA.getAppointment('AAAAA')).id, 'AAAAA');

  const updated = await botA.updateAppointment('AAAAA', { googleEventId: 'g1' });
  assert.equal(updated.googleEventId, 'g1');
  assert.equal((await botA.getAppointment('AAAAA')).googleEventId, 'g1');
});

test('MongoDB closed days are scoped by bot number', async () => {
  const client = fakeMongo();
  const botA = await openBot(client, 'a');
  const botB = await openBot(client, 'b');
  await botA.closeDay('2026-10-12', 'feriado');
  await botA.closeDay('2026-12-25');
  await botB.closeDay('2026-11-02');

  assert.deepEqual(await botA.listClosedDays('2026-10-01'), [
    { dia: '2026-10-12', motivo: 'feriado' },
    { dia: '2026-12-25', motivo: '' }
  ]);
  assert.deepEqual((await botB.listClosedDays()).map(({ dia }) => dia), ['2026-11-02']);
  assert.equal(await botA.openDay('2026-10-12'), true);
  assert.equal(await botA.openDay('2026-10-12'), false);
  assert.deepEqual((await botA.listClosedDays()).map(({ dia }) => dia), ['2026-12-25']);
});

test('when MongoDB is down, reads fall back to what the process has in memory', async () => {
  const client = fakeMongo();
  const storage = await openBot(client, 'a');
  await storage.createAppointment(appointment('AAAAA', '2026-10-03T13:00:00Z'));
  for (const collection of Object.values(client.collections)) collection.broken = true;

  assert.deepEqual((await storage.listAppointments()).map(({ id }) => id), ['AAAAA']);
  assert.deepEqual((await storage.listClientAppointments(MARIA, { from: at('2026-10-01T00:00:00Z') })).map(({ id }) => id), ['AAAAA']);
  assert.equal((await storage.getAppointment('AAAAA')).id, 'AAAAA');
  assert.equal((await storage.cancelAppointment('AAAAA', { por: 'dona' })).status, 'cancelado');
  assert.deepEqual(await storage.listClosedDays(), []);
});

test('the real MongoDB enforces one confirmed booking per slot', { skip: skipMongo }, async (t) => {
  const client = await new MongoClient(mongoUri).connect();
  const dbName = `teste-${randomUUID()}`;
  t.after(async () => {
    await client.db(dbName).dropDatabase();
    await client.close();
  });

  const root = new MongoStorage(client, dbName);
  await root.ensureIndexes();
  const first = root.forBot('5511991361386');
  const second = root.forBot('5511991361386');

  const results = await Promise.all([
    first.createAppointment(appointment('AAAAA', '2026-10-03T13:00:00Z')),
    second.createAppointment(appointment('BBBBB', '2026-10-03T13:00:00Z', { clienteJid: ANA }))
  ]);
  assert.deepEqual(results.map(({ ok }) => ok).sort(), [false, true]);

  const winner = (await first.listAppointments())[0];
  assert.equal((await first.cancelAppointment(winner.id, { por: 'cliente' })).status, 'cancelado');
  assert.equal((await second.createAppointment(appointment('CCCCC', '2026-10-03T13:00:00Z'))).ok, true);

  await first.closeDay('2026-10-12', 'feriado');
  assert.deepEqual((await first.listClosedDays('2026-10-01')).map(({ dia }) => dia), ['2026-10-12']);
  assert.equal(await first.openDay('2026-10-12'), true);
});
