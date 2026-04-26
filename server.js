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
// KONFIGURASI NVIDIA NIM
// ==========================================
const openai = new OpenAI({
    apiKey: process.env.NVIDIA_API_KEY,
    baseURL: 'https://integrate.api.nvidia.com/v1',
});

// ==========================================
// MULTI-TENANT: Rate limiter per store
// Max 20 request/menit per store_id
// ==========================================
const rateLimitMap = new Map();

function isRateLimited(storeId) {
    const now = Date.now();
    const windowMs = 60 * 1000; // 1 menit
    const maxRequests = 20;

    if (!rateLimitMap.has(storeId)) {
        rateLimitMap.set(storeId, []);
    }

    const timestamps = rateLimitMap.get(storeId).filter(t => now - t < windowMs);
    timestamps.push(now);
    rateLimitMap.set(storeId, timestamps);

    return timestamps.length > maxRequests;
}

// ==========================================
// MULTI-TENANT: Session/conversation context
// Menyimpan 5 pesan terakhir per nomor HP
// ==========================================
const sessionStore = new Map();
const MAX_HISTORY = 5;
const SESSION_TTL = 30 * 60 * 1000; // 30 menit

function getSession(phone) {
    const session = sessionStore.get(phone);
    if (!session) return { history: [], lastActive: Date.now() };
    if (Date.now() - session.lastActive > SESSION_TTL) {
        sessionStore.delete(phone);
        return { history: [], lastActive: Date.now() };
    }
    return session;
}

function updateSession(phone, userMsg, botMsg) {
    const session = getSession(phone);
    session.history.push({ role: 'user', content: userMsg });
    session.history.push({ role: 'assistant', content: botMsg });
    // Trim ke MAX_HISTORY pasang terakhir
    if (session.history.length > MAX_HISTORY * 2) {
        session.history = session.history.slice(-MAX_HISTORY * 2);
    }
    session.lastActive = Date.now();
    sessionStore.set(phone, session);
}

// Bersihkan session kadaluarsa setiap 10 menit
setInterval(() => {
    const now = Date.now();
    for (const [phone, session] of sessionStore.entries()) {
        if (now - session.lastActive > SESSION_TTL) sessionStore.delete(phone);
    }
}, 10 * 60 * 1000);

// ==========================================
// SECURITY: Validasi SQL dari AI
// ==========================================
const FORBIDDEN_SQL_KEYWORDS = [
    /\bDROP\b/i, /\bDELETE\b/i, /\bUPDATE\b/i, /\bINSERT\b/i,
    /\bALTER\b/i, /\bTRUNCATE\b/i, /\bCREATE\b/i, /\bGRANT\b/i,
    /\bREVOKE\b/i, /\bEXECUTE\b/i, /\bpg_sleep\b/i, /\bpg_read_file\b/i,
];

function validateSQL(sqlQuery, storeId) {
    // [1] Cek keyword berbahaya
    for (const pattern of FORBIDDEN_SQL_KEYWORDS) {
        if (pattern.test(sqlQuery)) {
            throw new Error(`SQL tidak aman: mengandung keyword terlarang.`);
        }
    }

    // [2] Pastikan hanya SELECT
    if (!/^\s*(?:WITH\s+\w|SELECT\s)/i.test(sqlQuery)) {
        throw new Error(`SQL tidak aman: hanya query SELECT atau CTE yang diizinkan.`);
    }

    // [3] Cek store_id dengan word boundary (fix false-positive "1" match "10")
    const storeIdPattern = new RegExp(`store_id\\s*=\\s*${storeId}(?!\\d)`);
    if (!storeIdPattern.test(sqlQuery)) {
        throw new Error(`SQL tidak aman: tidak ada filter store_id = ${storeId}.`);
    }
}

// ==========================================
// AI ENGINE
// ==========================================
async function callNemotron(promptText, enableThinking = false, retries = 3, delay = 5000) {
    if (!process.env.NVIDIA_API_KEY) throw new Error("NVIDIA_API_KEY kosong!");

    for (let i = 0; i < retries; i++) {
        try {
            const stream = await openai.chat.completions.create({
                model: 'nvidia/nemotron-3-super-120b-a12b',
                messages: [{ role: 'user', content: promptText }],
                temperature: enableThinking ? 1 : 0.1,
                top_p: 0.95,
                max_tokens: enableThinking ? 4096 : 2048,
                reasoning_budget: enableThinking ? 4096 : 0,
                chat_template_kwargs: { enable_thinking: enableThinking },
                stream: true,
            });

            let fullContent = '';
            for await (const chunk of stream) {
                fullContent += chunk.choices[0]?.delta?.content || '';
            }
            return fullContent.trim();

        } catch (error) {
            console.log(`   [⚠️ API Error] Percobaan ${i + 1}/${retries}: ${error.message}`);
            const isOverload = error.status === 503 || error.status === 429 ||
                               error.message?.includes('503') || error.message?.includes('429');
            if (i === retries - 1 || !isOverload) throw new Error("Gagal menghubungi server AI.");
            await new Promise(res => setTimeout(res, delay));
            delay *= 2;
        }
    }
}

// ==========================================
// HELPER: Ambil rentang data transaksi
// ==========================================
async function getDataRange(storeId) {
    try {
        const result = await sql`
            SELECT 
                MIN(transaction_date)::date AS tanggal_pertama,
                MAX(transaction_date)::date AS tanggal_terakhir,
                COUNT(*) AS total_transaksi
            FROM transactions WHERE store_id = ${storeId}
        `;
        return result[0];
    } catch { return null; }
}

// ==========================================
// HELPER: Deteksi chitchat
// ==========================================
function isChitchat(message) {
    const patterns = [
        /^halo/i, /^hai/i, /^hi\b/i, /^hey/i,
        /^apa kabar/i, /^selamat/i, /^terima kasih/i, /^makasih/i,
        /^siapa kamu/i, /^kamu itu/i, /^bisa apa/i, /^help\b/i, /^bantuan/i,
    ];
    return patterns.some(p => p.test(message.trim()));
}

// ==========================================
// API ENDPOINT
// ==========================================
app.post('/api/chat', async (req, res) => {
    const { message, phone } = req.body;

    if (!message || !phone) {
        return res.status(400).json({ success: false, answer: "Parameter 'message' dan 'phone' wajib diisi." });
    }

    try {
        console.log(`\n💬 [${phone}] "${message}"`);

        // ── Lookup user & store ──────────────────────────────
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
        const storeId = activeUser.store_id;
        const storeName = activeUser.store_name;

        // ── Rate limiting per store ───────────────────────────
        if (isRateLimited(storeId)) {
            return res.status(429).json({
                success: false,
                answer: "Mohon maaf, terlalu banyak permintaan dalam waktu singkat. Silakan tunggu sebentar sebelum mencoba kembali."
            });
        }

        // ── Chitchat guard ────────────────────────────────────
        if (isChitchat(message)) {
            return res.json({
                success: true,
                answer: `Selamat datang di sistem analitik ${storeName}. Saya adalah Tantri, Asisten Analis Data Anda. Silakan ajukan pertanyaan seputar data transaksi, omzet, stok, atau laporan keuangan.`,
                sql: null,
                rawData: []
            });
        }

        // ── Ambil session/history percakapan ──────────────────
        const session = getSession(phone);
        const conversationHistory = session.history
            .map(h => `${h.role === 'user' ? 'Owner' : 'Tantri'}: ${h.content}`)
            .join('\n');

        const today = new Date().toISOString().split('T')[0];

        // ══════════════════════════════════════════════════════
        // 🧠 STEP A: SQL GENERATOR
        // ══════════════════════════════════════════════════════
        const SYSTEM_PROMPT = `
Kamu adalah AI SQL Generator khusus untuk sistem cafe berbasis PostgreSQL.
Tugas SATU-SATUNYA: menghasilkan query SQL yang valid, aman, akurat, dan efisien.

Kamu sedang melayani: ${storeName} (store_id = ${storeId})
Hari ini: ${today}

============================
KONTEKS PERCAKAPAN SEBELUMNYA
============================
${conversationHistory || '(Tidak ada riwayat percakapan sebelumnya)'}

Gunakan konteks di atas HANYA jika pertanyaan saat ini merujuk ke pertanyaan sebelumnya
(contoh: "lalu bulan lalu?", "bagaimana dengan meja 3?", "bandingkan dengan minggu kemarin").

============================
PEMETAAN KATA KUNCI WAKTU
============================
| Kata kunci user                               | Filter SQL                                                                                       |
|-----------------------------------------------|--------------------------------------------------------------------------------------------------|
| "hari ini", "today"                           | t.transaction_date::date = CURRENT_DATE                                                          |
| "kemarin"                                     | t.transaction_date::date = CURRENT_DATE - INTERVAL '1 day'                                       |
| "minggu ini"                                  | DATE_TRUNC('week', t.transaction_date) = DATE_TRUNC('week', CURRENT_DATE)                        |
| "minggu lalu"                                 | DATE_TRUNC('week', t.transaction_date) = DATE_TRUNC('week', CURRENT_DATE - INTERVAL '1 week')    |
| "bulan ini"                                   | DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE)                      |
| "bulan lalu"                                  | DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month') |
| "tahun ini"                                   | DATE_TRUNC('year', t.transaction_date) = DATE_TRUNC('year', CURRENT_DATE)                        |
| "tahun lalu"                                  | DATE_TRUNC('year', t.transaction_date) = DATE_TRUNC('year', CURRENT_DATE - INTERVAL '1 year')    |
| "7 hari terakhir"                             | t.transaction_date >= CURRENT_DATE - INTERVAL '7 days'                                           |
| "30 hari terakhir"                            | t.transaction_date >= CURRENT_DATE - INTERVAL '30 days'                                          |
| "sekarang", "saat ini", "kini"                | DATE_TRUNC('month', ...) = DATE_TRUNC('month', CURRENT_DATE)   ← BULAN INI                       |
| "total", "keseluruhan", "semua", "sepanjang"  | TANPA filter tanggal                                                                             |
| "kuartal ini"                                 | EXTRACT(QUARTER FROM ...) = EXTRACT(QUARTER FROM CURRENT_DATE) AND EXTRACT(YEAR FROM ...) = EXTRACT(YEAR FROM CURRENT_DATE) |
| "kuartal lalu"                                | Gunakan CURRENT_DATE - INTERVAL '3 months' sebagai acuan kuartal                                 |

NAMA BULAN: Januari=1, Februari=2, Maret=3, April=4, Mei=5, Juni=6,
            Juli=7, Agustus=8, September=9, Oktober=10, November=11, Desember=12
→ Gunakan: EXTRACT(MONTH FROM t.transaction_date) = [N] AND EXTRACT(YEAR FROM t.transaction_date) = EXTRACT(YEAR FROM CURRENT_DATE)

METODE PEMBAYARAN:
| Kata user                                    | Filter                    |
|----------------------------------------------|---------------------------|
| "tunai", "cash", "uang tunai"                | ILIKE '%cash%'            |
| "transfer", "bank", "atm"                    | ILIKE '%transfer%'        |
| "qris", "scan", "digital", "ewallet"         | ILIKE '%qris%'            |

ATURAN KRITIS:
- "sekarang"/"saat ini" = BULAN INI, bukan hari ini.
- "total"/"keseluruhan" tanpa periode = HAPUS semua filter tanggal.
- DILARANG hardcode angka tahun/bulan. Pakai CURRENT_DATE atau EXTRACT().
- cash_logs gunakan cl.created_at, bukan transaction_date.
- "tanggal [N]" tanpa bulan = tanggal N bulan & tahun saat ini.

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
transactions → t | transaction_details → td | menu_items → mi
menu_categories → mc | inventory → inv | cash_logs → cl | menu_recipes → mr

============================
RELASI
============================
t.id = td.transaction_id | td.menu_item_id = mi.id | mi.category_id = mc.id
mi.id = mr.menu_item_id  | mr.inventory_id = inv.id

============================
ATURAN WAJIB
============================
[1]  KEAMANAN: WAJIB store_id = ${storeId} pada: transactions, inventory, menu_items, menu_categories, cash_logs.
[2]  ALIAS: Gunakan alias wajib di atas tanpa kecuali.
[3]  NULL-SAFE: Bungkus SEMUA agregat dengan COALESCE(..., 0).
[4]  NAMA KOLOM: Selalu beri nama deskriptif (AS total_omzet, AS nama_menu, dll.).
[5]  ILIKE: DILARANG = untuk nama menu/kategori. WAJIB ILIKE '%keyword%'.
[6]  MULTI-PERIODE: Gunakan CTE (WITH ... AS) untuk perbandingan dua periode.
[7]  LABA/RUGI: pendapatan=SUM(t.total_amount), pengeluaran=SUM(cl.amount) WHERE cl.type='out'.
[8]  BAHAN TERPAKAI: SUM(td.qty * mr.qty_used) GROUP BY inv.item_name.
[9]  HARI: EXTRACT(DOW). 0=Minggu, 1=Sen, 2=Sel, 3=Rab, 4=Kam, 5=Jum, 6=Sab.
[10] NOTES: Jangan sertakan kecuali diminta eksplisit.
[11] DIVISI NOL: CASE WHEN denominator = 0 THEN NULL ELSE ROUND(n/d, 2) END.
[12] RANKING: DENSE_RANK() OVER (ORDER BY ... DESC) jika user minta "peringkat/ranking".
[13] MENU TIDAK TERJUAL: LEFT JOIN + WHERE td.id IS NULL.
[14] MULTI-KEYWORD: mi.name ILIKE '%a%' OR mi.name ILIKE '%b%'.
[15] FILTER NOMINAL: t.total_amount > [nilai] atau < [nilai].
[16] PER MEJA: t.table_number untuk analisis per nomor meja.
[17] RATA-RATA HARIAN: SUM / COUNT(DISTINCT t.transaction_date::date).
[18] KONTRIBUSI (%): Gunakan subquery atau CTE untuk hitung persentase per item.
[19] FOLLOW-UP: Jika pertanyaan merujuk ke percakapan sebelumnya (ada kata "itu", "tadi", "lalu bagaimana", "bandingkan"), gunakan konteks riwayat percakapan untuk memahami subjeknya.

============================
CONTOH QUERY (FEW-SHOT)
============================

Pertanyaan: "total pendapatan keseluruhan"
SQL: SELECT COALESCE(SUM(t.total_amount),0) AS total_pendapatan, COUNT(t.id) AS total_transaksi FROM transactions t WHERE t.store_id = ${storeId};

Pertanyaan: "total pendapatan sekarang" / "pendapatan saat ini"
SQL: SELECT COALESCE(SUM(t.total_amount),0) AS total_pendapatan, COUNT(t.id) AS total_transaksi FROM transactions t WHERE t.store_id = ${storeId} AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE);

Pertanyaan: "total pendapatan hari ini"
SQL: SELECT COALESCE(SUM(t.total_amount),0) AS total_pendapatan, COUNT(t.id) AS total_transaksi FROM transactions t WHERE t.store_id = ${storeId} AND t.transaction_date::date = CURRENT_DATE;

Pertanyaan: "pendapatan bulan Maret"
SQL: SELECT COALESCE(SUM(t.total_amount),0) AS total_pendapatan, COUNT(t.id) AS total_transaksi FROM transactions t WHERE t.store_id = ${storeId} AND EXTRACT(MONTH FROM t.transaction_date) = 3 AND EXTRACT(YEAR FROM t.transaction_date) = EXTRACT(YEAR FROM CURRENT_DATE);

Pertanyaan: "5 menu terlaris bulan ini"
SQL: SELECT mi.name AS nama_menu, COALESCE(SUM(td.qty),0) AS total_porsi, COALESCE(SUM(td.subtotal),0) AS total_pendapatan FROM transaction_details td JOIN transactions t ON td.transaction_id = t.id JOIN menu_items mi ON td.menu_item_id = mi.id WHERE t.store_id = ${storeId} AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE) GROUP BY mi.name ORDER BY total_porsi DESC LIMIT 5;

Pertanyaan: "menu yang belum pernah terjual bulan ini"
SQL: SELECT mi.name AS nama_menu, mi.price AS harga FROM menu_items mi LEFT JOIN (SELECT td.menu_item_id FROM transaction_details td JOIN transactions t ON td.transaction_id = t.id WHERE t.store_id = ${storeId} AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE)) sold ON mi.id = sold.menu_item_id WHERE mi.store_id = ${storeId} AND sold.menu_item_id IS NULL ORDER BY mi.name;

Pertanyaan: "ranking menu berdasarkan omzet bulan ini"
SQL: SELECT mi.name AS nama_menu, COALESCE(SUM(td.subtotal),0) AS total_omzet, DENSE_RANK() OVER (ORDER BY COALESCE(SUM(td.subtotal),0) DESC) AS peringkat FROM transaction_details td JOIN transactions t ON td.transaction_id = t.id JOIN menu_items mi ON td.menu_item_id = mi.id WHERE t.store_id = ${storeId} AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE) GROUP BY mi.name ORDER BY peringkat;

Pertanyaan: "berapa persen kontribusi kopi susu aren terhadap total omzet bulan ini"
SQL: WITH total AS (SELECT COALESCE(SUM(t.total_amount),0) AS grand_total FROM transactions t WHERE t.store_id = ${storeId} AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE)), item AS (SELECT COALESCE(SUM(td.subtotal),0) AS item_total FROM transaction_details td JOIN transactions t ON td.transaction_id = t.id JOIN menu_items mi ON td.menu_item_id = mi.id WHERE t.store_id = ${storeId} AND mi.name ILIKE '%kopi susu aren%' AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE)) SELECT item.item_total AS omzet_menu, total.grand_total AS omzet_total, CASE WHEN total.grand_total = 0 THEN NULL ELSE ROUND((item.item_total / total.grand_total * 100)::numeric, 2) END AS persentase_kontribusi FROM item, total;

Pertanyaan: "rata-rata omzet per hari bulan ini"
SQL: SELECT ROUND(COALESCE(SUM(t.total_amount),0) / NULLIF(COUNT(DISTINCT t.transaction_date::date), 0), 0) AS rata_rata_omzet_per_hari, COUNT(DISTINCT t.transaction_date::date) AS jumlah_hari_aktif FROM transactions t WHERE t.store_id = ${storeId} AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE);

Pertanyaan: "omzet minggu ini vs minggu lalu"
SQL: WITH minggu_ini AS (SELECT COALESCE(SUM(t.total_amount),0) AS omzet FROM transactions t WHERE t.store_id = ${storeId} AND DATE_TRUNC('week', t.transaction_date) = DATE_TRUNC('week', CURRENT_DATE)), minggu_lalu AS (SELECT COALESCE(SUM(t.total_amount),0) AS omzet FROM transactions t WHERE t.store_id = ${storeId} AND DATE_TRUNC('week', t.transaction_date) = DATE_TRUNC('week', CURRENT_DATE - INTERVAL '1 week')) SELECT a.omzet AS omzet_minggu_ini, b.omzet AS omzet_minggu_lalu, (a.omzet - b.omzet) AS selisih, CASE WHEN b.omzet = 0 THEN NULL ELSE ROUND(((a.omzet - b.omzet) / b.omzet * 100)::numeric, 2) END AS persentase_perubahan FROM minggu_ini a, minggu_lalu b;

Pertanyaan: "rekap laba rugi bulan ini"
SQL: WITH pendapatan AS (SELECT COALESCE(SUM(t.total_amount),0) AS total FROM transactions t WHERE t.store_id = ${storeId} AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE)), pengeluaran AS (SELECT COALESCE(SUM(cl.amount),0) AS total FROM cash_logs cl WHERE cl.store_id = ${storeId} AND cl.type = 'out' AND DATE_TRUNC('month', cl.created_at) = DATE_TRUNC('month', CURRENT_DATE)) SELECT p.total AS total_pendapatan, k.total AS total_pengeluaran, (p.total - k.total) AS laba_bersih FROM pendapatan p, pengeluaran k;

Pertanyaan: "transaksi di atas 500 ribu hari ini"
SQL: SELECT t.receipt_number, t.table_number, t.total_amount, t.payment_method, t.transaction_date FROM transactions t WHERE t.store_id = ${storeId} AND t.transaction_date::date = CURRENT_DATE AND t.total_amount > 500000 ORDER BY t.total_amount DESC;

Pertanyaan: "omzet per meja bulan ini"
SQL: SELECT t.table_number AS nomor_meja, COUNT(t.id) AS jumlah_transaksi, COALESCE(SUM(t.total_amount),0) AS total_omzet FROM transactions t WHERE t.store_id = ${storeId} AND t.order_type = 'dine_in' AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE) GROUP BY t.table_number ORDER BY total_omzet DESC;

Pertanyaan: "penjualan ayam dan mie bulan ini"
SQL: SELECT mi.name AS nama_menu, COALESCE(SUM(td.qty),0) AS total_porsi, COALESCE(SUM(td.subtotal),0) AS total_pendapatan FROM transaction_details td JOIN transactions t ON td.transaction_id = t.id JOIN menu_items mi ON td.menu_item_id = mi.id WHERE t.store_id = ${storeId} AND (mi.name ILIKE '%ayam%' OR mi.name ILIKE '%mie%') AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE) GROUP BY mi.name ORDER BY total_porsi DESC;

Pertanyaan: "omzet akhir pekan vs hari kerja bulan ini"
SQL: WITH klasifikasi AS (SELECT CASE WHEN EXTRACT(DOW FROM t.transaction_date) IN (0,6) THEN 'Akhir Pekan' ELSE 'Hari Kerja' END AS tipe_hari, t.total_amount FROM transactions t WHERE t.store_id = ${storeId} AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE)) SELECT tipe_hari, COUNT(*) AS jumlah_transaksi, COALESCE(SUM(total_amount),0) AS total_omzet, ROUND(COALESCE(AVG(total_amount),0)::numeric,0) AS rata_rata_transaksi FROM klasifikasi GROUP BY tipe_hari ORDER BY total_omzet DESC;

Pertanyaan: "estimasi bahan terpakai bulan ini"
SQL: SELECT inv.item_name AS bahan_baku, inv.unit, COALESCE(SUM(td.qty * mr.qty_used),0) AS estimasi_terpakai FROM transaction_details td JOIN transactions t ON td.transaction_id = t.id JOIN menu_items mi ON td.menu_item_id = mi.id JOIN menu_recipes mr ON mr.menu_item_id = mi.id JOIN inventory inv ON inv.id = mr.inventory_id WHERE t.store_id = ${storeId} AND inv.store_id = ${storeId} AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE) GROUP BY inv.item_name, inv.unit ORDER BY estimasi_terpakai DESC;

Pertanyaan: "omzet per kategori bulan ini beserta persentasenya"
SQL: WITH total AS (SELECT COALESCE(SUM(total_amount),0) AS grand FROM transactions WHERE store_id = ${storeId} AND DATE_TRUNC('month', transaction_date) = DATE_TRUNC('month', CURRENT_DATE)) SELECT mc.name AS kategori, COALESCE(SUM(td.subtotal),0) AS total_omzet, CASE WHEN total.grand = 0 THEN NULL ELSE ROUND((COALESCE(SUM(td.subtotal),0) / total.grand * 100)::numeric, 2) END AS persen_kontribusi FROM transaction_details td JOIN transactions t ON td.transaction_id = t.id JOIN menu_items mi ON td.menu_item_id = mi.id JOIN menu_categories mc ON mi.category_id = mc.id, total WHERE t.store_id = ${storeId} AND mc.store_id = ${storeId} AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE) GROUP BY mc.name, total.grand ORDER BY total_omzet DESC;

============================
FORMAT OUTPUT
============================
- Kembalikan HANYA satu baris SQL mentah. Tanpa markdown, tanpa penjelasan.
- Akhiri dengan titik koma (;).
- Jika pertanyaan tidak bisa dijawab, kembalikan: SELECT 'PERTANYAAN_TIDAK_VALID' AS status;`;

        console.log("   [⏳ Step A: Generating SQL...]");
        const promptToSQL = `${SYSTEM_PROMPT}\n\nPertanyaan: "${message}"\nQuery SQL:`;
        let sqlQuery = await callNemotron(promptToSQL, false);
        sqlQuery = sqlQuery.replace(/```sql/ig, '').replace(/```/g, '').trim();

        // ── Validasi SQL (security) ───────────────────────────
        validateSQL(sqlQuery, storeId);
        console.log("   [💻 Execute SQL]:", sqlQuery);

        if (sqlQuery.includes('PERTANYAAN_TIDAK_VALID')) {
            return res.json({
                success: true,
                answer: "Mohon maaf, pertanyaan tersebut belum dapat dijawab dengan data yang tersedia. Silakan coba dengan pertanyaan yang berbeda.",
                sql: sqlQuery, rawData: []
            });
        }

        const dbResult = await sql.unsafe(sqlQuery);

        const safeData = dbResult.length > 15 ? dbResult.slice(0, 15) : dbResult;
        let dataToAI = JSON.stringify(safeData);
        if (dbResult.length > 15) {
            dataToAI += `\n(Catatan: Ditampilkan 15 data teratas dari total ${dbResult.length} baris.)`;
        }

        // ── Inject konteks rentang data jika hasil kosong ─────
        let dataRangeContext = '';
        const isEmptyOrZero = safeData.length === 0 ||
            safeData.every(row => Object.values(row).every(v => v === null || v === 0 || v === '0'));

        if (isEmptyOrZero) {
            const range = await getDataRange(storeId);
            if (range?.total_transaksi > 0) {
                dataRangeContext = `\nINFO: Database memiliki ${range.total_transaksi} transaksi dari ${range.tanggal_pertama} hingga ${range.tanggal_terakhir}. Periode yang ditanyakan kemungkinan belum memiliki transaksi.`;
            }
        }

        // ══════════════════════════════════════════════════════
        // 🧠 STEP C: SUMMARY GENERATOR
        // ══════════════════════════════════════════════════════
        console.log("   [⏳ Step C: Generating answer...]");
        const promptToSummary = `
Kamu adalah Tantri, Asisten Analis Data untuk ${storeName} — profesional, terpercaya, dan informatif.
Tugasmu: menyampaikan laporan data operasional kepada pemilik usaha secara jelas, formal, dan mudah dipahami.

Pertanyaan: "${message}"
Data dari database: ${dataToAI}${dataRangeContext}

RIWAYAT PERCAKAPAN SEBELUMNYA:
${conversationHistory || '(Tidak ada riwayat)'}

ATURAN PENYAMPAIAN:
1. Bahasa Indonesia yang baku dan profesional. Dilarang: "Bos", "Kak", "Gan", "Sis", atau sapaan informal.
2. Awali langsung pada inti laporan — tidak perlu basa-basi.
3. Jika data tersedia: sampaikan terstruktur + satu insight bisnis singkat yang actionable.
4. Jika data kosong/nol: jelaskan dengan sopan + sertakan rentang data yang tersedia (dari INFO jika ada).
5. Format angka ke Rupiah (Rp 1.250.000). Persentase dengan simbol % (23,5%).
6. DILARANG tampilkan JSON, kode, atau simbol teknis.
7. DILARANG mengarang angka yang tidak ada di data.
8. Daftar gunakan nomor urut yang rapi.
9. Jika ada kolom persentase_perubahan: jelaskan naik/turun dengan kalimat informatif.
10. Jika pertanyaan adalah follow-up, gunakan konteks riwayat percakapan untuk menjawab dengan tepat.`;

        const finalAnswer = await callNemotron(promptToSummary, true);

        // ── Simpan ke session ─────────────────────────────────
        updateSession(phone, message, finalAnswer);

        console.log("   [✅ Done]");
        res.json({ success: true, answer: finalAnswer, sql: sqlQuery, rawData: safeData });

    } catch (error) {
        console.error("❌ Error:", error.message);
        res.status(500).json({
            success: false,
            answer: "Mohon maaf, terjadi kendala teknis. Silakan coba beberapa saat lagi.",
            error: error.message
        });
    }
});

// ==========================================
// HEALTH CHECK ENDPOINT
// ==========================================
app.get('/health', (req, res) => {
    res.json({ status: 'ok', activeSessions: sessionStore.size });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
=========================================
🚀 SERVER NVIDIA NEMOTRON AKTIF
🔗 Akses di: http://localhost:${PORT}
👥 Mode: Multi-Tenant
=========================================
    `);
});