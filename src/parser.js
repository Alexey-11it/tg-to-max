import fs from 'node:fs/promises';
import path from 'node:path';

const SUPPORTED_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.tiff', '.bmp', '.heic']);
const SUPPORTED_VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.webm']);
const SUPPORTED_AUDIO_EXTS = new Set(['.mp3', '.m4a', '.ogg', '.wav', '.aac', '.flac']);

const MAX_ALBUM_SIZE = 10; // Максимум элементов в одном альбоме Telegram (MAX принимает до 12)
const ALBUM_GAP_SEC = 2;   // Максимальный разрыв в секундах между соседними файлами альбома

function isTelegramPlaceholder(value) {
  return typeof value === 'string' && value.startsWith('(') && value.endsWith(')');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

export function formatTelegramHtml(textField) {
  if (!textField) return '';
  if (typeof textField === 'string') return escapeHtml(textField);

  if (Array.isArray(textField)) {
    return textField
      .map((part) => {
        if (typeof part === 'string') return escapeHtml(part);
        const safeText = escapeHtml(part.text || '');

        switch (part.type) {
          case 'bold':
            return `<b>${safeText}</b>`;
          case 'italic':
            return `<i>${safeText}</i>`;
          case 'strikethrough':
            return `<s>${safeText}</s>`;
          case 'underline':
            return `<u>${safeText}</u>`;
          case 'code':
            return `<code>${safeText}</code>`;
          case 'pre':
            return `<pre>${safeText}</pre>`;
          case 'text_link':
            return part.href ? `<a href="${escapeAttr(part.href)}">${safeText}</a>` : safeText;
          case 'blockquote':
            return `<i>${safeText
              .split('\n')
              .map((l) => `&gt; ${l}`)
              .join('\n')}</i>`;
          default:
            return safeText;
        }
      })
      .join('');
  }

  return '';
}

function resolveMedia(msg, archiveDir) {
  if (msg.media_type === 'sticker') {
    return { mediaPath: null, maxMediaType: null, isAlbumCandidate: false };
  }

  if (msg.photo) {
    if (isTelegramPlaceholder(msg.photo)) {
      return {
        mediaPath: null,
        maxMediaType: null,
        notExportedReason: msg.photo,
        isAlbumCandidate: true,
      };
    }
    const fullPath = path.join(archiveDir, msg.photo);
    const ext = path.extname(fullPath).toLowerCase();
    const type = SUPPORTED_IMAGE_EXTS.has(ext) ? 'image' : 'file';
    return {
      mediaPath: fullPath,
      maxMediaType: type,
      isAlbumCandidate: type === 'image',
    };
  }

  if (msg.file) {
    const isVideoLike =
      msg.media_type === 'video_file' ||
      msg.media_type === 'video_message';

    if (isTelegramPlaceholder(msg.file)) {
      return {
        mediaPath: null,
        maxMediaType: null,
        notExportedReason: msg.file,
        isAlbumCandidate: isVideoLike,
      };
    }

    const fullPath = path.join(archiveDir, msg.file);
    const ext = path.extname(fullPath).toLowerCase();

    if (isVideoLike || (msg.media_type === 'animation' && SUPPORTED_VIDEO_EXTS.has(ext))) {
      const type = SUPPORTED_VIDEO_EXTS.has(ext) ? 'video' : 'file';
      return {
        mediaPath: fullPath,
        maxMediaType: type,
        isAlbumCandidate: type === 'video',
      };
    }

    if (msg.media_type === 'animation' && ext === '.gif') {
      return { mediaPath: fullPath, maxMediaType: 'image', isAlbumCandidate: true };
    }

    if (msg.media_type === 'audio_file' || msg.media_type === 'voice_message') {
      return {
        mediaPath: fullPath,
        maxMediaType: SUPPORTED_AUDIO_EXTS.has(ext) ? 'audio' : 'file',
        isAlbumCandidate: false,
      };
    }

    return { mediaPath: fullPath, maxMediaType: 'file', isAlbumCandidate: false };
  }

  return { mediaPath: null, maxMediaType: null, isAlbumCandidate: false };
}

function groupMessagesIntoPosts(items) {
  const posts = [];
  let current = null;

  for (const item of items) {
    const canMerge =
      current &&
      !current.closed &&
      current.isAlbumGroup &&
      item.isAlbumCandidate &&
      current.ids.length < MAX_ALBUM_SIZE &&
      Math.abs(item.ts - current.lastTs) <= ALBUM_GAP_SEC &&
      !(current.htmlText && item.htmlText); // у двух разных постов оба имеют текст

    if (canMerge) {
      current.ids.push(item.id);
      current.endId = item.id;
      current.lastTs = item.ts;

      if (item.mediaPath && item.maxMediaType) {
        current.media.push({
          tgId: item.id,
          path: item.mediaPath,
          type: item.maxMediaType,
        });
      }
      if (item.notExportedReason) {
        current.notExported.push({ tgId: item.id, reason: item.notExportedReason });
      }
      if (item.htmlText) {
        current.htmlText = item.htmlText;
        // Подпись пришла на последнем фото альбома (как у ID=25) — закрываем альбом
        current.closed = true;
      }
    } else {
      if (current) posts.push(current);
      current = {
        startId: item.id,
        endId: item.id,
        ids: [item.id],
        date: item.date,
        ts: item.ts,
        lastTs: item.ts,
        htmlText: item.htmlText,
        media:
          item.mediaPath && item.maxMediaType
            ? [{ tgId: item.id, path: item.mediaPath, type: item.maxMediaType }]
            : [],
        notExported: item.notExportedReason
          ? [{ tgId: item.id, reason: item.notExportedReason }]
          : [],
        isAlbumGroup: item.isAlbumCandidate,
        closed: false,
      };
    }
  }

  if (current) posts.push(current);
  return posts;
}

export async function loadArchivePosts(archiveDir) {
  const resultJsonPath = path.join(archiveDir, 'result.json');

  try {
    await fs.access(resultJsonPath);
  } catch {
    throw new Error(
      `Файл result.json не найден по пути: ${resultJsonPath}\n` +
        `Проверьте ARCHIVE_DIR в .env (нужно указать папку, внутри которой лежит result.json).`
    );
  }

  const raw = await fs.readFile(resultJsonPath, 'utf-8');
  const data = JSON.parse(raw);

  if (!Array.isArray(data.messages)) {
    throw new Error('Некорректный формат result.json: отсутствует массив messages.');
  }

  const items = data.messages
    .filter((msg) => msg.type === 'message')
    .sort((a, b) => a.id - b.id)
    .map((msg) => {
      const media = resolveMedia(msg, archiveDir);
      return {
        id: msg.id,
        date: msg.date,
        ts: Number(msg.date_unixtime || Math.floor(new Date(msg.date).getTime() / 1000)),
        htmlText: formatTelegramHtml(msg.text).trim(),
        mediaPath: media.mediaPath || null,
        maxMediaType: media.maxMediaType || null,
        notExportedReason: media.notExportedReason || null,
        isAlbumCandidate: media.isAlbumCandidate,
      };
    });

  return {
    rawMessageCount: items.length,
    posts: groupMessagesIntoPosts(items),
  };
}