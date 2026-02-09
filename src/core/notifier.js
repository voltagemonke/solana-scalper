/**
 * Notifier
 * Sends alerts to Stefan via Telegram
 */

import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.join(__dirname, '../../logs/notifications.log');

// Telegram config from env
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '1287172712';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const ICONS = {
  trade: '📊',
  profit: '💰',
  loss: '🔴',
  risk: '⚠️',
  emergency: '🚨',
  info: 'ℹ️',
  start: '🚀',
  stop: '🛑',
  chain: '🔄',
  error: '❌'
};

/**
 * Escape special chars for Telegram Markdown
 */
function escapeMarkdown(text) {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

/**
 * Send a message directly to Telegram
 */
export async function send(message, options = {}) {
  if (!BOT_TOKEN) {
    console.log('[Notifier] No TELEGRAM_BOT_TOKEN set, logging only');
    console.log(message);
    return;
  }
  
  try {
    // Try with Markdown first, fall back to plain text
    const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: message,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        ...options
      }),
      timeout: 10000
    });
    
    const result = await response.json();
    
    if (!result.ok) {
      // Retry without parse_mode if markdown failed
      if (result.description?.includes("parse entities")) {
        const retryResponse = await fetch(`${TELEGRAM_API}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: CHAT_ID,
            text: message,
            disable_web_page_preview: true
          }),
          timeout: 10000
        });
        const retryResult = await retryResponse.json();
        if (!retryResult.ok) {
          console.error('[Notifier] Telegram retry error:', retryResult.description);
        }
        return;
      }
      console.error('[Notifier] Telegram error:', result.description);
    }
    
    return result;
  } catch (error) {
    console.error('[Notifier] Send failed:', error.message);
  }
  
  // Also log locally
  await logNotification({ message, timestamp: new Date().toISOString() });
}

export async function notify(type, message, data = {}) {
  const notification = {
    type,
    message,
    data,
    timestamp: new Date().toISOString()
  };
  
  // Log locally
  await logNotification(notification);
  
  // Format message
  const icon = ICONS[type] || 'ℹ️';
  const formattedMessage = formatMessage(icon, message, data);
  
  // Send to Telegram
  await send(formattedMessage);
}

function formatMessage(icon, message, data) {
  let text = `${icon} *APEX* | ${message}`;
  
  if (data.chain) {
    text += `\n🔗 Chain: ${data.chain}`;
  }
  
  if (data.token) {
    text += `\n🪙 Token: ${data.token}`;
  }
  
  if (data.action) {
    text += `\n📍 Action: ${data.action}`;
  }
  
  if (data.price) {
    text += `\n💵 Price: $${typeof data.price === 'number' ? data.price.toFixed(6) : data.price}`;
  }
  
  if (data.size) {
    text += `\n📦 Size: $${data.size.toFixed(2)}`;
  }
  
  if (data.pnl !== undefined) {
    const pnlIcon = data.pnl >= 0 ? '📈' : '📉';
    text += `\n${pnlIcon} P&L: ${data.pnl >= 0 ? '+' : ''}${data.pnl.toFixed(2)}%`;
  }
  
  if (data.pnlUsd !== undefined) {
    text += ` ($${data.pnlUsd >= 0 ? '+' : ''}${data.pnlUsd.toFixed(2)})`;
  }
  
  if (data.txHash) {
    text += `\n🔗 TX: \`${data.txHash.slice(0, 10)}...\``;
  }
  
  if (data.reason) {
    text += `\n📝 ${data.reason}`;
  }
  
  return text;
}

async function logNotification(notification) {
  try {
    await fs.mkdir(path.dirname(LOG_PATH), { recursive: true });
    const line = JSON.stringify(notification) + '\n';
    await fs.appendFile(LOG_PATH, line);
  } catch (error) {
    console.error('Failed to log notification:', error);
  }
}

// Convenience methods
export const tradeExecuted = (data) => notify('trade', 'Trade Executed', data);
export const profitLocked = (data) => notify('profit', 'Profit Locked! 🎉', data);
export const lossRealized = (data) => notify('loss', 'Loss Realized', data);
export const riskAlert = (msg) => notify('risk', typeof msg === 'string' ? msg : 'Risk Alert', msg);
export const error = (msg) => notify('error', typeof msg === 'string' ? msg : 'Error', msg);
export const emergencyStop = (data) => notify('emergency', 'EMERGENCY STOP', data);
export const systemStart = (data) => notify('start', 'System Started', data);
export const systemStop = (data) => notify('stop', 'System Stopped', data);
export const chainSwitch = (data) => notify('chain', 'Chain Rotation', data);

export default {
  send,
  notify,
  tradeExecuted,
  profitLocked,
  lossRealized,
  riskAlert,
  error,
  emergencyStop,
  systemStart,
  systemStop,
  chainSwitch
};
