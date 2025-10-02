require('dotenv').config();
const { Collection } = require('discord.js');
const { createClient } = require('./config/discord');
const express = require('express');
const fs = require('fs');
const path = require('path');
const logger = require('./utils/logger');
const { authenticateWebhook } = require('./middleware/authMiddleware');
const { handleNotifyBot } = require('./webhooks/notifyBot');

const client = createClient();
client.commands = new Collection();

const commandFolders = ['commands', 'commands/admin'];
for (const folder of commandFolders) {
  const commandFiles = fs.readdirSync(`./${folder}`).filter(file => file.endsWith('.js'));
  
  for (const file of commandFiles) {
    const command = require(`./${folder}/${file}`);
    if (command.data && command.execute) {
      client.commands.set(command.data.name, command);
      logger.info(`Loaded command: ${command.data.name}`);
    }
  }
}

const eventFiles = fs.readdirSync('./events').filter(file => file.endsWith('.js'));
for (const file of eventFiles) {
  const event = require(`./events/${file}`);
  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args));
  } else {
    client.on(event.name, (...args) => event.execute(...args));
  }
  logger.info(`Loaded event: ${event.name}`);
}

const app = express();
app.use(express.json());

app.post('/notify-bot', authenticateWebhook, async (req, res) => {
  await handleNotifyBot(req, res, client);
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    uptime: process.uptime(),
    bot_status: client.isReady() ? 'ready' : 'not_ready'
  });
});

app.get('/metrics', (req, res) => {
  try {
    const queries = require('./database/queries');
    
    const totalUsers = queries.getAllUsers ? queries.getAllUsers.all().length : 0;
    const activeServers = queries.getAllActiveServers ? queries.getAllActiveServers.all().length : 0;
    const queueSize = queries.getQueueSize ? queries.getQueueSize.get() : { count: 0 };
    const stats = queries.getBotStats ? queries.getBotStats.get() : {};
    
    res.json({
      timestamp: new Date().toISOString(),
      uptime_seconds: process.uptime(),
      memory_usage_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      bot: {
        status: client.isReady() ? 'online' : 'offline',
        guilds: client.guilds.cache.size,
        users: totalUsers,
        commands_loaded: client.commands.size
      },
      servers: {
        active: activeServers,
        queue_size: queueSize.count || 0,
        max_concurrent: parseInt(process.env.MAX_CONCURRENT_SERVERS) || 6
      },
      economy: {
        total_coins_earned: stats.total_earned || 0,
        total_coins_spent: stats.total_spent || 0,
        total_transactions: stats.transaction_count || 0
      },
      system: {
        node_version: process.version,
        platform: process.platform,
        env: process.env.NODE_ENV || 'production'
      }
    });
  } catch (error) {
    logger.error('Metrics endpoint error:', error);
    res.status(500).json({ error: 'Failed to fetch metrics' });
  }
});

const PORT = process.env.WEBHOOK_PORT || 3001;
app.listen(PORT, () => {
  logger.info(`🌐 Webhook server listening on port ${PORT}`);
});

client.login(process.env.DISCORD_BOT_TOKEN)
  .then(() => {
    logger.info('🔐 Discord bot login successful');
    
    const { startMonitoring } = require('./services/serverMonitorService');
    startMonitoring(client);

    const { startCleanupService } = require('./services/codeCleanupService');
    startCleanupService();
  })
  .catch(error => {
    logger.error('Failed to login to Discord:', error);
    process.exit(1);
  });

process.on('unhandledRejection', error => {
  logger.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', error => {
  logger.error('Uncaught exception:', error);
  process.exit(1);
});
