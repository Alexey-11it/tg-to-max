import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createLogger } from './logger.js';
import { loadArchivePosts } from './parser.js';
import { loadState, saveState } from './state.js';
import { MaxClient } from './maxClient.js';

const MAX_LIMITS_MB = {
  image: 50,
  video: 250,
  audio: 256,
  file: 4096,
};

const { values: args } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    limit: { type: 'string' },
    'from-id': { type: 'string' },
    'to-id': { type: 'string' },
  },
});

const IS_DRY_RUN = args['dry-run'];
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const FROM_ID = args['from-id'] ? Number(args['from-id']) : null;
const TO_ID = args['to-id'] ? Number(args['to-id']) : null;

const ARCHIVE_DIR_RAW = process.env.ARCHIVE_DIR;
const CHANNEL_ID = process.env.MAX_CHANNEL_ID || 'default';
const DELAY_MS = Number(process.env.DELAY_MS || 2000);
const ADD_DATE_FOOTER = process.env.ADD_DATE_FOOTER !== 'false';
const UNTIL_DATE_MS = process.env.UNTIL_DATE ? new Date(process.env.UNTIL_DATE).getTime() : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let stopRequested = false;
process.on('SIGINT', () => {
  if (stopRequested) {
    console.log('\nПринудительный выход.');
    process.exit(1);
  }
  console.log('\nПолучен Ctrl+C. Завершаю текущий пост и сохраняю прогресс...');
  stopRequested = true;
});

async function inspectFile(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return { exists: stat.isFile(), size: stat.size };
  } catch {
    return { exists: false, size: 0 };
  }
}

async function withRetries(fn, attempts, logger) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (err.status === 401 || err.status === 415 || i === attempts) throw err;
      const waitMs = err.retryAfterMs || 3000 * i;
      logger.warn(`Попытка ${i}/${attempts} не удалась (${err.message}). Повтор через ${(waitMs / 1000).toFixed(1)}с...`);
      await sleep(waitMs);
    }
  }
}

function formatDateRu(isoDate) {
  if (!isoDate) return '';
  const [datePart] = isoDate.split('T');
  const [y, m, d] = datePart.split('-');
  return `${d}.${m}.${y}`;
}

function formatPostId(post) {
  return post.startId === post.endId ? `${post.startId}` : `${post.startId}..${post.endId}`;
}

function formatMediaSummary(mediaItems) {
  if (!mediaItems.length) return '';
  const byType = {};
  for (const m of mediaItems) {
    byType[m.type] = (byType[m.type] || 0) + 1;
  }
  return ' [' + Object.entries(byType).map(([t, c]) => (c > 1 ? `${c}x ${t}` : t)).join(', ') + ']';
}

async function main() {
  if (!ARCHIVE_DIR_RAW) {
    console.error('Ошибка: не задан ARCHIVE_DIR в файле .env');
    process.exit(1);
  }

  const archiveDir = path.resolve(ARCHIVE_DIR_RAW);
  const channelKey = String(CHANNEL_ID).replace(/[^a-zA-Z0-9_-]/g, '_');
  const workDir = path.join(archiveDir, '_max_import', `channel_${channelKey}`);
  const statePath = path.join(workDir, 'state.json');

  const logger = createLogger(workDir);

  try {
    logger.info(`=== Старт (${IS_DRY_RUN ? 'DRY-RUN / ПРОВЕРКА' : 'БОЕВОЙ РЕЖИМ'}) ===`);
    logger.info(`Архив: ${archiveDir}`);
    logger.info(`Логи и прогресс: ${workDir}`);

    const { rawMessageCount, posts: allPosts } = await loadArchivePosts(archiveDir);
    const state = await loadState(statePath);

    let queue = allPosts.filter((post) => {
      if (FROM_ID !== null) {
        if (post.endId < FROM_ID) return false;
      } else {
        if (post.endId <= state.lastProcessedId) return false;
      }
      if (TO_ID !== null && post.startId > TO_ID) return false;
      if (UNTIL_DATE_MS && new Date(post.date).getTime() >= UNTIL_DATE_MS) return false;
      return true;
    });

    const totalRemaining = queue.length;
    if (Number.isFinite(LIMIT)) {
      queue = queue.slice(0, LIMIT);
    }

    logger.info(
      `Записей в Telegram: ${rawMessageCount} → сгруппировано в постов: ${allPosts.length} | Осталось (ID > ${state.lastProcessedId}): ${totalRemaining} | В этом запуске: ${queue.length}`
    );

    if (queue.length === 0) {
      logger.info('Нечего отправлять — очередь пуста.');
      return;
    }

    // --- РЕЖИМ ПРОВЕРКИ (--dry-run) ---
    if (IS_DRY_RUN) {
      const counts = { image: 0, video: 0, audio: 0, file: 0 };
      let albumCount = 0;
      let missingFiles = 0;
      let oversizedFiles = 0;
      let notExportedByTg = 0;
      let emptyPosts = 0;
      let longPosts = 0;

      for (const post of queue) {
        if (post.media.length > 1) albumCount++;
        if (post.htmlText.length > 4000) longPosts++;

        for (const ne of post.notExported) {
          notExportedByTg++;
          logger.warn(`TG не выгрузил файл для ID=${ne.tgId}: ${ne.reason}`);
        }

        for (const m of post.media) {
          counts[m.type]++;
          const info = await inspectFile(m.path);
          if (!info.exists) {
            missingFiles++;
            logger.warn(`Файл отсутствует на диске (ID=${m.tgId}): ${m.path}`);
          }
          const limitMB = MAX_LIMITS_MB[m.type] || 50;
          if (info.size > limitMB * 1024 * 1024) {
            oversizedFiles++;
            const mb = (info.size / 1024 / 1024).toFixed(1);
            logger.warn(`Превышен лимит MAX (${limitMB} МБ) для ${m.type} ID=${m.tgId}: ${mb} МБ`);
          }
        }

        if (!post.htmlText && post.media.length === 0) emptyPosts++;
      }

      const estSec = Math.round(
        (queue.length * DELAY_MS) / 1000 +
          counts.image * 0.9 +
          counts.video * 5 +
          counts.audio * 2 +
          counts.file * 2
      );

      logger.info('--- Итоги DRY-RUN ---');
      logger.info(`Постов к отправке: ${queue.length} (из них альбомов: ${albumCount})`);
      logger.info(`Медиа: фото=${counts.image}, видео=${counts.video}, аудио=${counts.audio}, файлы=${counts.file}`);
      logger.info(`Длинных постов (>4000 симв.): ${longPosts}`);
      logger.info(
        `Не выгружено TG: ${notExportedByTg} | Нет на диске: ${missingFiles} | Превышают лимит MAX: ${oversizedFiles} | Пустых: ${emptyPosts}`
      );
      logger.info(`Ориентировочное время: ~${Math.ceil(estSec / 60)} мин (~${(estSec / 3600).toFixed(1)} ч)`);
      logger.info(
        `Следующие 3 поста в очереди: ` +
          queue
            .slice(0, 3)
            .map((p) => `ID=${formatPostId(p)}${formatMediaSummary(p.media)}`)
            .join(' | ')
      );
      return;
    }

    // --- БОЕВОЙ РЕЖИМ ---
    const max = new MaxClient({
      token: process.env.MAX_BOT_TOKEN,
      channelId: process.env.MAX_CHANNEL_ID,
      baseUrl: process.env.MAX_API_BASE_URL,
    });

    const me = await max.getMe();
    logger.info(`Подключено к MAX как бот: ${me?.first_name || me?.name || 'OK'} (@${me?.username || '-'})`);

    for (let i = 0; i < queue.length; i++) {
      if (stopRequested) {
        logger.info('Остановлено пользователем (Ctrl+C).');
        break;
      }

      const post = queue[i];
      const progress = `[${i + 1}/${queue.length}]`;
      const idLabel = formatPostId(post);

      // Записываем пропущенные Telegram файлы в failed.json, но сам пост не теряем
      for (const ne of post.notExported) {
        logger.warn(`${progress} В посте ID=${idLabel} пропущен файл TG ID=${ne.tgId}: ${ne.reason}`);
        logger.recordFailed({ id: ne.tgId, postIds: idLabel, date: post.date, reason: 'tg_not_exported', details: ne.reason });
      }

      // Проверяем файлы медиа перед отправкой
      const validMedia = [];
      for (const m of post.media) {
        const info = await inspectFile(m.path);
        if (!info.exists) {
          logger.warn(`${progress} Файл не найден (ID=${m.tgId}): ${m.path}`);
          logger.recordFailed({ id: m.tgId, postIds: idLabel, date: post.date, reason: 'file_not_found', path: m.path });
          continue;
        }
        const limitMB = MAX_LIMITS_MB[m.type] || 50;
        if (info.size > limitMB * 1024 * 1024) {
          const mb = (info.size / 1024 / 1024).toFixed(1);
          logger.warn(`${progress} Файл ${mb} МБ превышает лимит MAX (${limitMB} МБ), пропуск ID=${m.tgId}`);
          logger.recordFailed({ id: m.tgId, postIds: idLabel, date: post.date, reason: 'file_too_large', sizeMB: mb, type: m.type });
          continue;
        }
        validMedia.push(m);
      }

      if (!post.htmlText && validMedia.length === 0) {
        state.lastProcessedId = post.endId;
        await saveState(statePath, state);
        continue;
      }

      const dateFooter = ADD_DATE_FOOTER ? `📅 ${formatDateRu(post.date)}` : '';
      const finalText = [post.htmlText, dateFooter].filter(Boolean).join('\n\n');

      try {
        await withRetries(
          () =>
            max.sendPost({
              text: finalText,
              mediaItems: validMedia,
              logger,
            }),
          3,
          logger
        );

        state.lastProcessedId = post.endId;
        state.totalSent++;
        await saveState(statePath, state);
        logger.info(`${progress} OK tg_id=${idLabel} (${formatDateRu(post.date)})${formatMediaSummary(validMedia)}`);
      } catch (err) {
        logger.error(`${progress} FAIL tg_id=${idLabel}: ${err.message}`);
        logger.recordFailed({
          id: idLabel,
          date: post.date,
          mediaCount: validMedia.length,
          error: err.message,
        });
        state.lastProcessedId = post.endId;
        state.totalFailed++;
        await saveState(statePath, state);
      }

      if (i < queue.length - 1 && !stopRequested) {
        await sleep(DELAY_MS);
      }
    }

    logger.info(`=== Завершено. Отправлено постов: ${state.totalSent}, ошибок: ${state.totalFailed} ===`);
  } finally {
    await logger.close();
  }
}

main().catch((err) => {
  console.error('Критическая ошибка:', err.message || err);
  process.exit(1);
});