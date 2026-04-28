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

// 🔥 PERBAIKAN URL: Gunakan localhost atau 0.0.0.0 yang lebih ramah dengan Railway
const port = process.env.PORT || 3000;
const SERVER_URL = `https://chatbotpos-production.up.railway.app`;

console.log(`
🤖 Telegram Bot Klien: AKTIF!
🔗 Terhubung ke Server AI: ${SERVER_URL}
`);

bot.on('message', async (msg) => {
    const chatId = msg.chat.id.toString(); 
    const messageText = msg.text;

    if (!messageText) return;

    console.log(`\n📨 [Telegram] Menerima pesan dari ID ${chatId}: "${messageText}"`);

    bot.sendChatAction(chatId, 'typing');

    try {
        console.log(`   [Telegram] Meneruskan pesan ke ${SERVER_URL}/api/chat...`);
        
        const response = await fetch(`${SERVER_URL}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                message: messageText, 
                phone: chatId 
            })
        });

        // Tangkap jika fetch gagal (misal server belum siap)
        if (!response.ok) {
            console.error(`❌ Server mengembalikan status: ${response.status}`);
        }

        const data = await response.json();

        if (response.status === 403) {
            return bot.sendMessage(
                chatId, 
                `⚠️ *Akses Ditolak*\n\nMaaf, ID Telegram Anda (\`${chatId}\`) belum terdaftar di sistem.`,
                { parse_mode: 'Markdown' }
            );
        }

        if (response.status === 429) {
            return bot.sendMessage(chatId, "⏳ Tunggu sebentar Owner, permintaan sedang padat.");
        }

        if (data.success && data.answer) {
            console.log(`   [Telegram] Sukses menerima jawaban dari AI.`);
            bot.sendMessage(chatId, data.answer);
        } else {
            bot.sendMessage(chatId, "⚠️ Maaf, AI tidak memberikan respons yang valid.");
        }

    } catch (error) {
        // 🔥 Tambahkan log error lengkap di sini agar terlihat di Railway
        console.error("❌ Error Telegram to Server Detail:", error);
        bot.sendMessage(chatId, "🔌 Waduh, sepertinya `server.js` sedang mati atau tidak bisa dihubungi. Cek log server ya, Owner!");
    }
});