import 'dotenv/config';
import express from 'express';
import sql from './db.js';
import { callGemini } from './aiService.js';
import { sendWhatsAppMessage } from './whatsappService.js';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Webhook Verification (Meta Challenge)
app.get('/webhook', (req, res) => {
    const verify_token = process.env.VERIFY_TOKEN;

    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === verify_token) {
            console.log('WEBHOOK_VERIFIED');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    } else {
        res.status(400).send('Invalid request');
    }
});

// Helper function to process the message asynchronously
async function processMessage(phoneNumber, messageText) {
    try {
        // Stateless User Verification: Check DB for user on every message
        const userCheck = await sql`
            SELECT u.owner_name, u.store_id, s.store_name
            FROM whatsapp_users u
            JOIN stores s ON u.store_id = s.id
            WHERE u.phone_number = ${phoneNumber}
        `;

        if (userCheck.length === 0) {
            console.log(`[AUTH FAILED] Unknown number: ${phoneNumber}`);
            await sendWhatsAppMessage(phoneNumber, "❌ Maaf, nomor Anda tidak terdaftar dalam sistem kami.");
            return;
        }

        const activeUser = userCheck[0];
        console.log(`[AUTH SUCCESS] User: ${activeUser.owner_name}, Store: ${activeUser.store_name}`);

        const SYSTEM_PROMPT = `
Kamu adalah AI Data Analyst operasional Cafe.
Database PostgreSQL memiliki skema ketat berikut (HANYA GUNAKAN KOLOM INI):
1. stores (id, store_name, location)
2. menu_categories (id, store_id, name)
3. menu_items (id, store_id, category_id, name, price)
4. inventory (id, store_id, item_name, unit, current_stock)
5. menu_recipes (id, menu_item_id, inventory_id, qty_used)
6. transactions (id, store_id, receipt_number, order_type, table_number, transaction_date, total_amount, payment_method)
7. transaction_details (id, transaction_id, menu_item_id, qty, subtotal, notes)

ATURAN KEAMANAN & JOIN:
- User adalah owner store_id = ${activeUser.store_id}. WAJIB sertakan filter: transactions.store_id = ${activeUser.store_id} atau inventory.store_id = ${activeUser.store_id} di SETIAP query.
- Gunakan JOIN yang tepat, misalnya: transaction_details.transaction_id = transactions.id

ATURAN OUTPUT (SANGAT PENTING):
1. Kembalikan HANYA teks query SQL PostgreSQL mentah.
2. JANGAN gunakan markdown (\`\`\`sql) atau format apapun.
3. TULIS SELURUH QUERY DALAM SATU BARIS (Single Line) saja tanpa enter/line break.
4. Akhiri query dengan titik koma (;).

Gunakan CURRENT_DATE untuk referensi hari ini (Anggap saat ini bulan April 2026).`;

        // A. Natural Language to SQL
        console.log("   [⏳ AI sedang membuat query...]");
        const promptToSQL = `${SYSTEM_PROMPT}\n\nPertanyaan Owner: "${messageText}"\nQuery SQL:`;

        let sqlQuery = await callGemini(promptToSQL);

        // BEST PRACTICE: Clean markdown with Regex
        sqlQuery = sqlQuery.replace(/```sql/ig, '').replace(/```/g, '').trim();

        console.log("   [💻 Executing SQL]:\n", sqlQuery);

        // B. Execute Query in Database
        const dbResult = await sql.unsafe(sqlQuery);
        const rawData = JSON.stringify(dbResult);

        // C. SQL Result to Natural Language
        console.log("   [⏳ AI sedang menyusun jawaban...]");
        const promptToSummary = `
Kamu adalah asisten Cafe yang pintar bernama Tantri.
Berdasarkan pertanyaan owner dan data JSON mentah berikut, berikan jawaban kasual, ramah, dan berikan insight singkat.
Pertanyaan: "${messageText}"
Data DB: ${rawData}
Jawaban Anda:`;

        const finalAnswer = await callGemini(promptToSummary);
        console.log(`\n🤖 Bot Kopi Wilwatikta to ${phoneNumber}:\n${finalAnswer}\n`);

        // Send the response back to user via WhatsApp
        await sendWhatsAppMessage(phoneNumber, finalAnswer);

    } catch (error) {
        console.error("\n❌ Terjadi kesalahan query/AI:", error.message);
        await sendWhatsAppMessage(phoneNumber, "❌ Maaf, terjadi kesalahan pada sistem AI atau Database kami. Coba ubah susunan kalimat pertanyaan Anda atau coba lagi nanti.");
    }
}

// Webhook Event (Receive Messages)
app.post('/webhook', (req, res) => {
    // Return 200 OK immediately to prevent Meta from retrying
    res.sendStatus(200);

    try {
        const body = req.body;

        if (body.object === 'whatsapp_business_account') {
            if (
                body.entry &&
                body.entry[0].changes &&
                body.entry[0].changes[0] &&
                body.entry[0].changes[0].value.messages &&
                body.entry[0].changes[0].value.messages[0]
            ) {
                const message = body.entry[0].changes[0].value.messages[0];
                const phoneNumber = message.from;
                const messageText = message.text ? message.text.body : '';

                if (messageText) {
                    console.log(`\n💬 Pesan masuk dari ${phoneNumber}: "${messageText}"`);
                    // Run message processing asynchronously
                    processMessage(phoneNumber, messageText);
                }
            }
        }
    } catch (error) {
        console.error("Error handling incoming webhook:", error);
    }
});

app.listen(PORT, () => {
    console.log("=========================================");
    console.log(`🚀 CAFE AI ANALYST (EXPRESS WEBHOOK) AKTIF di port ${PORT}`);
    console.log("=========================================\n");
});
