import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import sql from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use(express.static('public'));

// ==========================================
// AI ENGINE: LLaMA 4 Maverick (via NVIDIA API)
// ==========================================
async function callLlama(promptText, retries = 3, delay = 2000) {
    const invokeUrl = "https://integrate.api.nvidia.com/v1/chat/completions";
    
    // Nanti pindahkan key ini ke file .env demi keamanan: process.env.NVIDIA_API_KEY
    const apiKey = "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"; 

    const payload = {
        "model": "meta/llama-4-maverick-17b-128e-instruct",
        "messages": [{"role": "user", "content": promptText}],
        "max_tokens": 1024,
        "temperature": 0.1, // Wajib rendah agar output SQL tidak halusinasi
        "top_p": 1.00,
        "stream": false
    };

    for (let i = 0; i < retries; i++) {
        try {
            // Menggunakan native fetch bawaan Node.js demi keamanan & performa
            const response = await fetch(invokeUrl, {
                method: 'POST',
                headers: {
                    "Authorization": `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                    "Accept": "application/json"
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorDetail = await response.text();
                console.log(`   [⚠️ NVIDIA API Error] Status: ${response.status} - ${errorDetail}`);
                
                if (response.status >= 500 || response.status === 429) {
                    if (i === retries - 1) throw new Error("Server NVIDIA Overload.");
                    await new Promise(res => setTimeout(res, delay));
                    delay *= 2;
                    continue;
                }
                throw new Error(`API Error ${response.status}`);
            }

            const data = await response.json();
            // Ekstrak balasan dari struktur OpenAI-compatible
            return data.choices[0].message.content.trim();

        } catch (error) {
            if (i === retries - 1) throw error;
            console.log(`   [⚠️ Koneksi Terputus] Menunggu ${delay/1000} dtk...`);
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

        const SYSTEM_PROMPT = `
Kamu adalah AI Data Analyst operasional Cafe.
Database PostgreSQL memiliki skema KETAT berikut (HANYA GUNAKAN KOLOM INI):
1. transactions (id, store_id, receipt_number, order_type, transaction_date, total_amount, payment_method)
2. transaction_details (id, transaction_id, menu_item_id, qty, subtotal)
3. menu_items (id, store_id, category_id, name, price)
4. inventory (id, store_id, item_name, unit, current_stock)

ATURAN SQL & PENAMAAN (SANGAT PENTING):
- Untuk menghitung omzet / pendapatan, GUNAKAN kolom 'total_amount' di tabel transactions. JANGAN pernah menggunakan kolom net_amount atau total_price.
- Hubungkan transactions ke transaction_details via: transactions.id = transaction_details.transaction_id
- User adalah owner store_id = ${activeUser.store_id}. WAJIB sertakan filter "WHERE store_id = ${activeUser.store_id}" di tabel transactions pada SETIAP query.
- Anggap saat ini adalah tahun 2026.

Tugas: Kembalikan HANYA teks query SQL PostgreSQL mentah dalam SATU BARIS tanpa penjelasan, tanpa pengantar, dan tanpa markdown.`;

        console.log("   [⏳ Step A: LLaMA sedang merakit SQL...]");
        const promptToSQL = `${SYSTEM_PROMPT}\n\nPertanyaan: "${message}"\nQuery SQL:`;
        let sqlQuery = await callLlama(promptToSQL);
        sqlQuery = sqlQuery.replace(/```sql/ig, '').replace(/```/g, '').trim();

        if (!sqlQuery.includes(String(activeUser.store_id))) {
            throw new Error("Keamanan: Query tidak menyertakan filter store_id.");
        }

        console.log("   [💻 Execute SQL]:", sqlQuery);
        const dbResult = await sql.unsafe(sqlQuery);

        console.log("   [⏳ Step B: Eksekusi ke Database Supabase Sukses...]");

        // Pangkas hasil database untuk menghemat token
        const safeData = dbResult.length > 15 ? dbResult.slice(0, 15) : dbResult;
        let dataToAI = JSON.stringify(safeData);
        if (dbResult.length > 15) {
            dataToAI += `\n(Info: Ini 15 data teratas. Total asli ${dbResult.length} baris).`;
        }

        console.log("   [⏳ Step C: LLaMA menyusun jawaban Tantri...]");
        const promptToSummary = `
Kamu adalah asisten Cafe bernama Tantri. 
Jawab pertanyaan owner "${message}" SECARA KETAT berdasarkan data JSON ini saja: ${dataToAI}.

ATURAN ANTI-HALUSINASI (SANGAT PENTING):
1. DILARANG KERAS mengarang, menebak, atau membuat asumsi tentang harga, nama menu, atau nominal uang yang TIDAK ADA di dalam data JSON tersebut.
2. Jika di dalam JSON hanya ada data jumlah porsi (qty), maka sebutkan jumlah porsinya saja! JANGAN mencoba menghitung total pendapatan sendiri.
3. Jangan menggunakan kata "asumsi", "perkiraan", atau "misalnya" terkait data keuangan.
4. Jika datanya kosong atau 0, sampaikan saja apa adanya dengan sopan.

Berikan jawaban kasual, ramah, dan insight singkat (tapi hanya berdasarkan fakta dari JSON). Format angka besar ke Rupiah.`;
        const finalAnswer = await callLlama(promptToSummary);

        console.log("   [✅ Selesai: Mengirim ke UI Web]");
        res.json({
            success: true,
            answer: finalAnswer,
            sql: sqlQuery,
            rawData: safeData 
        });

    } catch (error) {
        console.error("❌ Error path:", error.message);
        res.status(500).json({ success: false, answer: "Maaf Bos, sistem lagi agak pusing baca datanya.", error: error.message });
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`
=========================================
🚀 SERVER LLaMA-MAVERICK AKTIF
🔗 Akses di: http://localhost:${PORT}
=========================================
    `);
});