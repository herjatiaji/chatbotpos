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
    if (!process.env.NVIDIA_API_KEY) {
        throw new Error("NVIDIA_API_KEY kosong! Tambahkan ke file .env");
    }

    for (let i = 0; i < retries; i++) {
        try {
            const stream = await openai.chat.completions.create({
                model: 'nvidia/nemotron-3-super-120b-a12b',
                messages: [{ role: 'user', content: promptText }],
                temperature: enableThinking ? 1 : 0.1,  // Rendah untuk SQL, bebas untuk summary
                top_p: 0.95,
                max_tokens: enableThinking ? 4096 : 2048,
                reasoning_budget: enableThinking ? 4096 : 0,
                chat_template_kwargs: { enable_thinking: enableThinking },
                stream: true,
            });

            // Kumpulkan semua chunk — ambil content saja (skip reasoning_content)
            let fullContent = '';
            for await (const chunk of stream) {
                fullContent += chunk.choices[0]?.delta?.content || '';
            }

            return fullContent.trim();

        } catch (error) {
            console.log(`   [⚠️ API Error] Percobaan ${i + 1}/${retries} gagal: ${error.message}`);

            const isOverload = error.status === 503 || error.status === 429 ||
                               error.message?.includes('503') || error.message?.includes('429');

            if (i === retries - 1 || !isOverload) throw new Error("Gagal menghubungi server AI.");

            console.log(`   [⏳ Menunggu] Coba lagi dalam ${delay / 1000} detik...`);
            await new Promise(res => setTimeout(res, delay));
            delay *= 2; // Exponential backoff
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
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD dinamis
        const storeId = activeUser.store_id;

        const SYSTEM_PROMPT = `
Kamu adalah AI SQL Generator khusus untuk sistem cafe berbasis PostgreSQL.
Tugas SATU-SATUNYA: menghasilkan query SQL yang valid, aman, akurat, dan efisien.

============================
KONTEKS WAKTU (DINAMIS)
============================
- Hari ini          : ${today}
- "hari ini"        : t.transaction_date::date = CURRENT_DATE
- "kemarin"         : t.transaction_date::date = CURRENT_DATE - INTERVAL '1 day'
- "minggu ini"      : DATE_TRUNC('week', t.transaction_date) = DATE_TRUNC('week', CURRENT_DATE)
- "minggu lalu"     : DATE_TRUNC('week', t.transaction_date) = DATE_TRUNC('week', CURRENT_DATE - INTERVAL '1 week')
- "bulan ini"       : DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE)
- "bulan lalu"      : DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')
- "tahun ini"       : DATE_TRUNC('year', t.transaction_date) = DATE_TRUNC('year', CURRENT_DATE)
- "7 hari terakhir" : t.transaction_date >= CURRENT_DATE - INTERVAL '7 days'
- "30 hari terakhir": t.transaction_date >= CURRENT_DATE - INTERVAL '30 days'
- DILARANG hardcode angka tahun atau bulan. Selalu gunakan CURRENT_DATE sebagai acuan.
- Untuk cash_logs gunakan cl.created_at (bukan transaction_date).

============================
SKEMA DATABASE
============================
stores              (id, store_name, location)
menu_categories     (id, store_id, name)
menu_items          (id, store_id, category_id, name, price)
menu_recipes        (id, menu_item_id, inventory_id, qty_used)
inventory           (id, store_id, item_name, unit, current_stock)
transactions        (id, store_id, receipt_number, order_type, table_number, transaction_date, total_amount, payment_method)
transaction_details (id, transaction_id, menu_item_id, qty, subtotal, notes)
cash_logs           (id, store_id, type, amount, description, created_at)

============================
ALIAS WAJIB
============================
transactions        → t
transaction_details → td
menu_items          → mi
menu_categories     → mc
inventory           → inv
cash_logs           → cl
menu_recipes        → mr

============================
RELASI
============================
t.id               = td.transaction_id
td.menu_item_id    = mi.id
mi.category_id     = mc.id
mi.id              = mr.menu_item_id
mr.inventory_id    = inv.id

============================
ATURAN WAJIB
============================
[1] FILTER KEAMANAN: WAJIB sertakan store_id = ${storeId} pada SETIAP query yang menyentuh tabel:
    transactions, inventory, menu_items, menu_categories, cash_logs.
[2] ALIAS: Gunakan alias wajib di atas untuk semua tabel, tanpa kecuali.
[3] NULL-SAFE: Bungkus SEMUA agregat dengan COALESCE(SUM(...), 0) atau COALESCE(COUNT(...), 0).
[4] NAMA KOLOM: Beri nama output yang deskriptif. Contoh: AS total_omzet, AS total_porsi, AS nama_menu.
[5] ILIKE: DILARANG pakai = untuk mencari nama menu/kategori. WAJIB pakai ILIKE '%keyword%'.
[6] MULTI-PERIODE: Untuk perbandingan dua periode (minggu ini vs lalu, dll), WAJIB gunakan CTE (WITH ... AS).
[7] LABA/RUGI: pendapatan = COALESCE(SUM(t.total_amount),0) dari transactions.
              pengeluaran = COALESCE(SUM(cl.amount),0) dari cash_logs WHERE cl.type = 'out'.
              JANGAN hitung cash_logs type 'in' sebagai pendapatan operasional.
[8] BAHAN TERPAKAI: Untuk estimasi bahan terpakai, JOIN menu_recipes mr ON mr.menu_item_id = mi.id,
    lalu SUM(td.qty * mr.qty_used) per inventory_id.
[9] HARI DALAM SEMINGGU: Gunakan EXTRACT(DOW FROM t.transaction_date).
    0=Minggu, 1=Senin, 2=Selasa, 3=Rabu, 4=Kamis, 5=Jumat, 6=Sabtu.
[10] JANGAN sertakan kolom 'notes' kecuali diminta secara eksplisit.

============================
CONTOH QUERY (FEW-SHOT)
============================

Pertanyaan: "5 menu terlaris bulan ini"
SQL: SELECT mi.name AS nama_menu, COALESCE(SUM(td.qty),0) AS total_porsi, COALESCE(SUM(td.subtotal),0) AS total_pendapatan FROM transaction_details td JOIN transactions t ON td.transaction_id = t.id JOIN menu_items mi ON td.menu_item_id = mi.id WHERE t.store_id = ${storeId} AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE) GROUP BY mi.name ORDER BY total_porsi DESC LIMIT 5;

Pertanyaan: "omzet minggu ini vs minggu lalu"
SQL: WITH minggu_ini AS (SELECT COALESCE(SUM(t.total_amount),0) AS omzet FROM transactions t WHERE t.store_id = ${storeId} AND DATE_TRUNC('week', t.transaction_date) = DATE_TRUNC('week', CURRENT_DATE)), minggu_lalu AS (SELECT COALESCE(SUM(t.total_amount),0) AS omzet FROM transactions t WHERE t.store_id = ${storeId} AND DATE_TRUNC('week', t.transaction_date) = DATE_TRUNC('week', CURRENT_DATE - INTERVAL '1 week')) SELECT mi.omzet AS omzet_minggu_ini, ml.omzet AS omzet_minggu_lalu, (mi.omzet - ml.omzet) AS selisih, CASE WHEN ml.omzet = 0 THEN NULL ELSE ROUND(((mi.omzet - ml.omzet) / ml.omzet * 100)::numeric, 2) END AS persentase_perubahan FROM minggu_ini mi, minggu_lalu ml;

Pertanyaan: "rekap laba rugi bulan ini"
SQL: WITH pendapatan AS (SELECT COALESCE(SUM(t.total_amount),0) AS total FROM transactions t WHERE t.store_id = ${storeId} AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE)), pengeluaran AS (SELECT COALESCE(SUM(cl.amount),0) AS total FROM cash_logs cl WHERE cl.store_id = ${storeId} AND cl.type = 'out' AND DATE_TRUNC('month', cl.created_at) = DATE_TRUNC('month', CURRENT_DATE)) SELECT p.total AS total_pendapatan, k.total AS total_pengeluaran, (p.total - k.total) AS laba_bersih FROM pendapatan p, pengeluaran k;

Pertanyaan: "stok bahan baku paling menipis"
SQL: SELECT inv.item_name AS bahan_baku, inv.current_stock AS stok_saat_ini, inv.unit FROM inventory inv WHERE inv.store_id = ${storeId} ORDER BY inv.current_stock ASC LIMIT 10;

Pertanyaan: "omzet per hari dalam seminggu ini"
SQL: SELECT TO_CHAR(t.transaction_date, 'Day') AS hari, EXTRACT(DOW FROM t.transaction_date) AS urutan_hari, COALESCE(SUM(t.total_amount),0) AS total_omzet, COUNT(t.id) AS jumlah_transaksi FROM transactions t WHERE t.store_id = ${storeId} AND DATE_TRUNC('week', t.transaction_date) = DATE_TRUNC('week', CURRENT_DATE) GROUP BY hari, urutan_hari ORDER BY urutan_hari;

Pertanyaan: "jam tersibuk hari ini"
SQL: SELECT EXTRACT(HOUR FROM t.transaction_date) AS jam, COUNT(t.id) AS jumlah_transaksi, COALESCE(SUM(t.total_amount),0) AS omzet FROM transactions t WHERE t.store_id = ${storeId} AND t.transaction_date::date = CURRENT_DATE GROUP BY jam ORDER BY jumlah_transaksi DESC;

Pertanyaan: "pendapatan dari kategori kopi bulan ini"
SQL: SELECT mc.name AS kategori, COALESCE(SUM(td.qty),0) AS total_porsi, COALESCE(SUM(td.subtotal),0) AS total_pendapatan FROM transaction_details td JOIN transactions t ON td.transaction_id = t.id JOIN menu_items mi ON td.menu_item_id = mi.id JOIN menu_categories mc ON mi.category_id = mc.id WHERE t.store_id = ${storeId} AND mc.store_id = ${storeId} AND mc.name ILIKE '%kopi%' AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE) GROUP BY mc.name;

Pertanyaan: "perbandingan dine-in vs takeaway bulan ini"
SQL: SELECT t.order_type, COUNT(t.id) AS jumlah_transaksi, COALESCE(SUM(t.total_amount),0) AS total_omzet, ROUND(COALESCE(AVG(t.total_amount),0)::numeric, 0) AS rata_rata_transaksi FROM transactions t WHERE t.store_id = ${storeId} AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE) GROUP BY t.order_type ORDER BY total_omzet DESC;

============================
FORMAT OUTPUT
============================
- Kembalikan HANYA satu baris SQL mentah. Tanpa markdown, tanpa penjelasan, tanpa komentar.
- Akhiri dengan titik koma (;).
- Jika pertanyaan tidak bisa dijawab dengan data yang ada, kembalikan: SELECT 'PERTANYAAN_TIDAK_VALID' AS status;`;

        console.log("   [⏳ Step A: Nemotron sedang merakit SQL...]");
        const promptToSQL = `${SYSTEM_PROMPT}\n\nPertanyaan: "${message}"\nQuery SQL:`;
        let sqlQuery = await callNemotron(promptToSQL, false); // thinking OFF
        sqlQuery = sqlQuery.replace(/```sql/ig, '').replace(/```/g, '').trim();

        if (!sqlQuery.includes(String(activeUser.store_id))) {
            throw new Error("Keamanan: Query tidak menyertakan filter store_id.");
        }

        console.log("   [💻 Execute SQL]:", sqlQuery);

        // Guard: jika model menyerah dan return status invalid
        if (sqlQuery.includes('PERTANYAAN_TIDAK_VALID')) {
            return res.json({
                success: true,
                answer: "Mohon maaf, pertanyaan tersebut sepertinya belum bisa saya jawab dengan data yang tersedia. Coba tanyakan dengan cara yang berbeda ya.",
                sql: sqlQuery,
                rawData: []
            });
        }

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
Kamu adalah Tantri, Asisten Analis Data untuk sistem manajemen cafe yang profesional dan terpercaya.
Tugasmu adalah menyampaikan laporan data operasional kepada pemilik usaha secara jelas, formal, dan mudah dipahami.

Pertanyaan: "${message}"
Data dari database: ${dataToAI}

ATURAN PENYAMPAIAN:
1. Gunakan bahasa Indonesia yang baku, sopan, dan profesional. Hindari bahasa gaul, singkatan informal, atau sapaan seperti "Bos", "Kak", "Gan", dll.
2. Awali jawaban langsung pada inti laporan — tidak perlu basa-basi panjang.
3. Jika data tersedia, sampaikan hasil secara terstruktur dan sertakan satu insight bisnis singkat yang relevan dan actionable.
4. Jika data kosong atau bernilai null, sampaikan dengan sopan. Contoh: "Belum terdapat data transaksi untuk periode yang dimaksud."
5. Format semua angka ke dalam Rupiah yang rapi. Contoh: Rp 1.250.000.
6. DILARANG menampilkan format JSON, kode, atau simbol teknis kepada pengguna.
7. DILARANG mengarang atau mengasumsikan angka yang tidak terdapat dalam data.
8. Jika data berupa daftar, gunakan format yang rapi dan mudah dibaca (nomor urut atau poin singkat).`;

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
=========================================
🚀 SERVER NVIDIA NEMOTRON AKTIF
🔗 Akses di: http://localhost:${PORT}
=========================================
    `);
});