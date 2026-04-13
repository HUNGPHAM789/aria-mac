import { Telegraf } from 'telegraf';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set in .env.local');

export const bot = new Telegraf(token);

const allowedId = process.env.ARIA_ALLOWED_TELEGRAM_ID
  ? parseInt(process.env.ARIA_ALLOWED_TELEGRAM_ID, 10)
  : null;

if (!allowedId) {
  console.warn('[ARIA] WARNING: ARIA_ALLOWED_TELEGRAM_ID not set — bot is open to anyone!');
}

const TRUSTED_BOT_IDS = [
  8724988624, // Jarvis
];

bot.use((ctx, next) => {
  if (!allowedId) return next();
  const userId = ctx.from?.id;
  const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
  if (userId === allowedId) return next();
  if (isGroup && userId && TRUSTED_BOT_IDS.includes(userId)) return next();
  if (!isGroup) {
    ctx.reply('Access denied.').catch(() => {});
  }
  return;
});
