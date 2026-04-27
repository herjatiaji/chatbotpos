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
// ==========================================
const rateLimitMap = new Map();
function isRateLimited(storeId) {
    const now = Date.now();
    const windowMs = 60 * 1000;
    const maxRequests = 20;
    if (!rateLimitMap.has(storeId)) rateLimitMap.set(storeId, []);
    const timestamps = rateLimitMap.get(storeId).filter(t => now - t < windowMs);
    timestamps.push(now);
    rateLimitMap.set(storeId, timestamps);
    return timestamps.length > maxRequests;
}

// ==========================================
// MULTI-TENANT: Session/conversation context
// ==========================================
const sessionStore = new Map();
const MAX_HISTORY = 5;
const SESSION_TTL = 30 * 60 * 1000;

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
    if (session.history.length > MAX_HISTORY * 2) {
        session.history = session.history.slice(-MAX_HISTORY * 2);
    }
    session.lastActive = Date.now();
    sessionStore.set(phone, session);
}

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
    for (const pattern of FORBIDDEN_SQL_KEYWORDS) {
        if (pattern.test(sqlQuery)) throw new Error('SQL tidak aman: mengandung keyword terlarang.');
    }
    if (!/^\s*(?:WITH\s+\w|SELECT\s)/i.test(sqlQuery)) {
        throw new Error('SQL tidak aman: hanya SELECT atau CTE yang diizinkan.');
    }
    const storeIdPattern = new RegExp(`store_id\\s*=\\s*${storeId}(?!\\d)`);
    if (!storeIdPattern.test(sqlQuery)) {
        throw new Error(`SQL tidak aman: tidak ada filter store_id = ${storeId}.`);
    }
}

// ==========================================
// AI ENGINE
// ==========================================
async function callNemotron(promptText, enableThinking = false, retries = 3, delay = 5000) {
    if (!process.env.NVIDIA_API_KEY) throw new Error('NVIDIA_API_KEY kosong!');

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
            let reasoningBuffer = '';
            for await (const chunk of stream) {
                const delta = chunk.choices[0]?.delta;
                // Skip reasoning_content — hanya ambil content final
                if (delta?.reasoning_content) {
                    reasoningBuffer += delta.reasoning_content;
                }
                if (delta?.content) {
                    fullContent += delta.content;
                }
            }
            // Bersihkan sisa thinking yang bocor ke content (pola bahasa Inggris di awal)
            let cleaned = fullContent.trim();
            // Hapus blok <think>...</think> jika ada
            cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
            // Hapus baris-baris awal yang seluruhnya bahasa Inggris (reasoning bocor)
            const lines = cleaned.split('\n');
            const firstIdLines = lines.findIndex(l => /[a-zA-Z]{4,}/.test(l) === false || /[\u00C0-\u024F\u1E00-\u1EFF]/.test(l) || /^[^a-zA-Z]*$/.test(l));
            return cleaned;

        } catch (error) {
            console.log(`   [⚠️ API Error] Percobaan ${i + 1}/${retries}: ${error.message}`);
            const isOverload = error.status === 503 || error.status === 429 ||
                               error.message?.includes('503') || error.message?.includes('429');
            if (i === retries - 1 || !isOverload) throw new Error('Gagal menghubungi server AI.');
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
// HELPER: Deteksi apakah pesan adalah nota/struk
// Format yang didukung:
// - "nota: item1 x qty harga, item2 x qty harga"
// - Teks bebas berisi daftar item & harga
// ==========================================
function isNota(message) {
    const notaPatterns = [
        /nota[:\s]/i,
        /struk[:\s]/i,
        /receipt[:\s]/i,
        /baca\s+nota/i,
        /input\s+nota/i,
        /catat\s+nota/i,
        // Deteksi pola item x qty = harga
        /\d+\s*[xX]\s*\d+/,
        /rp\.?\s*\d{3,}/i,
    ];
    return notaPatterns.some(p => p.test(message.trim()));
}

// ==========================================
// PARSER NOTA: Ekstrak item dari teks nota
// ==========================================
async function parseNota(notaText, storeId) {
    const prompt = `
Kamu adalah parser nota/struk belanja yang akurat.
Tugasmu: ekstrak semua item dari teks nota berikut dan kembalikan HANYA JSON array.

Format JSON yang WAJIB dikembalikan (tanpa markdown, tanpa penjelasan):
[
  {
    "nama_item": "nama barang",
    "qty": angka,
    "harga_satuan": angka,
    "subtotal": angka,
    "kategori_perkiraan": "bahan_baku | menu | operasional | lainnya"
  }
]

Aturan:
- Jika qty tidak disebutkan, asumsikan 1
- Jika harga satuan tidak ada tapi subtotal ada, hitung: harga_satuan = subtotal / qty
- Jika subtotal tidak ada, hitung: subtotal = qty * harga_satuan
- Buang karakter mata uang (Rp, IDR) dari angka
- kategori_perkiraan: tebak berdasarkan nama item (kopi/gula/susu = bahan_baku, dll)
- Kembalikan array kosong [] jika tidak ada item yang bisa diekstrak

Teks nota:
${notaText}

JSON:`;

    const result = await callNemotron(prompt, false);
    try {
        const cleaned = result.replace(/```json/ig, '').replace(/```/g, '').trim();
        return JSON.parse(cleaned);
    } catch {
        return [];
    }
}

// ==========================================
// HELPER: Deteksi apakah pertanyaan tentang HPP
// ==========================================
function isHPPQuestion(message) {
    const hppPatterns = [
        /\bhpp\b/i,
        /harga\s+pokok/i,
        /cost\s+of\s+goods/i,
        /biaya\s+produksi/i,
        /margin\s+(kotor|bersih|keuntungan)/i,
        /keuntungan\s+(kotor|bersih|per\s+menu)/i,
        /berapa\s+(untung|profit|margin)/i,
        /profit\s+margin/i,
        /mark.?up/i,
    ];
    return hppPatterns.some(p => p.test(message.trim()));
}

// ==========================================
// HPP CALCULATOR: Hitung HPP & margin per menu
// Mengambil data nyata dari DB: resep, harga jual, dan
// referensi harga bahan dari cash_logs (jika tersedia)
// ==========================================
async function hitungHPP(storeId, menuKeyword = null) {
    // Query 1: Resep + harga jual per menu
    const menuFilter = menuKeyword ? `AND mi.name ILIKE '%${menuKeyword}%'` : '';
    const resepData = await sql.unsafe(`
        SELECT
            mi.id       AS menu_id,
            mi.name     AS nama_menu,
            mi.price    AS harga_jual,
            inv.item_name AS bahan,
            inv.unit,
            mr.qty_used
        FROM menu_items mi
        JOIN menu_recipes mr ON mr.menu_item_id = mi.id
        JOIN inventory inv   ON inv.id = mr.inventory_id
        WHERE mi.store_id = ${storeId}
        ${menuFilter}
        ORDER BY mi.name, inv.item_name
    `);

    // Query 2: Referensi harga bahan dari cash_logs
    // Cari pengeluaran yang deskripsinya mengandung nama bahan
    const hargaRef = await sql.unsafe(`
        SELECT
            inv.item_name,
            inv.unit,
            cl.amount       AS total_bayar,
            cl.description  AS keterangan,
            cl.created_at   AS tanggal_beli
        FROM cash_logs cl
        JOIN inventory inv ON cl.description ILIKE '%' || inv.item_name || '%'
        WHERE cl.store_id = ${storeId}
        AND cl.type = 'out'
        ORDER BY cl.created_at DESC
    `);

    // Susun struktur: per menu → list bahan + referensi harga
    const menuMap = {};
    for (const row of resepData) {
        if (!menuMap[row.nama_menu]) {
            menuMap[row.nama_menu] = {
                nama_menu: row.nama_menu,
                harga_jual: Number(row.harga_jual),
                bahan: []
            };
        }
        // Cari referensi harga dari cash_logs
        const ref = hargaRef.filter(h => h.item_name === row.bahan);
        menuMap[row.nama_menu].bahan.push({
            nama: row.bahan,
            qty_used: Number(row.qty_used),
            unit: row.unit,
            referensi_harga_dari_cashlog: ref.length > 0
                ? ref.slice(0, 2).map(r => ({
                    total_bayar: Number(r.total_bayar),
                    keterangan: r.keterangan,
                    tanggal: r.tanggal_beli
                  }))
                : null
        });
    }

    return Object.values(menuMap);
}

// ==========================================
// API ENDPOINT — MAIN CHAT
// ==========================================
app.post('/api/chat', async (req, res) => {
    const { message, phone } = req.body;

    if (!message || !phone) {
        return res.status(400).json({ success: false, answer: "Parameter 'message' dan 'phone' wajib diisi." });
    }

    try {
        console.log(`\n💬 [${phone}] "${message}"`);

        const userCheck = await sql`
            SELECT u.owner_name, u.store_id, s.store_name 
            FROM whatsapp_users u 
            JOIN stores s ON u.store_id = s.id 
            WHERE u.phone_number = ${phone}
        `;

        if (userCheck.length === 0) {
            return res.status(403).json({ success: false, answer: "Mohon maaf, nomor Anda tidak terdaftar dalam sistem Kazeer AI." });
        }

        const activeUser = userCheck[0];
        const storeId = activeUser.store_id;
        const storeName = activeUser.store_name;

        // ── Rate limiting ─────────────────────────────────────
        if (isRateLimited(storeId)) {
            return res.status(429).json({
                success: false,
                answer: "⏳ Terlalu banyak permintaan dalam waktu singkat. Silakan tunggu sebentar sebelum mencoba kembali."
            });
        }

        // ── Chitchat guard ────────────────────────────────────
        if (isChitchat(message)) {
            return res.json({
                success: true,
                answer: `🤖 *Kazeer AI*\n\nHalo! Saya adalah Kazeer, bot AI Business Consultant kamu untuk ${storeName}.\n\n💡 Saya bisa membantu kamu dengan:\n• 📊 Analisis omzet & transaksi\n• 🏆 Menu terlaris & performa penjualan\n• 📦 Stok & bahan baku\n• 💰 Laporan laba rugi\n• 🧾 Baca & analisis nota belanja\n• 📈 Hitung HPP & margin keuntungan\n\nSilakan ajukan pertanyaan bisnis kamu! 🚀`,
                sql: null,
                rawData: []
            });
        }

        const session = getSession(phone);
        const conversationHistory = session.history
            .map(h => `${h.role === 'user' ? 'Owner' : 'Kazeer'}: ${h.content}`)
            .join('\n');

        // ══════════════════════════════════════════════════════
        // 🧾 FLOW: PARSER NOTA
        // ══════════════════════════════════════════════════════
        if (isNota(message)) {
            console.log("   [🧾 Nota terdeteksi — parsing...]");
            const items = await parseNota(message, storeId);

            if (items.length === 0) {
                return res.json({
                    success: true,
                    answer: "⚠️ Maaf, saya tidak berhasil membaca nota tersebut.\n\nCoba format seperti ini:\n```\nnota:\n- Kopi Arabika 500gr x 2 = Rp 90.000\n- Gula Pasir 1kg x 1 = Rp 15.000\n```",
                    sql: null,
                    rawData: []
                });
            }

            const totalNota = items.reduce((sum, i) => sum + (i.subtotal || 0), 0);

            // Kirim ke AI untuk analisis
            const notaPrompt = `
WAJIB: Seluruh jawaban dalam Bahasa Indonesia. DILARANG menggunakan Bahasa Inggris.

Kamu adalah Kazeer, bot AI Business Consultant yang profesional.
Kamu baru saja membaca nota belanja dari ${storeName}.

Data item yang berhasil diekstrak:
${JSON.stringify(items, null, 2)}

Total nota: Rp ${totalNota.toLocaleString('id-ID')}

Tugas kamu:
1. Tampilkan ringkasan item yang berhasil dibaca dengan format rapi + emoji
2. Tampilkan total belanja
3. Kelompokkan per kategori (bahan_baku, operasional, dll)
4. Berikan 1-2 insight bisnis singkat (apakah pengeluaran ini wajar? ada yang perlu diperhatikan?)
5. Tanyakan apakah owner ingin mencatat pengeluaran ini ke cash_logs

Format jawaban: gunakan paragraf pendek, emoji yang relevan, dan poin-poin singkat.
Gunakan bahasa Indonesia yang profesional namun ramah — bukan formal kaku.
JANGAN tampilkan JSON mentah.`;

            const notaAnswer = await callNemotron(notaPrompt, true);
            updateSession(phone, message, notaAnswer);

            return res.json({
                success: true,
                answer: notaAnswer,
                sql: null,
                rawData: items,
                notaParsed: true
            });
        }

        // ══════════════════════════════════════════════════════
        // 📈 FLOW: HPP & MARGIN CALCULATOR
        // ══════════════════════════════════════════════════════
        if (isHPPQuestion(message)) {
            console.log("   [📈 HPP question terdeteksi — thinking mode ON...]");

            // Ambil data resep menu dari DB
            const menuKeywordMatch = message.match(/(?:hpp|margin|untung|profit).*?(?:menu\s+)?["']?([a-zA-Z\s]+)["']?/i);
            const menuKeyword = menuKeywordMatch ? menuKeywordMatch[1].trim() : null;

            const hppData = await hitungHPP(storeId, menuKeyword);

            const hppPrompt = `
WAJIB: Seluruh jawaban dalam Bahasa Indonesia. DILARANG menggunakan Bahasa Inggris.

Kamu adalah Kazeer, bot AI Business Consultant untuk ${storeName}.
Pertanyaan owner: "${message}"

Berikut data NYATA dari database — resep menu beserta referensi harga bahan dari catatan pembelian (cash_logs):
${JSON.stringify(hppData, null, 2)}

CARA MENGHITUNG HPP:
Untuk setiap bahan dalam menu:
- Jika "referensi_harga_dari_cashlog" tersedia → gunakan total_bayar dari sana sebagai referensi harga beli
- Jika "referensi_harga_dari_cashlog" = null → JANGAN mengarang harga. Tulis: "harga [nama bahan] tidak ditemukan di catatan pembelian"
- HPP per bahan = (qty_used / total_qty_beli) × total_bayar — estimasikan berdasarkan proporsi qty_used

TUGAS (gunakan data di atas, JANGAN berasumsi di luar data):
1. 🧮 Hitung HPP per menu berdasarkan data referensi harga yang tersedia
2. 💰 Hitung margin kotor: ((harga_jual - HPP) / harga_jual) × 100%
3. 📊 Kategorikan: Rendah < 30%, Sedang 30–60%, Tinggi > 60%
4. 🏆 Sebutkan menu paling menguntungkan berdasarkan data
5. ⚠️ Flagging menu margin rendah atau bahan yang harganya tidak tercatat
6. 💡 Berikan 2–3 rekomendasi bisnis yang spesifik dan actionable

ATURAN FORMAT (WAJIB DIIKUTI):
- DILARANG menggunakan tanda bintang (*) atau markdown bold (**teks**) dalam jawaban
- DILARANG menggunakan bullet • — gunakan angka (1. 2. 3.) atau baris baru saja
- Setiap poin diawali emoji, diikuti teks langsung tanpa tanda baca dekoratif
- Pisahkan setiap poin dengan satu baris kosong
- Format Rupiah: Rp 15.000 | Persentase: 45,5%
- Jika ada bahan tanpa referensi harga, sebutkan dengan jelas di output
- Jangan tampilkan JSON mentah`;

            const hppAnswer = await callNemotron(hppPrompt, true); // thinking ON
            updateSession(phone, message, hppAnswer);

            return res.json({
                success: true,
                answer: hppAnswer,
                sql: null,
                rawData: hppData,
                hppCalculated: true
            });
        }

        // ══════════════════════════════════════════════════════
        // 🧠 FLOW UTAMA: SQL → DB → ANSWER
        // ══════════════════════════════════════════════════════
        const today = new Date().toISOString().split('T')[0];

        const SYSTEM_PROMPT = `
Kamu adalah AI SQL Generator khusus untuk sistem cafe berbasis PostgreSQL.
Tugas SATU-SATUNYA: menghasilkan query SQL yang valid, aman, akurat, dan efisien.

Kamu sedang melayani: ${storeName} (store_id = ${storeId})
Hari ini: ${today}

============================
KONTEKS PERCAKAPAN SEBELUMNYA
============================
${conversationHistory || '(Tidak ada riwayat percakapan sebelumnya)'}
Gunakan konteks di atas jika pertanyaan saat ini adalah follow-up (ada kata "itu", "tadi", "lalu bagaimana", "bandingkan").

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
| "sekarang", "saat ini", "kini"                | DATE_TRUNC('month', ...) = DATE_TRUNC('month', CURRENT_DATE)  ← BULAN INI                        |
| "total", "keseluruhan", "semua", "sepanjang"  | TANPA filter tanggal                                                                             |
| "kuartal ini"                                 | EXTRACT(QUARTER FROM ...) = EXTRACT(QUARTER FROM CURRENT_DATE) AND EXTRACT(YEAR ...) = EXTRACT(YEAR FROM CURRENT_DATE) |
| "kuartal lalu"                                | Gunakan CURRENT_DATE - INTERVAL '3 months'                                                       |

NAMA BULAN: Jan=1 Feb=2 Mar=3 Apr=4 Mei=5 Jun=6 Jul=7 Agt=8 Sep=9 Okt=10 Nov=11 Des=12
→ EXTRACT(MONTH FROM t.transaction_date) = [N] AND EXTRACT(YEAR FROM t.transaction_date) = EXTRACT(YEAR FROM CURRENT_DATE)

METODE PEMBAYARAN:
tunai/cash → ILIKE '%cash%' | transfer/bank → ILIKE '%transfer%' | qris/digital/ewallet → ILIKE '%qris%'

ATURAN KRITIS:
- "sekarang"/"saat ini" = BULAN INI, bukan hari ini.
- "total"/"keseluruhan" = HAPUS semua filter tanggal.
- DILARANG hardcode tahun/bulan. Pakai CURRENT_DATE atau EXTRACT().
- cash_logs gunakan cl.created_at.

============================
SKEMA DATABASE
============================
stores | menu_categories | menu_items | menu_recipes | inventory
transactions | transaction_details | cash_logs | whatsapp_users

============================
ALIAS WAJIB
============================
transactions→t | transaction_details→td | menu_items→mi
menu_categories→mc | inventory→inv | cash_logs→cl | menu_recipes→mr

============================
ATURAN WAJIB
============================
[1]  KEAMANAN: WAJIB store_id = ${storeId} pada: transactions, inventory, menu_items, menu_categories, cash_logs.
[2]  ALIAS: Gunakan alias wajib tanpa kecuali.
[3]  NULL-SAFE: COALESCE(..., 0) pada semua agregat.
[4]  NAMA KOLOM: Selalu deskriptif (AS total_omzet, AS nama_menu, dll.).
[5]  ILIKE: DILARANG = untuk nama menu/kategori.
[6]  MULTI-PERIODE: Gunakan CTE (WITH ... AS).
[7]  LABA/RUGI: pendapatan=SUM(t.total_amount), pengeluaran=SUM(cl.amount) WHERE cl.type='out'.
[8]  BAHAN TERPAKAI: SUM(td.qty * mr.qty_used) GROUP BY inv.item_name.
[9]  HARI: EXTRACT(DOW). 0=Minggu, 6=Sabtu.
[10] DIVISI NOL: CASE WHEN denominator=0 THEN NULL ELSE ROUND(n/d,2) END.
[11] RANKING: DENSE_RANK() OVER (ORDER BY ... DESC).
[12] MENU TIDAK TERJUAL: LEFT JOIN + WHERE td.id IS NULL.
[13] MULTI-KEYWORD: mi.name ILIKE '%a%' OR mi.name ILIKE '%b%'.
[14] FILTER NOMINAL: t.total_amount > [nilai].
[15] PER MEJA: t.table_number.
[16] RATA-RATA HARIAN: SUM / COUNT(DISTINCT t.transaction_date::date).
[17] KONTRIBUSI (%): Gunakan CTE atau subquery.
[18] FOLLOW-UP: Gunakan konteks percakapan jika ada kata "itu", "tadi", "lalu", "bandingkan".
[19] NOTES: Jangan sertakan kecuali diminta.

============================
CONTOH QUERY (FEW-SHOT)
============================

Pertanyaan: "total pendapatan keseluruhan"
SQL: SELECT COALESCE(SUM(t.total_amount),0) AS total_pendapatan, COUNT(t.id) AS total_transaksi FROM transactions t WHERE t.store_id = ${storeId};

Pertanyaan: "total pendapatan sekarang"
SQL: SELECT COALESCE(SUM(t.total_amount),0) AS total_pendapatan, COUNT(t.id) AS total_transaksi FROM transactions t WHERE t.store_id = ${storeId} AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE);

Pertanyaan: "total pendapatan hari ini"
SQL: SELECT COALESCE(SUM(t.total_amount),0) AS total_pendapatan, COUNT(t.id) AS total_transaksi FROM transactions t WHERE t.store_id = ${storeId} AND t.transaction_date::date = CURRENT_DATE;

Pertanyaan: "5 menu terlaris bulan ini"
SQL: SELECT mi.name AS nama_menu, COALESCE(SUM(td.qty),0) AS total_porsi, COALESCE(SUM(td.subtotal),0) AS total_pendapatan FROM transaction_details td JOIN transactions t ON td.transaction_id = t.id JOIN menu_items mi ON td.menu_item_id = mi.id WHERE t.store_id = ${storeId} AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE) GROUP BY mi.name ORDER BY total_porsi DESC LIMIT 5;

Pertanyaan: "omzet minggu ini vs minggu lalu"
SQL: WITH minggu_ini AS (SELECT COALESCE(SUM(t.total_amount),0) AS omzet FROM transactions t WHERE t.store_id = ${storeId} AND DATE_TRUNC('week', t.transaction_date) = DATE_TRUNC('week', CURRENT_DATE)), minggu_lalu AS (SELECT COALESCE(SUM(t.total_amount),0) AS omzet FROM transactions t WHERE t.store_id = ${storeId} AND DATE_TRUNC('week', t.transaction_date) = DATE_TRUNC('week', CURRENT_DATE - INTERVAL '1 week')) SELECT a.omzet AS omzet_minggu_ini, b.omzet AS omzet_minggu_lalu, (a.omzet - b.omzet) AS selisih, CASE WHEN b.omzet = 0 THEN NULL ELSE ROUND(((a.omzet - b.omzet) / b.omzet * 100)::numeric, 2) END AS persentase_perubahan FROM minggu_ini a, minggu_lalu b;

Pertanyaan: "rekap laba rugi bulan ini"
SQL: WITH pendapatan AS (SELECT COALESCE(SUM(t.total_amount),0) AS total FROM transactions t WHERE t.store_id = ${storeId} AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE)), pengeluaran AS (SELECT COALESCE(SUM(cl.amount),0) AS total FROM cash_logs cl WHERE cl.store_id = ${storeId} AND cl.type = 'out' AND DATE_TRUNC('month', cl.created_at) = DATE_TRUNC('month', CURRENT_DATE)) SELECT p.total AS total_pendapatan, k.total AS total_pengeluaran, (p.total - k.total) AS laba_bersih FROM pendapatan p, pengeluaran k;

Pertanyaan: "menu yang belum pernah terjual bulan ini"
SQL: SELECT mi.name AS nama_menu, mi.price AS harga FROM menu_items mi LEFT JOIN (SELECT td.menu_item_id FROM transaction_details td JOIN transactions t ON td.transaction_id = t.id WHERE t.store_id = ${storeId} AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE)) sold ON mi.id = sold.menu_item_id WHERE mi.store_id = ${storeId} AND sold.menu_item_id IS NULL ORDER BY mi.name;

Pertanyaan: "estimasi bahan terpakai bulan ini"
SQL: SELECT inv.item_name AS bahan_baku, inv.unit, COALESCE(SUM(td.qty * mr.qty_used),0) AS estimasi_terpakai FROM transaction_details td JOIN transactions t ON td.transaction_id = t.id JOIN menu_items mi ON td.menu_item_id = mi.id JOIN menu_recipes mr ON mr.menu_item_id = mi.id JOIN inventory inv ON inv.id = mr.inventory_id WHERE t.store_id = ${storeId} AND inv.store_id = ${storeId} AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE) GROUP BY inv.item_name, inv.unit ORDER BY estimasi_terpakai DESC;

============================
FORMAT OUTPUT
============================
- Kembalikan HANYA satu baris SQL mentah. Tanpa markdown, tanpa penjelasan.
- Akhiri dengan titik koma (;).
- Jika tidak bisa dijawab: SELECT 'PERTANYAAN_TIDAK_VALID' AS status;`;

        console.log("   [⏳ Step A: Generating SQL...]");
        const promptToSQL = `${SYSTEM_PROMPT}\n\nPertanyaan: "${message}"\nQuery SQL:`;
        let sqlQuery = await callNemotron(promptToSQL, false);
        sqlQuery = sqlQuery.replace(/```sql/ig, '').replace(/```/g, '').trim();

        validateSQL(sqlQuery, storeId);
        console.log("   [💻 Execute SQL]:", sqlQuery);

        if (sqlQuery.includes('PERTANYAAN_TIDAK_VALID')) {
            return res.json({
                success: true,
                answer: "⚠️ Maaf, pertanyaan tersebut belum bisa dijawab dengan data yang tersedia.\n\nCoba tanyakan dengan cara yang berbeda, atau ketik *bantuan* untuk melihat contoh pertanyaan yang bisa saya jawab. 😊",
                sql: sqlQuery, rawData: []
            });
        }

        const dbResult = await sql.unsafe(sqlQuery);

        const safeData = dbResult.length > 15 ? dbResult.slice(0, 15) : dbResult;
        let dataToAI = JSON.stringify(safeData);
        if (dbResult.length > 15) {
            dataToAI += `\n(Catatan: Ditampilkan 15 data teratas dari total ${dbResult.length} baris.)`;
        }

        // Inject konteks rentang data jika kosong
        let dataRangeContext = '';
        const isEmptyOrZero = safeData.length === 0 ||
            safeData.every(row => Object.values(row).every(v => v === null || v === 0 || v === '0'));

        if (isEmptyOrZero) {
            const range = await getDataRange(storeId);
            if (range?.total_transaksi > 0) {
                dataRangeContext = `\nINFO: Database memiliki ${range.total_transaksi} transaksi dari ${range.tanggal_pertama} hingga ${range.tanggal_terakhir}. Periode yang ditanyakan kemungkinan belum ada transaksinya.`;
            }
        }

        // 🧠 STEP C: KAZEER ANSWER GENERATOR
        console.log("   [⏳ Step C: Kazeer menyusun jawaban...]");
        const promptToSummary = `
WAJIB: Seluruh jawaban dalam Bahasa Indonesia. DILARANG menggunakan Bahasa Inggris dalam jawaban akhir.

Kamu adalah Kazeer, bot AI Business Consultant untuk ${storeName}.
Kamu pintar, informatif, dan selalu memberikan insight bisnis yang valuable — seperti ChatGPT tapi khusus untuk bisnis cafe/resto.

Pertanyaan: "${message}"
Data dari database: ${dataToAI}${dataRangeContext}

Riwayat percakapan:
${conversationHistory || '(Tidak ada riwayat)'}

CARA MENJAWAB:
1. Setiap poin diawali emoji yang relevan, diikuti teks langsung
2. Pisahkan setiap poin dengan satu baris kosong agar mudah dibaca
3. Maksimal 2-3 kalimat per poin — jangan wall of text
4. Selalu akhiri dengan 1 insight bisnis yang actionable dan spesifik
5. Bahasa Indonesia yang profesional tapi tetap ramah
6. Format Rupiah: Rp 1.250.000 | Persentase: 23,5%
7. Untuk daftar atau ranking: gunakan angka (1. 2. 3.) bukan bullet
8. Jika data kosong: jelaskan dengan sopan + sebutkan rentang data yang tersedia
9. Jika ada persentase naik/turun: jelaskan artinya dalam konteks bisnis
10. Jika pertanyaan adalah follow-up: jawab mengacu konteks sebelumnya

DILARANG KERAS:
- Menggunakan tanda bintang (*) atau markdown bold (**teks**) dalam jawaban
- Menampilkan JSON, kode teknis, atau simbol programming
- Mengarang angka yang tidak ada di data`;

        const finalAnswer = await callNemotron(promptToSummary, true);
        updateSession(phone, message, finalAnswer);

        console.log("   [✅ Done]");
        res.json({ success: true, answer: finalAnswer, sql: sqlQuery, rawData: safeData });

    } catch (error) {
        console.error("❌ Error:", error.message);
        res.status(500).json({
            success: false,
            answer: "⚠️ Maaf, terjadi kendala teknis saat memproses permintaan kamu.\n\nSilakan coba beberapa saat lagi. 🙏",
            error: error.message
        });
    }
});

// ==========================================
// ENDPOINT: Simpan hasil parsing nota ke cash_logs
// ==========================================
app.post('/api/catat-nota', async (req, res) => {
    const { phone, items, description } = req.body;

    try {
        const userCheck = await sql`
            SELECT u.store_id FROM whatsapp_users u WHERE u.phone_number = ${phone}
        `;
        if (userCheck.length === 0) return res.status(403).json({ success: false });

        const storeId = userCheck[0].store_id;
        const total = items.reduce((sum, i) => sum + (i.subtotal || 0), 0);

        await sql`
            INSERT INTO cash_logs (store_id, type, amount, description, created_at)
            VALUES (${storeId}, 'out', ${total}, ${description || 'Pengeluaran dari nota'}, NOW())
        `;

        res.json({ success: true, message: `✅ Nota berhasil dicatat ke kas. Total: Rp ${total.toLocaleString('id-ID')}` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// HEALTH CHECK
// ==========================================
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        app: 'Kazeer AI',
        version: '2.0.0',
        activeSessions: sessionStore.size,
        timestamp: new Date().toISOString()
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔════════════════════════════════════════╗
║        🤖 KAZEER AI v2.0.0            ║
║        Business Consultant Bot        ║
╠════════════════════════════════════════╣
║  🔗 Port    : ${PORT}                    ║
║  👥 Mode    : Multi-Tenant            ║
║  🧠 Engine  : NVIDIA Nemotron         ║
║  📦 Features: SQL · Nota · HPP       ║
╚════════════════════════════════════════╝
    `);
});