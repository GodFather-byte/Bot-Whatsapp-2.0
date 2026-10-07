import { MongoClient } from 'mongodb';
import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';

/**
 * Auth state para o Baileys que guarda a sessão do WhatsApp no MongoDB
 * em vez do disco local (que é apagado sempre que o Render reinicia o container).
 *
 * Uso:
 *   const { state, saveCreds } = await useMongoDBAuthState(process.env.MONGODB_URI);
 *
 * Com `migrateFrom` e `phoneNumber`, uma sessão antiga guardada em `migrateFrom`
 * é movida para `collectionName` quando pertence a esse número.
 */
export function sessionPhoneNumber(creds) {
  return creds?.me?.id?.split(/[:@]/)[0] || null;
}

export async function useMongoDBAuthState(
  mongoUri,
  dbName = 'whatsapp-gemini-bot',
  collectionName = 'auth_state',
  { migrateFrom, phoneNumber } = {}
) {
  const client = new MongoClient(mongoUri);
  try {
    await client.connect();
  } catch (erro) {
    await client.close().catch(() => {});
    throw new Error(`Falha ao conectar no MongoDB (verifique MONGODB_URI): ${erro.message}`);
  }

  const database = client.db(dbName);
  const collection = database.collection(collectionName);

  if (migrateFrom && phoneNumber && !(await collection.findOne({ _id: 'creds' }))) {
    const legacy = database.collection(migrateFrom);
    const legacyCreds = await legacy.findOne({ _id: 'creds' });
    if (legacyCreds?.value && sessionPhoneNumber(JSON.parse(legacyCreds.value)) === phoneNumber) {
      await legacy.rename(collectionName, { dropTarget: true });
    }
  }

  const readData = async (id) => {
    const doc = await collection.findOne({ _id: id });
    if (!doc?.value) return null;
    try {
      return JSON.parse(doc.value, BufferJSON.reviver);
    } catch (erro) {
      console.error(`⚠️ Documento de sessão corrompido para "${id}", ignorando:`, erro.message);
      return null;
    }
  };

  const writeData = async (id, data) => {
    const value = JSON.stringify(data, BufferJSON.replacer);
    await collection.updateOne({ _id: id }, { $set: { value } }, { upsert: true });
  };

  const removeData = async (id) => {
    await collection.deleteOne({ _id: id });
  };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(key, value) : removeData(key));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: async () => {
      await writeData('creds', creds);
    },
    // Apaga a sessão (creds + chaves) quando o WhatsApp a invalida, para permitir novo pareamento.
    clear: async () => {
      await collection.deleteMany({});
    },
    // Permite fechar a conexão com o MongoDB de forma limpa ao encerrar o processo.
    close: async () => {
      await client.close();
    }
  };
}
