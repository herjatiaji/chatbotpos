import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import sql from './db.js';
import OpenAI from 'openai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use(express.static('public'));

// ==========================================
// KONFIGURASI NVIDIA NIM (OpenAI-compatible)
// ==========================================
const openai = new OpenAI({
    apiKey: process.env.NVIDIA_API_KEY,
    baseURL: 'https://integrate.api.nvidia.com/v1',
});

// ==========================================
// AI ENGINE: NVIDIA NEMOTRON
// enableThinking: false → SQL generation (deterministik & cepat)
// enableThinking: true  → Summary/jawaban (lebih cerdas & natural)
// ==========================================
async function callNemotron(promptText, enableThinking = false, retries = 3, delay = 5000) {
    if (!process.env.NVIDIA_API_KEY) throw new Error("NVIDIA_API_KEY kosong!");

    for (let i = 0; i < retries; i++) {
        try {
            // Kita gunakan model Nemotron 3 (Pastikan nama model sesuai di dashboard NVIDIA)
            const modelName = 'nvidia/nemotron-3-super-120b-a12b';
            
            const response = await openai.chat.completions.create({
                model: modelName,
                messages: [{ role: 'user', content: promptText }],
                temperature: enableThinking ? 1 : 0.1,
                top_p: 0.95,
                max_tokens: enableThinking ? 4096 : 2048,
                // Sesuai dokumentasi NVIDIA NIM, ini dikirim via extra_body jika SDK tidak mendukung langsung
                extra_body: {
                    reasoning_budget: enableThinking ? 4096 : 0,
                },
                stream: true,
            });

            let fullContent = '';
            for await (const chunk of response) {
                // Log pergerakan chunk di terminal agar kita tahu server tidak mati
                const content = chunk.choices[0]?.delta?.content || '';
                fullContent += content;
                if (enableThinking && content) process.stdout.write("."); // Titik progress
            }

            return fullContent.trim();

        } catch (error) {
            // 🔥 LOG ERROR DETAIL UNTUK DEBUGGING
            console.error(`\n[🚨 API ERROR - Percobaan ${i+1}]`);
            console.error(`   - Status: ${error.status || 'Unknown'}`);
            console.error(`   - Message: ${error.message}`);
            
            // Cek apakah error karena limit kuota
            const isRateLimit = error.status === 429 || error.message.includes('429');
            const isServerOverload = error.status === 503 || error.message.includes('503');

            if (isRateLimit) console.warn("   [💡 INFO]: Anda terkena Rate Limit. Harap tunggu sebentar.");
            if (isServerOverload) console.warn("   [💡 INFO]: Server NVIDIA sedang sangat sibuk.");

            if (i === retries - 1) throw new Error(`Gagal menghubungi server AI setelah ${retries} kali percobaan.`);

            console.log(`   [⏳ RETRY] Menunggu ${delay / 1000} dtk sebelum mencoba lagi...`);
            await new Promise(res => setTimeout(res, delay));
            delay *= 2; 
        }
    }
}
// ==========================================
// API ENDPOINT
// ==========================================
app.post('/api/chat', async (req, res) => {
    const { message, phone } = req.body;

    try {
        console.log(`\n💬 Pertanyaan masuk: "${message}"`);

        const userCheck = await sql`
            SELECT u.owner_name, u.store_id, s.store_name 
            FROM whatsapp_users u 
            JOIN stores s ON u.store_id = s.id 
            WHERE u.phone_number = ${phone}
        `;

        if (userCheck.length === 0) {
            return res.status(403).json({ success: false, answer: "Maaf, nomor tidak terdaftar." });
        }

        const activeUser = userCheck[0];

        // 🧠 PROMPT STEP A: PEMBUAT SQL (thinking OFF — deterministik)
        const SYSTEM_PROMPT = `
Kamu adalah AI Data Analyst operasional Cafe.
Database PostgreSQL memiliki skema KETAT berikut (HANYA GUNAKAN KOLOM YANG ADA DI SINI):

1. stores               (id, store_name, location)
2. whatsapp_users       (phone_number, store_id, owner_name, created_at)
3. menu_categories      (id, store_id, name)
4. menu_items           (id, store_id, category_id, name, price)
5. menu_recipes         (id, menu_item_id, inventory_id, qty_used)
6. inventory            (id, store_id, item_name, unit, current_stock)
7. transactions         (id, store_id, receipt_number, order_type, table_number, transaction_date, total_amount, payment_method)
8. transaction_details  (id, transaction_id, menu_item_id, qty, subtotal, notes)
9. cash_logs            (id, store_id, type, amount, description, created_at)

RELASI ANTAR TABEL:
- transactions.id        = transaction_details.transaction_id
- transaction_details.menu_item_id = menu_items.id
- menu_items.category_id = menu_categories.id
- menu_items.id          = menu_recipes.menu_item_id
- menu_recipes.inventory_id = inventory.id
- cash_logs.store_id     = stores.id

ATURAN SQL (SANGAT PENTING):
- WAJIB gunakan alias tabel agar tidak ambigu (contoh: transactions t, transaction_details td, menu_items mi).
- WAJIB sertakan filter store_id = ${activeUser.store_id} di setiap query yang menyentuh tabel: transactions, inventory, menu_items, menu_categories, atau cash_logs.
- Untuk omzet/pendapatan gunakan SUM(t.total_amount) dari tabel transactions.
- Untuk penjualan per menu gunakan SUM(td.qty) dan SUM(td.subtotal) dari transaction_details JOIN transactions.
- Gunakan COALESCE(..., 0) untuk mencegah hasil NULL.
- Anggap saat ini bulan April 2026. Gunakan CURRENT_DATE untuk filter tanggal.
- 🚨 ANTI-TYPO NAMA MENU: WAJIB gunakan ILIKE dengan wildcard %. Contoh: mi.name ILIKE '%ayam%'. DILARANG pakai operator = untuk nama menu.
- Untuk pertanyaan tentang kas/cash flow, gunakan tabel cash_logs (type: 'in' = pemasukan, 'out' = pengeluaran).

Tugas: Kembalikan HANYA teks query SQL PostgreSQL mentah dalam SATU BARIS tanpa penjelasan apapun.`;

        console.log("   [⏳ Step A: Nemotron sedang merakit SQL...]");
        const promptToSQL = `${SYSTEM_PROMPT}\n\nPertanyaan: "${message}"\nQuery SQL:`;
        let sqlQuery = await callNemotron(promptToSQL, false); // thinking OFF
        sqlQuery = sqlQuery.replace(/```sql/ig, '').replace(/```/g, '').trim();

        if (!sqlQuery.includes(String(activeUser.store_id))) {
            throw new Error("Keamanan: Query tidak menyertakan filter store_id.");
        }

        console.log("   [💻 Execute SQL]:", sqlQuery);
        const dbResult = await sql.unsafe(sqlQuery);

        // Diet Token untuk Step C
        const safeData = dbResult.length > 15 ? dbResult.slice(0, 15) : dbResult;
        let dataToAI = JSON.stringify(safeData);
        if (dbResult.length > 15) {
            dataToAI += `\n(Info: Ini 15 data teratas. Total asli ${dbResult.length} baris).`;
        }

        // 🧠 PROMPT STEP C: PENYUSUN JAWABAN (thinking ON — lebih natural & cerdas)
        console.log("   [⏳ Step C: Nemotron menyusun jawaban Tantri...]");
        const promptToSummary = `
Kamu adalah Tantri, asisten cafe yang hangat, sabar, dan selalu bikin owner merasa nyaman.
Gaya bicaramu seperti teman dekat yang kebetulan jago angka — santai, tapi tetap informatif.

Pertanyaan owner: "${message}"
Data dari database: ${dataToAI}

Cara menjawab:
- Gunakan bahasa Indonesia yang lembut dan natural, seperti ngobrol biasa. Boleh sesekali pakai "Bos" dengan nada akrab.
- Jika datanya ada, sampaikan hasilnya dengan hangat dan tambahkan satu insight kecil yang relevan.
- Jika datanya kosong atau null, sampaikan dengan empati — jangan kaku. Contoh: "Kayaknya belum ada transaksi untuk itu, Bos 😊".
- Format angka ke Rupiah (contoh: Rp 1.250.000).
- Jangan pernah tampilkan format JSON atau kode ke owner.
- Jangan mengarang angka yang tidak ada di data.`;

        const finalAnswer = await callNemotron(promptToSummary, true); // thinking ON

        console.log("   [✅ Selesai: Mengirim ke UI Web]");
        res.json({
            success: true,
            answer: finalAnswer,
            sql: sqlQuery,
            rawData: safeData
        });

    } catch (error) {
        console.error("❌ Error path:", error.message);
        res.status(500).json({ success: false, answer: "Aduh Bos, ada kendala teknis saat menarik data. Coba lagi ya.", error: error.message });
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`
=========================================
🚀 SERVER NVIDIA NEMOTRON AKTIF
🔗 Akses di: http://localhost:${PORT}
=========================================
    `);
});