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
            const modelName = 'nvidia/nemotron-3-super-120b-a12b';
            
            const response = await openai.chat.completions.create({
                model: modelName,
                messages: [{ role: 'user', content: promptText }],
                temperature: enableThinking ? 1 : 0.1,
                top_p: 0.95,
                max_tokens: enableThinking ? 4096 : 2048,
                extra_body: {
                    reasoning_budget: enableThinking ? 4096 : 0,
                },
                stream: true,
            });

            let fullContent = '';
            for await (const chunk of response) {
                const content = chunk.choices[0]?.delta?.content || '';
                fullContent += content;
                if (enableThinking && content) process.stdout.write("."); 
            }

            return fullContent.trim();

        } catch (error) {
            console.error(`\n[🚨 API ERROR - Percobaan ${i+1}]`);
            console.error(`   - Status: ${error.status || 'Unknown'}`);
            console.error(`   - Message: ${error.message}`);
            
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
            return res.status(403).json({ success: false, answer: "Mohon maaf, nomor Anda tidak terdaftar dalam sistem kami." });
        }

        const activeUser = userCheck[0];

        // 🧠 PROMPT STEP A: PEMBUAT SQL (Dengan Aturan Laba/Rugi Baru)
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
- WAJIB gunakan alias tabel agar tidak ambigu.
- WAJIB sertakan filter store_id = ${activeUser.store_id} di setiap query.
- Anggap saat ini bulan April 2026. Gunakan CURRENT_DATE untuk filter tanggal.
- 🚨 ANTI-TYPO NAMA MENU: WAJIB gunakan ILIKE dengan wildcard %. DILARANG pakai operator = untuk nama menu.
- 🚨 ATURAN LABA/RUGI & KEUANGAN: Jika ditanya "Laba", "Rugi", atau "Rekap", gunakan kombinasi dari tabel 'transactions' (sebagai omzet/pendapatan) dan 'cash_logs' type 'out' (sebagai pengeluaran). JANGAN menghitung cash_logs type 'in' yang deskripsinya mengandung kata 'Modal' sebagai pendapatan operasional.

Tugas: Kembalikan HANYA teks query SQL PostgreSQL mentah dalam SATU BARIS tanpa penjelasan apapun.`;

        console.log("   [⏳ Step A: Nemotron sedang merakit SQL...]");
        const promptToSQL = `${SYSTEM_PROMPT}\n\nPertanyaan: "${message}"\nQuery SQL:`;
        let sqlQuery = await callNemotron(promptToSQL, false); 
        sqlQuery = sqlQuery.replace(/```sql/ig, '').replace(/```/g, '').trim();

        if (!sqlQuery.includes(String(activeUser.store_id))) {
            throw new Error("Keamanan: Query tidak menyertakan filter store_id.");
        }

        console.log("   [💻 Execute SQL]:", sqlQuery);
        const dbResult = await sql.unsafe(sqlQuery);

        const safeData = dbResult.length > 15 ? dbResult.slice(0, 15) : dbResult;
        let dataToAI = JSON.stringify(safeData);
        if (dbResult.length > 15) {
            dataToAI += `\n(Info: Ini 15 data teratas. Total asli ${dbResult.length} baris).`;
        }

        // 🧠 PROMPT STEP C: PENYUSUN JAWABAN (Persona Profesional & Formal)
        console.log("   [⏳ Step C: Nemotron menyusun jawaban akhir...]");
        const promptToSummary = `
Kamu adalah Asisten Data Analyst yang profesional, sopan, dan formal.
Tugasmu adalah membacakan data pelaporan keuangan/operasional kepada pihak manajemen.

Pertanyaan pengguna: "${message}"
Data dari database: ${dataToAI}

Cara menjawab:
- Gunakan bahasa Indonesia yang baku, formal, dan profesional. 
- DILARANG KERAS menggunakan bahasa gaul, kata sapaan santai seperti "Bos", "Bro", atau gaya bahasa yang terkesan sok asik. 
- Sapa pengguna dengan "owner/pemilik" atau cukup sampaikan laporan secara langsung dan elegan.
- Jika datanya ada, sampaikan hasilnya secara terstruktur dan tambahkan satu insight bisnis singkat yang relevan berdasarkan data tersebut.
- Jika datanya kosong atau bernilai null, sampaikan dengan sopan. Contoh: "Mohon maaf, saat ini belum ada data transaksi untuk periode tersebut."
- Format angka ke Rupiah dengan rapi (contoh: Rp 1.250.000).
- Jangan pernah tampilkan format JSON atau kode kepada pengguna.
- DILARANG mengarang angka yang tidak ada di data.`;

        const finalAnswer = await callNemotron(promptToSummary, true); 

        console.log("   [✅ Selesai: Mengirim ke UI Web]");
        res.json({
            success: true,
            answer: finalAnswer,
            sql: sqlQuery,
            rawData: safeData
        });

    } catch (error) {
        console.error("❌ Error path:", error.message);
        // Ubah juga pesan error darurat agar lebih formal
        res.status(500).json({ 
            success: false, 
            answer: "Mohon maaf, terjadi kendala teknis saat menarik data dari server. Silakan coba beberapa saat lagi.", 
            error: error.message 
        });
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`
=========================================
🚀 SERVER NVIDIA NEMOTRON AKTIF
🔗 Port: ${PORT}
=========================================
    `);
});