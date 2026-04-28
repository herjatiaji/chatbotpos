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
    if (!session) return { history: [], lastActive: Date.now(), pendingNota: null };
    if (Date.now() - session.lastActive > SESSION_TTL) {
        sessionStore.delete(phone);
        return { history: [], lastActive: Date.now(), pendingNota: null };
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
    const isFallback = sqlQuery.includes('PERTANYAAN_TIDAK_VALID') || sqlQuery.includes('PARSING_NOTA');
    const storeIdPattern = new RegExp(`store_id\\s*=\\s*${storeId}(?!\\d)`);
    if (!storeIdPattern.test(sqlQuery) && !isFallback) {
        throw new Error(`SQL tidak aman: tidak ada filter store_id = ${storeId}.`);
    }
}

// ==========================================
// ==========================================
// DUAL-MODEL ENGINE
// ─────────────────────────────────────────
// callSQL()  → Llama 4 Maverick
//              lebih cepat di NIM endpoint
//              khusus SQL generation
//
// callChat() → DeepSeek R1
//              reasoning kuat, thinking mode
//              untuk summary, HPP, nota
// ==========================================

const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

// Core streaming fetch — dipakai oleh callSQL dan callChat
async function callNIM(model, promptText, temperature = 0.1, retries = 3, delay = 5000) {
    if (!process.env.NVIDIA_API_KEY) throw new Error('NVIDIA_API_KEY kosong!');

    const headers = {
        "Authorization": `Bearer ${process.env.NVIDIA_API_KEY}`,
        "Accept": "text/event-stream",
        "Content-Type": "application/json"
    };

    const payload = {
        model,
        "messages": [{ "role": "user", "content": promptText }],
        "max_tokens": 4096,
        temperature,
        "top_p": 0.95,
        "stream": true
    };

    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(NVIDIA_BASE_URL, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const isOverload = response.status === 503 || response.status === 429;
                if (i === retries - 1 || !isOverload) throw new Error(`HTTP ${response.status}`);
                console.log(`   [⚠️ ${model}] Server sibuk, retry dalam ${delay/1000}s...`);
                await new Promise(res => setTimeout(res, delay));
                delay *= 2;
                continue;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let fullContent = '';
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const dataStr = line.substring(6).trim();
                    if (dataStr === '[DONE]') continue;
                    try {
                        const parsed = JSON.parse(dataStr);
                        const content = parsed.choices?.[0]?.delta?.content;
                        if (content) fullContent += content;
                    } catch (e) {}
                }
            }

            return fullContent.trim();

        } catch (error) {
            console.log(`   [⚠️ API Error] Percobaan ${i+1}/${retries}: ${error.message}`);
            if (i === retries - 1) throw new Error('Gagal menghubungi server AI.');
            await new Promise(res => setTimeout(res, delay));
            delay *= 2;
        }
    }
}

// ── Model A: Llama 4 Maverick — SQL Generation ──
// Lebih cepat di NIM shared endpoint, deterministik
async function callSQL(promptText) {
    console.log('   [⚡ Llama 4 Maverick] Generating SQL...');
    return callNIM(
        'meta/llama-4-maverick-17b-128e-instruct',
        promptText,
        0.1   // temperature rendah = deterministik
    );
}

// ── Model B: DeepSeek R1 — Summary, HPP, Nota ──
// Reasoning model, thinking mode aktif, jawaban lebih cerdas
async function callChat(promptText) {
    console.log('   [🤔 DeepSeek R1] Thinking...');
    return callNIM(
        'deepseek-ai/deepseek-r1',
        promptText,
        0.6   // temperature lebih bebas = lebih natural
    );
}

// Backward-compat alias (untuk parseNota yang masih pakai callAI)
async function callAI(promptText, enableThinking = false) {
    if (enableThinking) return callChat(promptText);
    return callSQL(promptText);
}


    for (const row of resepData) {
        if (!menuMap[row.nama_menu]) {
            menuMap[row.nama_menu] = {
                nama_menu: row.nama_menu,
                harga_jual: Number(row.harga_jual),
                bahan: []
            };
        }
        menuMap[row.nama_menu].bahan.push({
            nama: row.nama_bahan,
            qty_used: Number(row.qty_used),
            unit: row.unit,
            stok_saat_ini: Number(row.current_stock)
        });
    }

    return {
        // Data resep per menu — terstruktur
        menu: Object.values(menuMap),
        // Semua catatan pengeluaran kas — AI yang matching ke bahan
        catatan_pembelian_kas: allCashOut.map(r => ({
            jumlah: Number(r.total_bayar),
            keterangan: r.keterangan,
            tanggal: r.tanggal
        }))
    };
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

        // ============================================
        // 🎮 DEMO MODE — paksa semua ID ke Store 1
        // Set DEMO_MODE = false untuk production
        // ============================================
        const DEMO_MODE = true;

        let activeUser;

        if (DEMO_MODE) {
            // Bypass DB — semua pengguna otomatis masuk Store 1
            activeUser = { owner_name: 'Demo Owner', store_id: 1, store_name: 'Bengkel Kopi' };
            console.log(`   [🎮 Demo] ${phone} → Store 1 (${activeUser.store_name})`);
        } else {
            const userCheck = await sql`
                SELECT u.owner_name, u.store_id, s.store_name 
                FROM whatsapp_users u 
                JOIN stores s ON u.store_id = s.id 
                WHERE u.phone_number = ${phone}
            `;

            if (userCheck.length === 0) {
                return res.status(403).json({ success: false, answer: "Mohon maaf, nomor Anda tidak terdaftar dalam sistem Kazeer AI." });
            }

            activeUser = userCheck[0];
        }

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
        // ✅ FLOW: KONFIRMASI SIMPAN NOTA
        // ══════════════════════════════════════════════════════
        if (message.toLowerCase() === 'simpan' && session.pendingNota) {
            console.log("   [📥 Menyimpan nota ke Database...]");
            const { total, description } = session.pendingNota;

            await sql`
                INSERT INTO cash_logs (store_id, type, amount, description, created_at)
                VALUES (${storeId}, 'out', ${total}, ${description}, NOW())
            `;

            session.pendingNota = null;
            sessionStore.set(phone, session);

            return res.json({
                success: true,
                answer: `✅ Pengeluaran sebesar Rp ${total.toLocaleString('id-ID')} berhasil dicatat ke laporan keuangan ${storeName}.\n\nAda lagi yang bisa Kazeer bantu?`,
                sql: null,
                rawData: []
            });
        }

        if (message.toLowerCase() === 'batal' && session.pendingNota) {
            session.pendingNota = null;
            sessionStore.set(phone, session);
            return res.json({
                success: true,
                answer: "Pencatatan nota dibatalkan. 👌",
                sql: null,
                rawData: []
            });
        }

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

            // Simpan ke session agar bisa dikonfirmasi dengan SIMPAN
            const itemDescription = items.map(i => `${i.nama_item} (${i.qty}x)`).join(', ');
            session.pendingNota = {
                items,
                total: totalNota,
                description: `Belanja: ${itemDescription}`
            };
            sessionStore.set(phone, session);

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

            const notaAnswer = await callChat(notaPrompt); // DeepSeek R1
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

            const hppAnswer = await callChat(hppPrompt); // DeepSeek R1 thinking
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

        // ── Inject skema dinamis per cafe ──────────────────────
        // Ambil kategori & sample menu dari DB cafe yang sedang dilayani
        // agar SQL generator tahu nama kategori yang benar
        let kategoriList = 'Kopi, Non-Kopi, Makanan Berat, Snack & Dessert'; // default fallback
        let menuSample = '';
        try {
            const [kategoriDB, sampleMenuDB] = await Promise.all([
                sql`SELECT name FROM menu_categories WHERE store_id = ${storeId} LIMIT 10`,
                sql`SELECT name FROM menu_items WHERE store_id = ${storeId} LIMIT 8`
            ]);
            if (kategoriDB.length > 0) kategoriList = kategoriDB.map(k => k.name).join(', ');
            if (sampleMenuDB.length > 0) menuSample = sampleMenuDB.map(m => m.name).join(', ');
        } catch (e) {
            console.log('   [⚠️ Schema fetch skip]', e.message);
        }

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

PEMETAAN KATEGORI MENU (SANGAT PENTING):
Nama kategori di database BUKAN "minuman" atau "makanan" — gunakan pemetaan ini:

| Kata user                                    | Filter kategori yang BENAR                                        |
|----------------------------------------------|-------------------------------------------------------------------|
| "minuman", "drink", "minum"                  | mc.name ILIKE '%kopi%' OR mc.name ILIKE '%non%'                   |
| "kopi", "coffee"                             | mc.name ILIKE '%kopi%' AND mc.name NOT ILIKE '%non%'              |
| "non kopi", "non-kopi", "bukan kopi"         | mc.name ILIKE '%non%'                                             |
| "makanan", "food", "makan"                   | mc.name ILIKE '%makan%' OR mc.name ILIKE '%snack%'                |
| "makanan berat", "main course", "nasi", "mie"| mc.name ILIKE '%makan%'                                           |
| "snack", "cemilan", "dessert"                | mc.name ILIKE '%snack%'                                           |
| (tidak ada filter kategori)                  | JANGAN JOIN ke menu_categories — query semua menu langsung        |

KATEGORI MENU AKTUAL DI DATABASE CAFE INI:
${kategoriList}
${menuSample ? `CONTOH NAMA MENU: ${menuSample}` : ''}

ATURAN KATEGORI KRITIS:
- GUNAKAN nama kategori persis seperti di atas saat filter mc.name ILIKE.
- DILARANG hardcode nama kategori yang tidak ada di daftar atas.
- Jika user tanya "semua menu terlaris" tanpa sebut kategori → JANGAN JOIN menu_categories.

PEMETAAN KATA KEUANGAN (ROUTING KE QUERY YANG TEPAT):
| Kata kunci user                          | Query yang digunakan                                      |
|------------------------------------------|-----------------------------------------------------------|
| "untung", "laba", "profit", "keuntungan" | CTE: pendapatan - pengeluaran kas (laba/rugi)             |
| "rugi", "minus"                          | CTE: pendapatan - pengeluaran kas (laba/rugi)             |
| "pendapatan", "omzet", "pemasukan"       | SUM(t.total_amount) dari transactions                     |
| "pengeluaran", "biaya keluar", "expense" | SUM(cl.amount) WHERE cl.type='out' dari cash_logs         |
| "rekap keuangan", "laporan keuangan"     | CTE gabungan: pendapatan + pengeluaran + laba bersih      |
| "stok", "bahan baku", "laporan stok"     | SELECT dari inventory (current_stock)                     |

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
[8]  DATA KOSONG: Jangan kembalikan PERTANYAAN_TIDAK_VALID jika tabel relevan ada. Biarkan query tetap jalan meski data mungkin kosong.
[9]  BAHAN TERPAKAI: SUM(td.qty * mr.qty_used) GROUP BY inv.item_name.
[10] HARI: EXTRACT(DOW). 0=Minggu, 6=Sabtu.
[11] DIVISI NOL: CASE WHEN denominator=0 THEN NULL ELSE ROUND(n/d,2) END.
[12] RANKING: DENSE_RANK() OVER (ORDER BY ... DESC).
[13] MENU TIDAK TERJUAL: LEFT JOIN + WHERE td.id IS NULL.
[14] MULTI-KEYWORD: mi.name ILIKE '%a%' OR mi.name ILIKE '%b%'.
[15] FILTER NOMINAL: t.total_amount > [nilai].
[16] PER MEJA: t.table_number.
[17] RATA-RATA HARIAN: SUM / COUNT(DISTINCT t.transaction_date::date).
[18] KONTRIBUSI (%): Gunakan CTE atau subquery.
[19] FOLLOW-UP: Gunakan konteks percakapan jika ada kata "itu", "tadi", "lalu", "bandingkan".
[20] NOTES: Jangan sertakan kecuali diminta.

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

Pertanyaan: "minuman terlaris bulan ini" / "minuman paling laku"
SQL: SELECT mi.name AS nama_menu, COALESCE(SUM(td.qty),0) AS total_porsi, COALESCE(SUM(td.subtotal),0) AS total_pendapatan FROM transaction_details td JOIN transactions t ON td.transaction_id = t.id JOIN menu_items mi ON td.menu_item_id = mi.id JOIN menu_categories mc ON mi.category_id = mc.id WHERE t.store_id = ${storeId} AND (mc.name ILIKE '%kopi%' OR mc.name ILIKE '%non%') AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE) GROUP BY mi.name ORDER BY total_porsi DESC LIMIT 5;

Pertanyaan: "minuman terlaris minggu ini"
SQL: SELECT mi.name AS nama_menu, COALESCE(SUM(td.qty),0) AS total_porsi, COALESCE(SUM(td.subtotal),0) AS total_pendapatan FROM transaction_details td JOIN transactions t ON td.transaction_id = t.id JOIN menu_items mi ON td.menu_item_id = mi.id JOIN menu_categories mc ON mi.category_id = mc.id WHERE t.store_id = ${storeId} AND (mc.name ILIKE '%kopi%' OR mc.name ILIKE '%non%') AND DATE_TRUNC('week', t.transaction_date) = DATE_TRUNC('week', CURRENT_DATE) GROUP BY mi.name ORDER BY total_porsi DESC LIMIT 5;

Pertanyaan: "makanan terlaris bulan ini"
SQL: SELECT mi.name AS nama_menu, COALESCE(SUM(td.qty),0) AS total_porsi, COALESCE(SUM(td.subtotal),0) AS total_pendapatan FROM transaction_details td JOIN transactions t ON td.transaction_id = t.id JOIN menu_items mi ON td.menu_item_id = mi.id JOIN menu_categories mc ON mi.category_id = mc.id WHERE t.store_id = ${storeId} AND (mc.name ILIKE '%makan%' OR mc.name ILIKE '%snack%') AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE) GROUP BY mi.name ORDER BY total_porsi DESC LIMIT 5;

Pertanyaan: "omzet per kategori bulan ini"
SQL: WITH total AS (SELECT COALESCE(SUM(total_amount),0) AS grand FROM transactions WHERE store_id = ${storeId} AND DATE_TRUNC('month', transaction_date) = DATE_TRUNC('month', CURRENT_DATE)) SELECT mc.name AS kategori, COALESCE(SUM(td.subtotal),0) AS total_omzet, COALESCE(SUM(td.qty),0) AS total_porsi, CASE WHEN total.grand = 0 THEN NULL ELSE ROUND((COALESCE(SUM(td.subtotal),0) / total.grand * 100)::numeric, 2) END AS persen_kontribusi FROM transaction_details td JOIN transactions t ON td.transaction_id = t.id JOIN menu_items mi ON td.menu_item_id = mi.id JOIN menu_categories mc ON mi.category_id = mc.id, total WHERE t.store_id = ${storeId} AND mc.store_id = ${storeId} AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE) GROUP BY mc.name, total.grand ORDER BY total_omzet DESC;

Pertanyaan: "omzet minggu ini vs minggu lalu"
SQL: WITH minggu_ini AS (SELECT COALESCE(SUM(t.total_amount),0) AS omzet FROM transactions t WHERE t.store_id = ${storeId} AND DATE_TRUNC('week', t.transaction_date) = DATE_TRUNC('week', CURRENT_DATE)), minggu_lalu AS (SELECT COALESCE(SUM(t.total_amount),0) AS omzet FROM transactions t WHERE t.store_id = ${storeId} AND DATE_TRUNC('week', t.transaction_date) = DATE_TRUNC('week', CURRENT_DATE - INTERVAL '1 week')) SELECT a.omzet AS omzet_minggu_ini, b.omzet AS omzet_minggu_lalu, (a.omzet - b.omzet) AS selisih, CASE WHEN b.omzet = 0 THEN NULL ELSE ROUND(((a.omzet - b.omzet) / b.omzet * 100)::numeric, 2) END AS persentase_perubahan FROM minggu_ini a, minggu_lalu b;

Pertanyaan: "rekap laba rugi bulan ini"
SQL: WITH pendapatan AS (SELECT COALESCE(SUM(t.total_amount),0) AS total FROM transactions t WHERE t.store_id = ${storeId} AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE)), pengeluaran AS (SELECT COALESCE(SUM(cl.amount),0) AS total FROM cash_logs cl WHERE cl.store_id = ${storeId} AND cl.type = 'out' AND DATE_TRUNC('month', cl.created_at) = DATE_TRUNC('month', CURRENT_DATE)) SELECT p.total AS total_pendapatan, k.total AS total_pengeluaran, (p.total - k.total) AS laba_bersih FROM pendapatan p, pengeluaran k;

Pertanyaan: "menu yang belum pernah terjual bulan ini"
SQL: SELECT mi.name AS nama_menu, mi.price AS harga FROM menu_items mi LEFT JOIN (SELECT td.menu_item_id FROM transaction_details td JOIN transactions t ON td.transaction_id = t.id WHERE t.store_id = ${storeId} AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE)) sold ON mi.id = sold.menu_item_id WHERE mi.store_id = ${storeId} AND sold.menu_item_id IS NULL ORDER BY mi.name;

Pertanyaan: "estimasi bahan terpakai bulan ini"
SQL: SELECT inv.item_name AS bahan_baku, inv.unit, COALESCE(SUM(td.qty * mr.qty_used),0) AS estimasi_terpakai FROM transaction_details td JOIN transactions t ON td.transaction_id = t.id JOIN menu_items mi ON td.menu_item_id = mi.id JOIN menu_recipes mr ON mr.menu_item_id = mi.id JOIN inventory inv ON inv.id = mr.inventory_id WHERE t.store_id = ${storeId} AND inv.store_id = ${storeId} AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE) GROUP BY inv.item_name, inv.unit ORDER BY estimasi_terpakai DESC;

Pertanyaan: "berapa untung saya bulan ini" / "laba bulan ini" / "profit bulan ini"
SQL: WITH pendapatan AS (SELECT COALESCE(SUM(t.total_amount),0) AS total FROM transactions t WHERE t.store_id = ${storeId} AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE)), pengeluaran AS (SELECT COALESCE(SUM(cl.amount),0) AS total FROM cash_logs cl WHERE cl.store_id = ${storeId} AND cl.type = 'out' AND DATE_TRUNC('month', cl.created_at) = DATE_TRUNC('month', CURRENT_DATE)) SELECT p.total AS total_pendapatan, k.total AS total_pengeluaran, (p.total - k.total) AS laba_bersih FROM pendapatan p, pengeluaran k;

Pertanyaan: "laporan stok bahan baku" / "stok bahan"
SQL: SELECT inv.item_name AS bahan_baku, inv.current_stock AS stok_saat_ini, inv.unit FROM inventory inv WHERE inv.store_id = ${storeId} ORDER BY inv.current_stock ASC;

Pertanyaan: "stok bahan paling menipis"
SQL: SELECT inv.item_name AS bahan_baku, inv.current_stock AS stok_saat_ini, inv.unit FROM inventory inv WHERE inv.store_id = ${storeId} ORDER BY inv.current_stock ASC LIMIT 10;

Pertanyaan: "total pengeluaran kas bulan ini"
SQL: SELECT COALESCE(SUM(cl.amount),0) AS total_pengeluaran, COUNT(cl.id) AS jumlah_transaksi FROM cash_logs cl WHERE cl.store_id = ${storeId} AND cl.type = 'out' AND DATE_TRUNC('month', cl.created_at) = DATE_TRUNC('month', CURRENT_DATE);

Pertanyaan: "omzet per meja bulan ini"
SQL: SELECT t.table_number AS nomor_meja, COUNT(t.id) AS jumlah_transaksi, COALESCE(SUM(t.total_amount),0) AS total_omzet FROM transactions t WHERE t.store_id = ${storeId} AND t.order_type = 'dine_in' AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE) GROUP BY t.table_number ORDER BY total_omzet DESC;

Pertanyaan: "perbandingan dine-in vs takeaway bulan ini"
SQL: SELECT t.order_type, COUNT(t.id) AS jumlah_transaksi, COALESCE(SUM(t.total_amount),0) AS total_omzet, ROUND(COALESCE(AVG(t.total_amount),0)::numeric,0) AS rata_rata_transaksi FROM transactions t WHERE t.store_id = ${storeId} AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE) GROUP BY t.order_type ORDER BY total_omzet DESC;

Pertanyaan: "rata-rata omzet per hari bulan ini"
SQL: SELECT ROUND(COALESCE(SUM(t.total_amount),0) / NULLIF(COUNT(DISTINCT t.transaction_date::date), 0), 0) AS rata_rata_omzet_per_hari, COUNT(DISTINCT t.transaction_date::date) AS jumlah_hari_aktif FROM transactions t WHERE t.store_id = ${storeId} AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE);

Pertanyaan: "omzet akhir pekan vs hari kerja bulan ini"
SQL: WITH klasifikasi AS (SELECT CASE WHEN EXTRACT(DOW FROM t.transaction_date) IN (0,6) THEN 'Akhir Pekan' ELSE 'Hari Kerja' END AS tipe_hari, t.total_amount FROM transactions t WHERE t.store_id = ${storeId} AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE)) SELECT tipe_hari, COUNT(*) AS jumlah_transaksi, COALESCE(SUM(total_amount),0) AS total_omzet, ROUND(COALESCE(AVG(total_amount),0)::numeric,0) AS rata_rata_transaksi FROM klasifikasi GROUP BY tipe_hari ORDER BY total_omzet DESC;

============================
FORMAT OUTPUT
============================
- Kembalikan HANYA satu baris SQL mentah. Tanpa markdown, tanpa penjelasan.
- Akhiri dengan titik koma (;).
- Jika tidak bisa dijawab: SELECT 'PERTANYAAN_TIDAK_VALID' AS status;`;

        console.log("   [⏳ Step A: Generating SQL...]");
        const promptToSQL = `${SYSTEM_PROMPT}\n\nPertanyaan: "${message}"\nQuery SQL:`;
        let sqlQuery = await callSQL(promptToSQL);
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

        const finalAnswer = await callChat(promptToSummary);
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
        // 🎮 Demo Mode — semua ke Store 1
        const storeId = 1;
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
        version: '3.0.0',
        activeSessions: sessionStore.size,
        timestamp: new Date().toISOString()
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔════════════════════════════════════════╗
║        🤖 KAZEER AI v3.0.0            ║
║        Business Consultant Bot        ║
╠════════════════════════════════════════╣
║  🔗 Port    : ${PORT}                    ║
║  👥 Mode    : Multi-Tenant            ║
║  ⚡ SQL     : Llama 4 Maverick        ║
║  💬 Chat    : DeepSeek R1            ║
║  🤔 Chat    : DeepSeek R1            ║
║  📦 Features: SQL · Nota · HPP       ║
╚════════════════════════════════════════╝
    `);
});