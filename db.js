import 'dotenv/config'; // Pengganti require('dotenv').config()
import postgres from 'postgres';

const connectionString = process.env.DATABASE_URL;

// Inisialisasi koneksi dengan SSL (Wajib untuk Supabase)
const sql = postgres(connectionString, {
    ssl: 'require'
});

export default sql;