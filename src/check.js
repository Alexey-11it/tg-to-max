import { MaxClient } from './maxClient.js';

const SEND_TEST = process.argv.includes('--send-test');
const token = process.env.MAX_BOT_TOKEN;
const channelId = process.env.MAX_CHANNEL_ID;
const baseUrl = process.env.MAX_API_BASE_URL || 'https://platform-api2.max.ru';

async function run() {
  const max = new MaxClient({
    token,
    channelId: channelId || 'not_set',
    baseUrl,
  });

  console.log('1. Проверяю сертификат и токен (GET /me)...');
  const me = await max.getMe();
  console.log('✅ Успешно! Бот:', me.first_name || me.name, `(@${me.username || '-'})`);

  console.log('\n2. Ищу последние события (GET /updates), чтобы показать chat_id каналов...');
  const updatesRes = await max.apiRequest('/updates?timeout=5', { method: 'GET' });
  const updates = updatesRes?.updates || [];

  if (updates.length === 0) {
    console.log(
      '   Событий пока нет. Если нужно узнать ID канала: добавьте бота администратором в канал (или удалите и добавьте снова) и запустите эту команду повторно.'
    );
  } else {
    const found = new Map();
    for (const u of updates) {
      const id = u.chat_id ?? u.message?.recipient?.chat_id;
      if (id !== undefined && id !== null) {
        found.set(String(id), `${u.update_type}${u.is_channel ? ' (канал)' : ''}`);
      }
    }
    console.log('   Найденные chat_id в событиях:');
    for (const [id, info] of found.entries()) {
      console.log(`   👉 chat_id: ${id}  [${info}]`);
    }
  }

  if (SEND_TEST) {
    if (!channelId || channelId.includes('paste_')) {
      console.log('\n❌ Для --send-test сначала впишите реальный MAX_CHANNEL_ID в файл .env');
      process.exit(1);
    }
    console.log(`\n3. Отправляю тестовый пост в канал ${channelId}...`);
    await max.sendPost({
      text: '<b>Тест связи пройден!</b>\nБот успешно подключился к API MAX и готов к переносу архива.',
    });
    console.log('✅ Тестовый пост отправлен! Проверьте канал в MAX.');
  }
}

run().catch((err) => {
  console.error('\n❌ Ошибка:', err.message);
  process.exit(1);
});