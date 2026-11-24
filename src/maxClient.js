import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_TEXT_LENGTH = 4000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sanitizeFileName(filePath) {
  const base = path.basename(filePath);
  if (base.length <= 180) return base;
  const ext = path.extname(base);
  const name = base.slice(0, 180 - ext.length);
  return `${name}${ext}`;
}

function splitTextChunks(text, maxLen = MAX_TEXT_LENGTH) {
  if (!text) return [''];
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.5) splitAt = remaining.lastIndexOf(' ', maxLen);
    if (splitAt < maxLen * 0.5) splitAt = maxLen;

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export class MaxClient {
  constructor({ token, channelId, baseUrl }) {
    if (!token) throw new Error('Не задан MAX_BOT_TOKEN в .env');
    if (!channelId) throw new Error('Не задан MAX_CHANNEL_ID в .env');

    this.token = token.trim();
    this.channelId = String(channelId).trim();
    this.baseUrl = (baseUrl || 'https://platform-api2.max.ru').replace(/\/$/, '');
  }

  async apiRequest(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    let res;

    try {
      res = await fetch(url, {
        ...options,
        headers: {
          Accept: 'application/json',
          Authorization: this.token,
          ...(options.headers || {}),
        },
      });
    } catch (err) {
      const code = err?.cause?.code || err?.code || '';
      if (code.includes('CERT') || code.includes('TLS') || String(err.cause).includes('certificate')) {
        throw new Error(
          `Ошибка TLS-сертификата (${code}). Запустите скрипт с NODE_EXTRA_CA_CERTS=путь_к_Russian_Trusted_Root_CA.cer`
        );
      }
      throw err;
    }

    if (res.status === 429) {
      const retryAfterSec = Number(res.headers.get('retry-after') || 10);
      const err = new Error(`Rate limit 429 (пауза ${retryAfterSec}с)`);
      err.retryAfterMs = retryAfterSec * 1000;
      throw err;
    }

    const bodyText = await res.text();
    let data = null;
    try {
      data = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      data = bodyText;
    }

    if (!res.ok) {
      const apiCode = data?.code || '';
      const apiMsg = data?.message || bodyText.slice(0, 300);
      const err = new Error(`HTTP ${res.status}${apiCode ? ` [${apiCode}]` : ''}: ${apiMsg}`);
      err.status = res.status;
      err.apiCode = apiCode;
      throw err;
    }

    return data;
  }

  async getMe() {
    return this.apiRequest('/me', { method: 'GET' });
  }

  async uploadMedia(filePath, type) {
    const init = await this.apiRequest(`/uploads?type=${encodeURIComponent(type)}`, {
      method: 'POST',
    });

    if (!init?.url) {
      throw new Error(`POST /uploads?type=${type} не вернул url: ${JSON.stringify(init)}`);
    }

    const buffer = await fs.readFile(filePath);
    const fileName = sanitizeFileName(filePath);
    const formData = new FormData();
    formData.append('data', new Blob([buffer]), fileName);

    const uploadHeaders = {};
    if (type === 'image') {
      uploadHeaders.Authorization = this.token;
    }

    const uploadRes = await fetch(init.url, {
      method: 'POST',
      headers: uploadHeaders,
      body: formData,
    });

    const uploadText = await uploadRes.text();
    if (!uploadRes.ok) {
      throw new Error(`Ошибка загрузки ${type} (HTTP ${uploadRes.status}): ${uploadText.slice(0, 300)}`);
    }

    let uploadJson = null;
    try {
      uploadJson = JSON.parse(uploadText);
    } catch {
      // Для video/audio сервер возвращает <retval>1</retval>
    }

    let mediaToken = null;
    if (type === 'image') {
      const firstPhoto = uploadJson?.photos ? Object.values(uploadJson.photos)[0] : null;
      mediaToken = firstPhoto?.token || uploadJson?.token || init.token || null;
    } else if (type === 'video' || type === 'audio') {
      mediaToken = init.token || uploadJson?.token || null;
    } else {
      mediaToken = uploadJson?.token || init.token || null;
    }

    if (!mediaToken) {
      throw new Error(
        `Не удалось извлечь token после загрузки ${type}. Шаг 1: ${JSON.stringify(init)}; Шаг 2: ${uploadText.slice(0, 200)}`
      );
    }

    return {
      type,
      payload: { token: mediaToken },
    };
  }

  async sendMessageWithProcessingWait(body, logger) {
    const waitDelaysSec = [3, 5, 8, 12, 20, 30];

    for (let attempt = 0; attempt <= waitDelaysSec.length; attempt++) {
      try {
        return await this.apiRequest(`/messages?chat_id=${encodeURIComponent(this.channelId)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (err) {
        const isNotReady =
          err.apiCode === 'attachment.not.ready' ||
          String(err.message).includes('attachment.not.ready');

        if (isNotReady && attempt < waitDelaysSec.length) {
          const waitSec = waitDelaysSec[attempt];
          logger?.warn(`Медиа обрабатывается на сервере MAX (attachment.not.ready). Жду ${waitSec}с...`);
          await sleep(waitSec * 1000);
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Отправка поста с 0..10 медиавложениями (альбом) и текстом
   */
  async sendPost({ text, mediaItems = [], logger }) {
    const attachments = [];
    let hasSlowMedia = false;

    for (const item of mediaItems) {
      const attachment = await this.uploadMedia(item.path, item.type);
      attachments.push(attachment);
      if (item.type !== 'image') hasSlowMedia = true;
    }

    if (attachments.length > 0) {
      await sleep(hasSlowMedia ? 3500 : 1200);
    }

    const chunks = splitTextChunks(text || '');

    const firstBody = {
      text: chunks[0] || null,
      format: 'html',
    };
    if (attachments.length > 0) {
      firstBody.attachments = attachments;
    }

    await this.sendMessageWithProcessingWait(firstBody, logger);

    for (let i = 1; i < chunks.length; i++) {
      await sleep(1000);
      await this.sendMessageWithProcessingWait(
        {
          text: chunks[i],
          format: 'html',
        },
        logger
      );
    }
  }
}