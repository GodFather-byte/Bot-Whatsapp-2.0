import { existsSync } from 'node:fs';
import { readFile, rename } from 'node:fs/promises';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import { sessionPhoneNumber, useMongoDBAuthState } from '../../mongoAuthState.js';

const LEGACY_AUTH_FOLDER = 'auth_info_baileys';
const LEGACY_AUTH_COLLECTION = 'auth_state';

async function useFileAuthState(number) {
  if (!number) return useMultiFileAuthState(LEGACY_AUTH_FOLDER);
  const folder = `${LEGACY_AUTH_FOLDER}_${number}`;
  if (!existsSync(folder) && existsSync(`${LEGACY_AUTH_FOLDER}/creds.json`)) {
    const creds = JSON.parse(await readFile(`${LEGACY_AUTH_FOLDER}/creds.json`, 'utf8'));
    if (sessionPhoneNumber(creds) === number) await rename(LEGACY_AUTH_FOLDER, folder);
  }
  return useMultiFileAuthState(folder);
}

export function createWhatsAppService({
  config,
  bot = { id: 'principal', number: '' },
  logger: baseLogger,
  onMessage,
  onConnectionUpdate = () => {},
  onOpen = () => {}
}) {
  const logger = baseLogger.child?.({ bot: bot.id }) || baseLogger;
  let socket;
  let mongoAuthState;
  let reconnectTimer;
  let reconnectAttempts = 0;
  let stopping = false;
  let connecting = false;

  async function getAuthState() {
    if (config.mongoUri) {
      try {
        logger.info('Usando MongoDB para persistir a sessão do WhatsApp.');
        return await useMongoDBAuthState(
          config.mongoUri,
          config.mongoDbName,
          bot.number ? `${LEGACY_AUTH_COLLECTION}_${bot.number}` : LEGACY_AUTH_COLLECTION,
          { migrateFrom: LEGACY_AUTH_COLLECTION, phoneNumber: bot.number }
        );
      } catch (error) {
        logger.warn({ err: error }, 'MongoDB indisponível para autenticação; usando arquivos locais');
      }
    }
    return useFileAuthState(bot.number);
  }

  async function connect() {
    if (stopping || connecting) return socket;
    connecting = true;
    try {
      const authState = await getAuthState();
      const { state, saveCreds } = authState;

      if (typeof authState.close === 'function') {
        if (mongoAuthState) await mongoAuthState.close().catch(() => {});
        mongoAuthState = authState;
      }

      socket = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['Ubuntu', 'Chrome', '20.0.04']
      });
      socket.ev.on('creds.update', saveCreds);

      if (!state.creds.registered && bot.number) {
        setTimeout(async () => {
          try {
            const code = await socket.requestPairingCode(bot.number);
            const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
            logger.info(`Código de pareamento do WhatsApp ${bot.number}: ${formattedCode}`);
            logger.info('No WhatsApp, escolha Aparelhos conectados > Conectar um aparelho > Vincular com número de telefone.');
          } catch (error) {
            logger.error({ err: error }, 'Erro ao gerar código de pareamento');
          }
        }, 3000).unref?.();
      } else if (!state.creds.registered) {
        logger.warn('Defina NUMEROS_BOT (ou NUMERO_BOT) para gerar o código de pareamento.');
      }

      socket.ev.on('connection.update', (update) => {
        onConnectionUpdate(update);
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
          reconnectAttempts = 0;
          logger.info('WhatsApp conectado.');
          onOpen(socket.user);
        }
        if (connection === 'close') {
          const loggedOut = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
          logger.warn({ loggedOut }, 'Conexão do WhatsApp encerrada');
          if (!loggedOut && !stopping) {
            clearTimeout(reconnectTimer);
            const delay = Math.min(3000 * (2 ** reconnectAttempts), 60000);
            reconnectAttempts += 1;
            logger.info(`Tentando reconectar em ${delay / 1000} segundos...`);
            reconnectTimer = setTimeout(() => {
              connect().catch((error) => logger.error({ err: error }, 'Falha ao reconectar WhatsApp'));
            }, delay);
            reconnectTimer.unref?.();
          }
        }
      });

      socket.ev.on('messages.upsert', async ({ messages = [], type }) => {
        // "append" traz mensagens de sincronização de histórico, que não devem ser respondidas.
        if (type !== 'notify') return;
        for (const message of messages) {
          try {
            await onMessage(socket, message);
          } catch (error) {
            logger.error({ err: error }, 'Erro inesperado no handler de mensagens');
          }
        }
      });
      return socket;
    } finally {
      connecting = false;
    }
  }

  async function close() {
    stopping = true;
    clearTimeout(reconnectTimer);
    socket?.end?.(new Error('Processo encerrado'));
    if (mongoAuthState) await mongoAuthState.close().catch(() => {});
  }

  return {
    connect,
    close,
    getSocket: () => socket,
    isConnected: () => socket?.user != null
  };
}
