import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import sql from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Wajib untuk Twilio webhook
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
// DUAL-MODEL ENGINE
// ─────────────────────────────────────────
// callSQL()  → Llama 4 Maverick
//              lebih cepat di real-world
//              khusus SQL generation
//
// callChat() → DeepSeek R1
//              reasoning kuat, thinking mode
//              untuk summary, HPP, nota
// ==========================================

const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
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

            let cleaned = fullContent.trim();
            // Jaga-jaga kalau model sewaktu-waktu bocor thinking tag
            cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
            return cleaned;

        } catch (error) {
            console.log(`   [⚠️ API Error] Percobaan ${i+1}/${retries}: ${error.message}`);
            if (i === retries - 1) throw new Error('Gagal menghubungi server AI.');
            await new Promise(res => setTimeout(res, delay));
            delay *= 2;
        }
    }
}

// ── Model A: SQL Generation (Kaku) ──
async function callSQL(promptText) {
    console.log('   [⚡ Llama 4 Maverick] Generating SQL...');
    // Gunakan Maverick dengan suhu rendah (0.1) agar deterministik & akurat untuk kodingan SQL
    return callNIM('meta/llama-4-maverick-17b-128e-instruct', promptText, 0.1);
}

// ── Model B: Chat, Summary, Nota, HPP (Luwes) ──
async function callChat(promptText) {
    console.log('   [🗣️ Llama 4 Maverick] Chat/Reasoning...');
    // Tetap gunakan Maverick, tetapi dengan suhu lebih tinggi (0.6) agar lebih natural dan cerewet saat nge-chat
    return callNIM('meta/llama-4-maverick-17b-128e-instruct', promptText, 0.6);
}

// ==========================================
// HELPER: Rentang data transaksi
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
// HELPER: Deteksi nota/struk
// ==========================================
function isNota(message) {
    const msg = message.toLowerCase();
    if (msg.includes('nota') || msg.includes('struk') || msg.includes('catat')) return true;
    if ((msg.includes('beli') || msg.includes('bayar')) && /\d/.test(msg)) return true;
    const notaPatterns = [/\d+\s*[xX]\s*\d+/, /rp\.?\s*\d{3,}/i];
    return notaPatterns.some(p => p.test(msg));
}
async function parseNota(notaText) {
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
    "kategori_perkiraan": "bahan_baku | operasional | lainnya"
  }
]

Aturan:
- Jika qty tidak disebutkan, asumsikan 1
- Jika harga satuan tidak ada tapi subtotal ada, hitung: harga_satuan = subtotal / qty
- Jika subtotal tidak ada, hitung: subtotal = qty * harga_satuan
- Buang karakter mata uang (Rp, IDR) dari angka
- Kembalikan array kosong [] jika tidak ada item yang bisa diekstrak

Teks nota:
${notaText}

JSON:`;

    const result = await callChat(prompt);
    try {
        const cleaned = result.replace(/```json/ig, '').replace(/```/g, '').trim();
        return JSON.parse(cleaned);
    } catch {
        return [];
    }
}

// ==========================================
// HELPER: Deteksi pertanyaan HPP
// ==========================================
function isHPPQuestion(message) {
    const hppPatterns = [
        /\bhpp\b/i,
        /harga\s+pokok/i,
        /cost\s+of\s+goods/i,
        /biaya\s+produksi/i,
        /margin/i,
        /keuntungan/i,
        /menguntungkan/i,
        /paling\s+laba/i,
        /paling\s+untung/i,
        /menu\s+terbaik/i,
        /menu\s+terburuk/i,
        /menu\s+rugi/i,
        /menu.*?mana.*?(untung|laba|rugi|profit)/i,
        /mana.*?menu.*?(untung|laba|rugi|profit)/i,
        /berapa\s+(untung|profit|margin)/i,
        /profit\s+margin/i,
        /mark.?up/i,
        /biaya\s+bahan/i,
        /modal\s+per\s+menu/i,
    ];
    return hppPatterns.some(p => p.test(message.trim()));
}

// ==========================================
// HELPER: Deteksi pertanyaan business advice (non-SQL)
// ==========================================
function isBusinessAdvice(message) {
    const patterns = [
        /promo\s+apa/i,
        /strategi\s+apa/i,
        /saran\s+(bisnis|usaha)/i,
        /rekomendasi\s+(bisnis|menu|promo)/i,
        /bagaimana\s+cara/i,
        /tips\s+(bisnis|jualan|cafe)/i,
        /cara\s+meningkatkan/i,
        /cara\s+mengurangi/i,
        /ide\s+(promo|bisnis|menu)/i,
        /apa\s+yang\s+harus/i,
        /langkah\s+apa/i,
        /gimana\s+cara/i,
    ];
    return patterns.some(p => p.test(message.trim()));
}

// ==========================================
// HPP CALCULATOR
// ==========================================
async function hitungHPP(storeId, menuKeyword = null) {
    const menuFilter = menuKeyword ? `AND mi.name ILIKE '%${menuKeyword}%'` : '';

    const resepData = await sql.unsafe(`
        SELECT
            mi.name       AS nama_menu,
            mi.price      AS harga_jual,
            inv.item_name AS nama_bahan,
            inv.unit,
            inv.current_stock,
            mr.qty_used
        FROM menu_items mi
        JOIN menu_recipes mr ON mr.menu_item_id = mi.id
        JOIN inventory inv   ON inv.id = mr.inventory_id
        WHERE mi.store_id = ${storeId}
        ${menuFilter}
        ORDER BY mi.name, inv.item_name
    `);

    const allCashOut = await sql.unsafe(`
        SELECT
            cl.amount           AS total_bayar,
            cl.description      AS keterangan,
            cl.created_at::date AS tanggal
        FROM cash_logs cl
        WHERE cl.store_id = ${storeId}
        AND cl.type = 'out'
        ORDER BY cl.created_at DESC
        LIMIT 50
    `);

    const menuMap = {};
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
        menu: Object.values(menuMap),
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

        if (isRateLimited(storeId)) {
            return res.status(429).json({
                success: false,
                answer: "⏳ Terlalu banyak permintaan dalam waktu singkat. Silakan tunggu sebentar sebelum mencoba kembali."
            });
        }

        if (isChitchat(message)) {
            return res.json({
                success: true,
                answer: `🤖 Kazeer AI\n\nHalo! Saya adalah Kazeer, bot AI Business Consultant kamu untuk ${storeName}.\n\n💡 Saya bisa membantu kamu dengan:\n1. 📊 Analisis omzet & transaksi\n2. 🏆 Menu terlaris & performa penjualan\n3. 📦 Stok & bahan baku\n4. 💰 Laporan laba rugi\n5. 🧾 Baca & analisis nota belanja\n6. 📈 Hitung HPP & margin keuntungan\n\nSilakan ajukan pertanyaan bisnis kamu! 🚀`,
                sql: null,
                rawData: []
            });
        }

        const session = getSession(phone);
        const conversationHistory = session.history
            .map(h => `${h.role === 'user' ? 'Owner' : 'Kazeer'}: ${h.content}`)
            .join('\n');

        // ── Konfirmasi simpan nota ────────────────────────────
        if (message.toLowerCase() === 'simpan' && session.pendingNota) {
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
                sql: null, rawData: []
            });
        }

        if (message.toLowerCase() === 'batal' && session.pendingNota) {
            session.pendingNota = null;
            sessionStore.set(phone, session);
            return res.json({ success: true, answer: "Pencatatan nota dibatalkan. 👌", sql: null, rawData: [] });
        }

        // ══════════════════════════════════════════════════════
        // 🧾 FLOW: PARSER NOTA
        // ══════════════════════════════════════════════════════
        if (isNota(message)) {
            console.log("   [🧾 Nota terdeteksi — parsing...]");
            const items = await parseNota(message);

            if (items.length === 0) {
                return res.json({
                    success: true,
                    answer: "⚠️ Maaf, saya tidak berhasil membaca nota tersebut.\n\nCoba format seperti ini:\n\nnota:\n- Kopi Arabika 500gr x 2 = Rp 90.000\n- Gula Pasir 1kg x 1 = Rp 15.000",
                    sql: null, rawData: []
                });
            }

            const totalNota = items.reduce((sum, i) => sum + (i.subtotal || 0), 0);
            const itemDescription = items.map(i => `${i.nama_item} (${i.qty}x)`).join(', ');

            session.pendingNota = { items, total: totalNota, description: `Belanja: ${itemDescription}` };
            sessionStore.set(phone, session);

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
4. Berikan 1-2 insight bisnis singkat
5. Tanyakan: "Balas SIMPAN untuk mencatat ke kas, atau BATAL untuk membatalkan."

ATURAN FORMAT:
- Gunakan angka (1. 2. 3.) bukan bullet
- Pisahkan setiap poin dengan baris kosong
- DILARANG tanda bintang (*) atau markdown bold
- JANGAN tampilkan JSON mentah`;

            const notaAnswer = await callChat(notaPrompt);
            updateSession(phone, message, notaAnswer);
            return res.json({ success: true, answer: notaAnswer, sql: null, rawData: items, notaParsed: true });
        }

        // ══════════════════════════════════════════════════════
        // 📈 FLOW: HPP & MARGIN
        // ══════════════════════════════════════════════════════
        if (isHPPQuestion(message)) {
            console.log("   [📈 HPP terdeteksi — DeepSeek R1...]");

            const menuKeywordMatch = message.match(/(?:hpp|margin|untung|profit).*?(?:menu\s+)?["']?([a-zA-Z\s]+)["']?/i);
            const menuKeyword = menuKeywordMatch ? menuKeywordMatch[1].trim() : null;
            const hppData = await hitungHPP(storeId, menuKeyword);

            const hppPrompt = `
WAJIB: Seluruh jawaban dalam Bahasa Indonesia. DILARANG menggunakan Bahasa Inggris.

Kamu adalah Kazeer, bot AI Business Consultant untuk ${storeName}.
Pertanyaan owner: "${message}"

Data NYATA dari database — resep menu beserta referensi harga bahan dari cash_logs:
${JSON.stringify(hppData, null, 2)}

CARA MENGHITUNG HPP (WAJIB DIIKUTI KETAT):
- Cocokkan nama bahan di resep dengan deskripsi di "catatan_pembelian_kas"
- Jika cocok → gunakan jumlah pembelian sebagai dasar harga satuan bahan
- Jika TIDAK ADA catatan yang cocok → tulis: "Harga [nama bahan] tidak tercatat di database"
- DILARANG mengarang harga, mengasumsikan harga pasar, atau menyebut bahan yang tidak ada di data resep

TUGAS (HANYA gunakan data yang tersedia di atas):
1. 🧮 Rincian HPP per menu — sebutkan setiap bahan dan harga jika tersedia
2. 💰 Margin kotor: ((harga_jual - total_HPP) / harga_jual) x 100%
3. 📊 Kategorikan: Rendah <30%, Sedang 30-60%, Tinggi >60%
4. 🏆 Menu paling menguntungkan berdasarkan data
5. ⚠️ Daftar bahan yang harganya TIDAK tercatat di database
6. 💡 Jika banyak bahan tidak tercatat, sarankan owner catat nota belanja ke sistem dulu

ATURAN FORMAT:
- DILARANG tanda bintang (*) atau markdown bold
- Gunakan angka (1. 2. 3.) bukan bullet
- Pisahkan setiap poin dengan baris kosong
- Format: Rp 15.000 dan 45,5%
- JANGAN tampilkan JSON mentah`;

            const hppAnswer = await callChat(hppPrompt);
            updateSession(phone, message, hppAnswer);
            return res.json({ success: true, answer: hppAnswer, sql: null, rawData: hppData, hppCalculated: true });
        }

        // ══════════════════════════════════════════════════════
        // 💡 FLOW: BUSINESS ADVICE (non-SQL questions)
        // ══════════════════════════════════════════════════════
        if (isBusinessAdvice(message)) {
            console.log("   [💡 Business advice terdeteksi...]");

            // Ambil snapshot data ringkas dari DB sebagai konteks
            let snapshotData = {};
            try {
                const [topMenu, omzetBulanIni] = await Promise.all([
                    sql.unsafe(`SELECT mi.name, COALESCE(SUM(td.qty),0) AS total FROM transaction_details td JOIN transactions t ON td.transaction_id = t.id JOIN menu_items mi ON td.menu_item_id = mi.id WHERE t.store_id = ${storeId} AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE) GROUP BY mi.name ORDER BY total DESC LIMIT 5`),
                    sql.unsafe(`SELECT COALESCE(SUM(total_amount),0) AS omzet, COUNT(*) AS transaksi FROM transactions WHERE store_id = ${storeId} AND DATE_TRUNC('month', transaction_date) = DATE_TRUNC('month', CURRENT_DATE)`)
                ]);
                snapshotData = { top_menu_bulan_ini: topMenu, omzet_bulan_ini: omzetBulanIni[0] };
            } catch (e) {}

            const advicePrompt = `
WAJIB: Seluruh jawaban dalam Bahasa Indonesia. DILARANG menggunakan Bahasa Inggris.

Kamu adalah Kazeer, bot AI Business Consultant untuk ${storeName}.
Owner bertanya: "${message}"

Data bisnis saat ini (gunakan sebagai konteks):
${JSON.stringify(snapshotData, null, 2)}

Riwayat percakapan:
${conversationHistory || '(Tidak ada riwayat)'}

Tugas kamu:
Berikan saran bisnis yang spesifik, actionable, dan relevan dengan kondisi ${storeName} berdasarkan data di atas.

ATURAN FORMAT:
- Maksimal 3-4 poin saran
- Setiap poin diawali emoji
- Pisahkan setiap poin dengan baris kosong
- Gunakan angka (1. 2. 3.) bukan bullet
- DILARANG tanda bintang (*) atau markdown bold
- Bahasa profesional tapi ramah`;

            const adviceAnswer = await callChat(advicePrompt);
            updateSession(phone, message, adviceAnswer);
            return res.json({ success: true, answer: adviceAnswer, sql: null, rawData: [] });
        }

        // ══════════════════════════════════════════════════════
        // 🧠 FLOW UTAMA: SQL → DB → ANSWER
        // ══════════════════════════════════════════════════════
        const today = new Date().toISOString().split('T')[0];

        // Inject skema dinamis per cafe
        let kategoriList = 'Kopi, Non-Kopi, Makanan Berat, Snack & Dessert';
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
- GUNAKAN nama kategori persis dari daftar di atas saat filter mc.name ILIKE.
- DILARANG hardcode nama kategori yang tidak ada di daftar atas.
- Jika user tanya "semua menu terlaris" tanpa sebut kategori → JANGAN JOIN menu_categories.

PEMETAAN KATA KEUANGAN:
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
[8]  DATA KOSONG: Jangan kembalikan PERTANYAAN_TIDAK_VALID jika tabel relevan ada.
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

Pertanyaan: "menu paling menguntungkan" / "menu dengan margin tertinggi"
SQL: SELECT mi.name AS nama_menu, mi.price AS harga_jual, COALESCE(SUM(td.qty),0) AS total_terjual, COALESCE(SUM(td.subtotal),0) AS total_omzet FROM transaction_details td JOIN transactions t ON td.transaction_id = t.id JOIN menu_items mi ON td.menu_item_id = mi.id WHERE t.store_id = ${storeId} AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE) GROUP BY mi.name, mi.price ORDER BY total_omzet DESC LIMIT 10;

Pertanyaan: "minuman terlaris bulan ini"
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

Pertanyaan: "berapa untung saya bulan ini"
SQL: WITH pendapatan AS (SELECT COALESCE(SUM(t.total_amount),0) AS total FROM transactions t WHERE t.store_id = ${storeId} AND DATE_TRUNC('month', t.transaction_date) = DATE_TRUNC('month', CURRENT_DATE)), pengeluaran AS (SELECT COALESCE(SUM(cl.amount),0) AS total FROM cash_logs cl WHERE cl.store_id = ${storeId} AND cl.type = 'out' AND DATE_TRUNC('month', cl.created_at) = DATE_TRUNC('month', CURRENT_DATE)) SELECT p.total AS total_pendapatan, k.total AS total_pengeluaran, (p.total - k.total) AS laba_bersih FROM pendapatan p, pengeluaran k;

Pertanyaan: "laporan stok bahan baku"
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
                answer: "⚠️ Maaf, pertanyaan tersebut belum bisa dijawab dengan data yang tersedia.\n\nCoba tanyakan dengan cara yang berbeda. 😊",
                sql: sqlQuery, rawData: []
            });
        }

        const dbResult = await sql.unsafe(sqlQuery);
        const safeData = dbResult.length > 15 ? dbResult.slice(0, 15) : dbResult;
        let dataToAI = JSON.stringify(safeData);
        if (dbResult.length > 15) {
            dataToAI += `\n(Catatan: Ditampilkan 15 data teratas dari total ${dbResult.length} baris.)`;
        }

        let dataRangeContext = '';
        const isEmptyOrZero = safeData.length === 0 ||
            safeData.every(row => Object.values(row).every(v => v === null || v === 0 || v === '0'));

        if (isEmptyOrZero) {
            const range = await getDataRange(storeId);
            if (range?.total_transaksi > 0) {
                dataRangeContext = `\nINFO: Database memiliki ${range.total_transaksi} transaksi dari ${range.tanggal_pertama} hingga ${range.tanggal_terakhir}. Periode yang ditanyakan kemungkinan belum ada transaksinya.`;
            }
        }

        console.log("   [⏳ Step C: DeepSeek R1 menyusun jawaban...]");
        const promptToSummary = `
WAJIB: Seluruh jawaban dalam Bahasa Indonesia. DILARANG menggunakan Bahasa Inggris.

Kamu adalah Kazeer, bot AI Business Consultant untuk ${storeName}.
Kamu pintar, informatif, dan selalu memberikan insight bisnis yang valuable.

Pertanyaan: "${message}"
Data dari database: ${dataToAI}${dataRangeContext}

Riwayat percakapan:
${conversationHistory || '(Tidak ada riwayat)'}

CARA MENJAWAB:
1. Setiap poin diawali emoji yang relevan
2. Pisahkan setiap poin dengan satu baris kosong
3. Maksimal 2-3 kalimat per poin
4. Akhiri dengan 1 insight bisnis yang actionable dan spesifik
5. Bahasa Indonesia yang profesional tapi ramah
6. Format Rupiah: Rp 1.250.000 | Persentase: 23,5%
7. Untuk daftar: gunakan angka (1. 2. 3.) bukan bullet
8. Jika data kosong: jelaskan + sebutkan rentang data yang tersedia
9. Jika follow-up: jawab mengacu konteks sebelumnya

DILARANG KERAS:
- Tanda bintang (*) atau markdown bold (**teks**)
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
// ENDPOINT: Simpan nota ke cash_logs
// ==========================================
app.post('/api/catat-nota', async (req, res) => {
    const { items, description } = req.body;
    try {
        const storeId = 1; // 🎮 Demo Mode
        const total = items.reduce((sum, i) => sum + (i.subtotal || 0), 0);
        await sql`
            INSERT INTO cash_logs (store_id, type, amount, description, created_at)
            VALUES (${storeId}, 'out', ${total}, ${description || 'Pengeluaran dari nota'}, NOW())
        `;
        res.json({ success: true, message: `✅ Nota dicatat. Total: Rp ${total.toLocaleString('id-ID')}` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});


// ==========================================
// 📱 TWILIO WHATSAPP WEBHOOK
// ==========================================
// Setup di Twilio Console:
// Sandbox → "When a message comes in" → https://your-domain.com/webhook/twilio
// Method: HTTP POST
// ==========================================

// Helper: Format jawaban untuk WhatsApp (plain text, no markdown)
function formatForWhatsApp(text) {
    return text
        .replace(/\*\*(.*?)\*\*/g, '$1')   // hapus bold **...**
        .replace(/\*(.*?)\*/g, '$1')         // hapus italic *...*
        .replace(/`{1,3}[^`]*`{1,3}/g, '')    // hapus code blocks
        .replace(/#{1,6}\s/g, '')             // hapus heading #
        .trim();
}

// Helper: Kirim balik TwiML response ke Twilio
function twimlReply(res, message) {
    const safe = message
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    res.set('Content-Type', 'text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Message>${safe}</Message>
</Response>`);
}

app.post('/webhook/twilio', async (req, res) => {
    const from    = req.body.From || '';   // "whatsapp:+6281234567890"
    const body    = (req.body.Body || '').trim();
    const numFrom = from.replace('whatsapp:', ''); // "+6281234567890"
    const phone   = numFrom.replace('+', '');      // "6281234567890"

    console.log(`\n📱 [Twilio] ${numFrom}: "${body}"`);

    if (!body) {
        return twimlReply(res, 'Halo! Silakan kirim pertanyaan bisnis kamu. 🚀');
    }

    try {
        // Panggil endpoint /api/chat yang sudah ada
        const protocol = req.headers['x-forwarded-proto'] || 'http';
        const host = req.headers.host;
        const baseUrl = `${protocol}://${host}`;

        const response = await fetch(`${baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: body, phone })
        });

        const data = await response.json();
        const answer = formatForWhatsApp(data.answer || 'Maaf, tidak ada respons dari server.');

        // Twilio max 1600 karakter per pesan — potong jika lebih
        const MAX_LEN = 1550;
        if (answer.length > MAX_LEN) {
            const part1 = answer.substring(0, MAX_LEN) + '...';
            return twimlReply(res, part1);
        }

        return twimlReply(res, answer);

    } catch (error) {
        console.error('❌ Twilio webhook error:', error.message);
        return twimlReply(res, '⚠️ Maaf, terjadi kendala teknis. Silakan coba beberapa saat lagi.');
    }
});

// ==========================================
// HEALTH CHECK
// ==========================================
app.get('/health', (req, res) => {
    res.json({ status: 'ok', app: 'Kazeer AI', version: '3.1.0', activeSessions: sessionStore.size, timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔════════════════════════════════════════╗
║        🤖 KAZEER AI v3.1.0            ║
║        Business Consultant Bot        ║
╠════════════════════════════════════════╣
║  🔗 Port    : ${PORT}                    ║
║  👥 Mode    : Multi-Tenant            ║
║  ⚡ SQL     : Llama 4 Maverick        ║
║  🤔 Chat    : DeepSeek R1             ║
║  📦 Features: SQL · Nota · HPP        ║
║  📱 Webhook : /webhook/twilio          ║
╚════════════════════════════════════════╝
    `);
});