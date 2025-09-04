// /opt/asterisk_to_openai_rt_community/mail.js
// Sends the conversation transcript via email on normal call end.

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { config, logger } = require('./config');

// Build a nodemailer transport based on SMTP_* settings in config.conf
function buildTransport() {
  if (!config.EMAIL_ENABLED) {
    throw new Error('Email sending is disabled (EMAIL_ENABLED=false)');
  }
  if (!config.SMTP_HOST) {
    throw new Error('SMTP_HOST is not set in config.conf');
  }
  return nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: Number(config.SMTP_PORT || 587),
    secure: String(config.SMTP_SECURE || '').toLowerCase() === 'true', // true for SMTPS/465
    auth: (config.SMTP_USER && config.SMTP_PASS) ? {
      user: config.SMTP_USER,
      pass: config.SMTP_PASS
    } : undefined
  });
}

/**
 * Send an email with the attached transcript file.
 * Called from cleanupChannel() so it runs on normal call end (not after queue handoff).
 * @param {Object} p
 * @param {string} p.channelId   - Asterisk channel id
 * @param {string} [p.callerId]  - caller number/name for subject/body
 * @param {string} p.filePath    - absolute path to transcript file
 * @param {string} [p.reason]    - reason for call end, for logging/body
 */
async function sendTranscriptEmail({ channelId, callerId = 'unknown', filePath, reason = '' }) {
  if (!config.EMAIL_ENABLED) {
    logger.debug(`Email disabled; skipping send for ${channelId}`);
    return;
  }

  if (!fs.existsSync(filePath)) {
    logger.warn(`Transcript not found for ${channelId}: ${filePath}`);
    return;
  }

  const to = (config.EMAIL_TO || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!to.length) {
    throw new Error('EMAIL_TO is empty in config.conf');
  }

  // Simple subject/body templating ({{callerId}}, {{channelId}}, {{reason}})
  const subject = (config.EMAIL_SUBJECT_TEMPLATE ||
    'SQS — Conversation transcript {{callerId}} ({{channelId}})')
    .replace('{{callerId}}', callerId)
    .replace('{{channelId}}', channelId);

  const body = (config.EMAIL_BODY_TEMPLATE ||
    'Attached is the conversation transcript.\n\nCaller: {{callerId}}\nChannel: {{channelId}}\nReason: {{reason}}\n')
    .replace('{{callerId}}', callerId)
    .replace('{{channelId}}', channelId)
    .replace('{{reason}}', reason || 'n/a');

  const transporter = buildTransport();
  const info = await transporter.sendMail({
    from: config.EMAIL_FROM || config.SMTP_USER,
    to,
    subject,
    text: body,
    attachments: [
      {
        filename: path.basename(filePath),
        path: filePath,
        contentType: 'text/plain'
      }
    ]
  });

  logger.info(`Email sent for ${channelId} to ${to.join(', ')}; messageId=${info.messageId || 'n/a'}`);
}

module.exports = { sendTranscriptEmail };
