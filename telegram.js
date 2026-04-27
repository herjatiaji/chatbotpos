import TelegramBot from 'node-telegram-bot-api';
import 'dotenv/config';

// Ambil Token Telegram dari file .env
const token = process.env.TELEGRAM_TOKEN;
if (!token) {
    console.error("❌ TELEGRAM_TOKEN tidak ditemukan di .env");
    process.exit(1);
}

// Inisialisasi Bot Telegram dengan mode polling
const bot = new TelegramBot(token, { polling: true });
const SERVER_URL = `http://127.0.0.1:${process.env.PORT || 3000}`;

console.log(`
🤖 Telegram Bot Klien: AKTIF!
🔗 Terhubung ke Server AI: ${SERVER_URL}
`);

bot.on('message', async (msg) => {
    const chatId = msg.chat.id.toString(); // Gunakan Chat ID sebagai pengganti Nomor HP
    const messageText = msg.text;

    if (!messageText) return;

    console.log(`\n📨 [Telegram] Menerima pesan dari ID ${chatId}: "${messageText}"`);

    // Tampilkan status "Sedang mengetik..." di aplikasi Telegram user
    bot.sendChatAction(chatId, 'typing');

    try {
        // Tembak API lokal server.js kita sendiri
        const response = await fetch(`${SERVER_URL}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                message: messageText, 
                phone: chatId // Kita samarkan chatId sebagai "phone" agar diterima server.js
            })
        });

        const data = await response.json();

        // Jika server.js menolak (karena ID belum terdaftar di database)
        if (response.status === 403) {
            return bot.sendMessage(
                chatId, 
                `⚠️ *Akses Ditolak*\n\nMaaf, ID Telegram Anda (\`${chatId}\`) belum terdaftar di sistem. Harap hubungi Admin untuk mendaftarkan ID ini.`,
                { parse_mode: 'Markdown' }
            );
        }

        // Jika server sibuk / rate limit
        if (response.status === 429) {
            return bot.sendMessage(chatId, "⏳ Tunggu sebentar Owner, permintaan sedang padat.");
        }

        // Jika sukses, kirim jawaban dari AI (server.js) kembali ke Telegram
        if (data.success && data.answer) {
            bot.sendMessage(chatId, data.answer);
        } else {
            bot.sendMessage(chatId, "⚠️ Maaf, AI tidak memberikan respons yang valid.");
        }

    } catch (error) {
        console.error("❌ Error Telegram to Server:", error.message);
        bot.sendMessage(chatId, "🔌 Waduh, sepertinya `server.js` sedang mati atau tidak bisa dihubungi. Pastikan server utamanya sudah jalan ya, Owner!");
    }
});