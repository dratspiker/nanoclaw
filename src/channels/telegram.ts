import fs from 'fs';
import https from 'https';
import path from 'path';
import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, GROUPS_DIR, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile, readEnvFileByPrefix } from '../env.js';
import { processImage } from '../image.js';
import { logger } from '../logger.js';
import {
  handleBriefing,
  handleCapture,
  handleEnergy,
  handleStatus,
  handleSync,
} from '../commands.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
// Liveness signal for the Docker healthcheck. The grammy poll loop is
// otherwise invisible to the container — `pgrep node` reports healthy even
// when getUpdates has died. We touch this file on every received update and
// after each successful bot.start(); the healthcheck fails if it goes stale.
// See homebase#358.
const POLL_LIVENESS_FILE = '/app/data/telegram-last-poll';
function touchPollLiveness(): void {
  try {
    fs.writeFileSync(POLL_LIVENESS_FILE, String(Date.now()));
  } catch {
    // best-effort; never crash the bot over a liveness write failure
  }
}

async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private defaultBot: Bot | null = null;
  private defaultBotToken: string;
  private opts: TelegramChannelOpts;
  // folder key (uppercase) -> { bot, token }
  private botsByFolder: Map<string, { bot: Bot; token: string }> = new Map();
  // jid -> folder key (uppercase), for routing outbound messages
  private jidToBotFolder: Map<string, string> = new Map();
  // Extra tokens: { FAMILY: "token...", WORK: "token..." }
  private extraTokens: Record<string, string>;

  constructor(
    defaultToken: string,
    extraTokens: Record<string, string>,
    opts: TelegramChannelOpts,
  ) {
    this.defaultBotToken = defaultToken;
    this.extraTokens = extraTokens;
    this.opts = opts;
  }

  /**
   * Set up all message handlers on a Bot instance.
   * Shared between the default bot and extra bots.
   */
  private setupBotHandlers(bot: Bot, botToken: string): void {
    // Liveness: every received update proves getUpdates is alive. See homebase#358.
    bot.use(async (_ctx, next) => {
      touchPollLiveness();
      await next();
    });

    // Liveness: also touch on every poll attempt (idle long-poll returns no
    // updates but still proves the loop is running). API transformer wraps
    // every Telegram API call; we filter for getUpdates only.
    bot.api.config.use(async (prev, method, payload, signal) => {
      if (method === 'getUpdates') touchPollLiveness();
      return prev(method, payload, signal);
    });

    // Command to get chat ID (useful for registration)
    bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // --- Productivity commands (Issue #38) ---

    // Command to trigger personal vault sync
    bot.command('sync', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      if (!this.opts.registeredGroups()[chatJid]) {
        return ctx.reply(
          '⚠️ Access denied. This command is only available in registered groups.',
        );
      }

      await ctx.reply('🔄 Triggering personal sync...');
      const result = await handleSync();
      if (result.success) {
        ctx.reply(
          `✅ Sync triggered successfully:\n\`\`\`\n${result.output}\n\`\`\``,
          { parse_mode: 'Markdown' },
        );
      } else {
        ctx.reply(
          `❌ Sync failed:\n\`\`\`\n${result.error || result.output}\n\`\`\``,
          { parse_mode: 'Markdown' },
        );
      }
    });

    // Command to get daily briefing
    bot.command('briefing', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      if (!this.opts.registeredGroups()[chatJid]) {
        return ctx.reply('⚠️ Access denied.');
      }

      await ctx.reply('📋 Generating your briefing...');
      const result = await handleBriefing();
      if (result.success) {
        ctx.reply(result.output);
      } else {
        ctx.reply(`❌ Briefing failed:\n${result.error || result.output}`);
      }
    });

    // Command for smart capture
    bot.command('capture', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      if (!this.opts.registeredGroups()[chatJid]) {
        return ctx.reply('⚠️ Access denied.');
      }

      const text = ctx.match;
      if (!text) {
        return ctx.reply(
          'Usage: `/capture <item>`\nExample: `/capture buy milk`',
          { parse_mode: 'Markdown' },
        );
      }

      await ctx.reply(`📝 Capturing: "${text}"...`);
      const result = await handleCapture(text);
      if (result.success) {
        ctx.reply(`✅ ${result.output}`);
      } else {
        ctx.reply(`❌ Capture failed:\n${result.error || result.output}`);
      }
    });

    // Command for homelab status check
    bot.command('status', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      if (!this.opts.registeredGroups()[chatJid]) {
        return ctx.reply('⚠️ Access denied.');
      }

      await ctx.reply('🔍 Checking homelab status...');
      const result = await handleStatus();
      if (result.success) {
        ctx.reply(result.output);
      } else {
        ctx.reply(`❌ Status check failed:\n${result.error || result.output}`);
      }
    });

    // Command for energy-aware task suggestions
    bot.command('energy', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      if (!this.opts.registeredGroups()[chatJid]) {
        return ctx.reply('⚠️ Access denied.');
      }

      const level = ctx.match || 'low';
      await ctx.reply(`⚡ Finding ${level} energy tasks...`);
      const result = await handleEnergy(level);
      if (result.success) {
        ctx.reply(result.output, { parse_mode: 'Markdown' });
      } else {
        ctx.reply(
          `❌ Failed to get suggestions:\n${result.error || result.output}`,
        );
      }
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set([
      'chatid',
      'ping',
      'sync',
      'briefing',
      'capture',
      'status',
      'energy',
    ]);

    bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          // Use the group's trigger pattern if available, otherwise fall back to ASSISTANT_NAME
          const group = this.opts.registeredGroups()[chatJid];
          const triggerName =
            group?.trigger?.replace(/^@/, '') || ASSISTANT_NAME;
          content = `@${triggerName} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const caption = ctx.message.caption || '';

      try {
        const photos = ctx.message.photo;
        const largest = photos[photos.length - 1];
        const file = await ctx.api.getFile(largest.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;

        const response = await fetch(fileUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());

        const groupDir = path.join(GROUPS_DIR, group.folder);
        const processed = await processImage(buffer, groupDir, caption);
        if (processed) {
          logger.info(
            { chatJid, path: processed.relativePath, size: buffer.length },
            'Telegram photo processed for vision',
          );
          storeNonText(ctx, processed.content);
        } else {
          storeNonText(
            ctx,
            `[Photo (processing failed)]${caption ? ` ${caption}` : ''}`,
          );
        }
      } catch (err) {
        logger.error({ chatJid, err }, 'Failed to download Telegram photo');
        storeNonText(
          ctx,
          `[Photo (download failed)]${caption ? ` ${caption}` : ''}`,
        );
      }
    });
    bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    bot.on('message:document', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      const name = ctx.message.document?.file_name || 'file';
      if (!group) return;

      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      try {
        const doc = ctx.message.document!;
        const file = await ctx.api.getFile(doc.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
        const filename = `doc_${ctx.message.message_id}_${name}`;

        const docsDir = path.join(GROUPS_DIR, group.folder, 'documents');
        fs.mkdirSync(docsDir, { recursive: true });
        const localPath = path.join(docsDir, filename);

        const response = await fetch(fileUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        fs.writeFileSync(localPath, buffer);

        const containerPath = `/workspace/group/documents/${filename}`;
        logger.info(
          { chatJid, filename, size: buffer.length },
          'Telegram document downloaded',
        );
        storeNonText(ctx, `[Document: ${containerPath}]${caption}`);
      } catch (err) {
        logger.error({ chatJid, err }, 'Failed to download Telegram document');
        storeNonText(ctx, `[Document: ${name} (download failed)]${caption}`);
      }
    });
    bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });
  }

  private createBot(token: string): Bot {
    return new Bot(token, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });
  }

  // Self-restarting bot.start() with exponential backoff. The grammy poll loop
  // dies on unhandled rejections (e.g. transient 409 Conflict from a duplicate
  // getUpdates caller) and never recovers on its own. See homebase#359.
  private startBot(bot: Bot, label: string): Promise<void> {
    return new Promise<void>((resolve) => {
      let attempt = 0;
      let connectedOnce = false;

      const launch = (): void => {
        const startedAt = Date.now();
        bot
          .start({
            onStart: (botInfo) => {
              attempt = 0; // reset backoff on each successful (re)start
              touchPollLiveness();
              logger.info(
                { username: botInfo.username, id: botInfo.id, label },
                'Telegram bot connected',
              );
              if (!connectedOnce) {
                console.log(`  Telegram bot (${label}): @${botInfo.username}`);
                connectedOnce = true;
                resolve();
              }
            },
          })
          .catch((err) => {
            // If the loop ran healthily for >5min before dying, treat it as a
            // fresh failure rather than continuing the previous backoff series.
            const ranFor = Date.now() - startedAt;
            if (ranFor > 5 * 60 * 1000) attempt = 0;

            const delayMs = Math.min(1000 * Math.pow(2, attempt), 60_000);
            attempt += 1;
            logger.error(
              { label, err: (err as Error)?.message, attempt, delayMs, ranForMs: ranFor },
              'Telegram bot.start() failed, scheduling restart',
            );
            setTimeout(launch, delayMs);
          });
      };

      launch();
    });
  }

  async connect(): Promise<void> {
    // Create and set up default bot
    this.defaultBot = this.createBot(this.defaultBotToken);
    this.setupBotHandlers(this.defaultBot, this.defaultBotToken);

    // Create extra bots for per-folder tokens
    for (const [folderKey, token] of Object.entries(this.extraTokens)) {
      const bot = this.createBot(token);
      this.setupBotHandlers(bot, token);
      this.botsByFolder.set(folderKey, { bot, token });
    }

    // Pre-populate JID -> folder mapping from registered groups
    this.refreshJidMapping();

    // Start all bots concurrently
    const startPromises: Promise<void>[] = [
      this.startBot(this.defaultBot, 'default'),
    ];
    for (const [folderKey, entry] of this.botsByFolder) {
      startPromises.push(this.startBot(entry.bot, folderKey.toLowerCase()));
    }

    console.log('');
    await Promise.all(startPromises);
    console.log(`  Send /chatid to any bot to get a chat's registration ID\n`);
  }

  /**
   * Refresh the JID -> folder key mapping from current registered groups.
   * Called at startup and lazily when a JID isn't found.
   */
  private refreshJidMapping(): void {
    const groups = this.opts.registeredGroups();
    for (const [jid, group] of Object.entries(groups)) {
      const key = group.folder.toUpperCase();
      if (this.botsByFolder.has(key)) {
        this.jidToBotFolder.set(jid, key);
      }
    }
  }

  /**
   * Get the Bot instance that should handle a given JID.
   */
  private getBotForJid(jid: string): Bot | null {
    // Check cached mapping
    const folder = this.jidToBotFolder.get(jid);
    if (folder) {
      const entry = this.botsByFolder.get(folder);
      if (entry) return entry.bot;
    }

    // Lazy lookup for groups registered after startup
    const groups = this.opts.registeredGroups();
    const group = groups[jid];
    if (group) {
      const key = group.folder.toUpperCase();
      const entry = this.botsByFolder.get(key);
      if (entry) {
        this.jidToBotFolder.set(jid, key);
        return entry.bot;
      }
    }

    return this.defaultBot;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const bot = this.getBotForJid(jid);
    if (!bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(bot.api, numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.defaultBot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    for (const [folderKey, entry] of this.botsByFolder) {
      try {
        entry.bot.stop();
        logger.info({ folder: folderKey }, 'Telegram extra bot stopped');
      } catch {
        // ignore stop errors during shutdown
      }
    }
    this.botsByFolder.clear();
    this.jidToBotFolder.clear();

    if (this.defaultBot) {
      this.defaultBot.stop();
      this.defaultBot = null;
      logger.info('Telegram default bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return;
    const bot = this.getBotForJid(jid);
    if (!bot) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }

  // Discover additional bot tokens: TELEGRAM_BOT_TOKEN_FAMILY, etc.
  const allExtra = readEnvFileByPrefix('TELEGRAM_BOT_TOKEN_');
  const extraTokens: Record<string, string> = {};
  for (const [key, value] of Object.entries(allExtra)) {
    const suffix = key.replace('TELEGRAM_BOT_TOKEN_', '');
    if (suffix && value) {
      extraTokens[suffix] = value;
    }
  }

  if (Object.keys(extraTokens).length > 0) {
    logger.info(
      { folders: Object.keys(extraTokens) },
      'Telegram: additional bot tokens found',
    );
  }

  return new TelegramChannel(token, extraTokens, opts);
});
