import express from 'express';

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return `${days}d ${hours}h ${minutes}m`;
}

export function createDashboardRouter({ config, stats, startedAt, getConnectionStatus }) {
  const router = express.Router();
  router.get('/dashboard', (req, res) => {
    if (!config.dashboardAuthToken) return res.status(503).json({ error: 'Dashboard sem token de autenticação configurado.' });
    const expectedAuthorization = 'Bearer ' + config.dashboardAuthToken;
    if (req.get('authorization') !== expectedAuthorization) {
      return res.status(401).json({ error: 'Não autorizado.' });
    }

    const since = Date.now() - 86_400_000;
    const connection = getConnectionStatus();
    res.json({
      status: 'online',
      uptime: formatUptime(Math.floor((Date.now() - startedAt) / 1000)),
      whatsappConnected: connection.whatsappConnected,
      mongoConnected: connection.mongoConnected,
      bots: connection.bots,
      totalMensagensProcessadas: stats.totalMessages,
      usuariosUnicos: stats.users.size,
      errosÚltimas24h: stats.errorEvents.filter((timestamp) => timestamp.getTime() >= since).length,
      rateLimitsÚltimas24h: stats.rateLimitEvents.filter((timestamp) => timestamp.getTime() >= since).length,
      geminiModel: config.geminiModel,
      últimasMensagensProcessadas: stats.recentMessages
    });
  });
  return router;
}
