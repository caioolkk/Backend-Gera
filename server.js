const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 10000;

// === CONFIGURAÇÃO DE UPLOAD ===
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + '-' + unique + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, file.mimetype.startsWith('image/'));
  }
});

// === MIDDLEWARE ===
app.use(cors({
  origin: [
    'https://gera-noticias.vercel.app',
    'https://gera-painel-admin.vercel.app',
    'http://localhost:3000',
    'http://127.0.0.1:5500'
  ],
  credentials: true
}));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use('/uploads', express.static(uploadDir));

// === CONFIGURAÇÃO DO Nodemailer ===
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;

let transporter = null;
if (EMAIL_USER && EMAIL_PASS) {
  transporter = nodemailer.createTransporter({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: { user: EMAIL_USER, pass: EMAIL_PASS }
  });
}

// Armazenamento temporário de códigos (em produção, use Redis)
const verificationCodes = new Map();
const passwordResetCodes = new Map();

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// === CONEXÃO COM POSTGRESQL ===
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// === INICIALIZAR BANCO ===
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      senha TEXT NOT NULL,
      idade INTEGER CHECK (idade >= 13 AND idade <= 120),
      is_admin BOOLEAN DEFAULT false,
      verificado BOOLEAN DEFAULT false,
      data_cadastro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS noticias (
      id SERIAL PRIMARY KEY,
      titulo TEXT NOT NULL,
      resumo TEXT NOT NULL,
      corpo TEXT NOT NULL,
      categoria TEXT NOT NULL,
      imagem TEXT,
      data_criacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS anuncios (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      empresa TEXT NOT NULL,
      email TEXT NOT NULL,
      telefone TEXT NOT NULL,
      tipo TEXT NOT NULL,
      mensagem TEXT NOT NULL,
      imagem TEXT,
      status TEXT DEFAULT 'pendente',
      data_criacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const admin = await pool.query("SELECT * FROM usuarios WHERE email = 'admin@admin.com'");
  if (admin.rows.length === 0) {
    await pool.query(
      `INSERT INTO usuarios (nome, email, senha, idade, is_admin, verificado) 
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['Administrador', 'admin@admin.com', 'admin123', 30, true, true]
    );
    console.log('✅ Usuário admin criado');
  }
}
initDB().catch(console.error);

// === ROTAS PÚBLICAS ===

app.get('/api/destaque', async (req, res) => {
  try {
    const r = await pool.query(`SELECT id, titulo, resumo, imagem FROM noticias ORDER BY data_criacao DESC LIMIT 1`);
    res.json(r.rows[0] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/noticias', async (req, res) => {
  try {
    const { categoria } = req.query;
    let q = `SELECT id, titulo, resumo, categoria, imagem, TO_CHAR(data_criacao, 'DD/MM/YYYY às HH24:MI') as data FROM noticias`;
    const p = [];
    if (categoria) { q += ' WHERE categoria = $1'; p.push(categoria); }
    q += ' ORDER BY data_criacao DESC';
    const r = await pool.query(q, p);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/noticia', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'ID necessário' });
  try {
    const r = await pool.query(
      `SELECT id, titulo, resumo, corpo, categoria, imagem, TO_CHAR(data_criacao, 'DD/MM/YYYY às HH24:MI') as data 
       FROM noticias WHERE id = $1`, [id]
    );
    res.json(r.rows[0] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  try {
    const r = await pool.query(
      `SELECT id, titulo, resumo, categoria, imagem, TO_CHAR(data_criacao, 'DD/MM/YYYY às HH24:MI') as data 
       FROM noticias WHERE titulo ILIKE $1 OR resumo ILIKE $1 OR corpo ILIKE $1 
       ORDER BY data_criacao DESC`, [`%${q}%`]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/add-ad', upload.single('imagem'), async (req, res) => {
  const { nome, empresa, email, telefone, tipo, mensagem } = req.body;
  const img = req.file ? `/uploads/${req.file.filename}` : null;
  try {
    const r = await pool.query(
      `INSERT INTO anuncios (nome, empresa, email, telefone, tipo, mensagem, imagem) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [nome, empresa, email, telefone, tipo, mensagem, img]
    );
    res.json({ id: r.rows[0].id, success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// === AUTENTICAÇÃO ===

app.post('/api/register', async (req, res) => {
  const { name, email, age, password } = req.body;

  if (!name || !email || !age || !password) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
  }

  const idade = parseInt(age, 10);
  if (isNaN(idade) || idade < 13 || idade > 120) {
    return res.status(400).json({ error: 'Idade inválida. Deve estar entre 13 e 120 anos.' });
  }

  try {
    const r = await pool.query(
      `INSERT INTO usuarios (nome, email, idade, senha) VALUES ($1, $2, $3, $4) RETURNING id`,
      [name.trim(), email.toLowerCase().trim(), idade, password]
    );
    res.json({ success: true, id: r.rows[0].id });
  } catch (e) {
    if (e.code === '23505') {
      res.status(400).json({ error: 'E-mail já cadastrado.' });
    } else {
      console.error('Erro no cadastro:', e);
      res.status(500).json({ error: 'Erro interno no servidor.' });
    }
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const r = await pool.query(
      `SELECT id, email, is_admin FROM usuarios WHERE email = $1 AND senha = $2 AND verificado = true`,
      [email, password]
    );
    if (r.rows.length > 0) {
      res.json({ success: true, token: 'fake-token', isAdmin: r.rows[0].is_admin });
    } else {
      res.status(401).json({ error: 'Credenciais inválidas ou e-mail não verificado.' });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// === VERIFICAÇÃO POR E-MAIL ===

app.post('/api/send-verification-code', async (req, res) => {
  const { email } = req.body;
  const user = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]);
  if (user.rows.length === 0) {
    return res.status(404).json({ error: 'E-mail não cadastrado.' });
  }

  const code = generateCode();
  verificationCodes.set(email, { code, expiresAt: Date.now() + 10 * 60 * 1000 });

  if (transporter) {
    try {
      await transporter.sendMail({
        from: EMAIL_USER,
        to: email,
        subject: 'Verifique seu e-mail - GERA',
        text: `Seu código de verificação é: ${code}\n\nEste código expira em 10 minutos.`
      });
      console.log(`📧 Código enviado para ${email}`);
      res.json({ success: true });
    } catch (err) {
      console.error('Erro ao enviar e-mail:', err);
      res.status(500).json({ error: 'Falha ao enviar e-mail.' });
    }
  } else {
    console.warn('📧 Nodemailer não configurado. Código simulado:', code);
    res.json({ success: true });
  }
});

app.post('/api/verify-code', async (req, res) => {
  const { email, code } = req.body;
  const stored = verificationCodes.get(email);
  if (!stored || stored.code !== code || Date.now() > stored.expiresAt) {
    return res.status(400).json({ error: 'Código inválido ou expirado.' });
  }
  try {
    await pool.query(`UPDATE usuarios SET verificado = true WHERE email = $1`, [email]);
    verificationCodes.delete(email);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/send-password-reset', async (req, res) => {
  const { email } = req.body;
  const user = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]);
  if (user.rows.length === 0) {
    return res.status(404).json({ error: 'E-mail não encontrado.' });
  }

  const code = generateCode();
  passwordResetCodes.set(email, { code, expiresAt: Date.now() + 10 * 60 * 1000 });

  if (transporter) {
    try {
      await transporter.sendMail({
        from: EMAIL_USER,
        to: email,
        subject: 'Redefina sua senha - GERA',
        text: `Seu código de recuperação é: ${code}\n\nEste código expira em 10 minutos.`
      });
      console.log(`🔑 Código de recuperação enviado para ${email}`);
      res.json({ success: true });
    } catch (err) {
      console.error('Erro ao enviar e-mail:', err);
      res.status(500).json({ error: 'Falha ao enviar e-mail.' });
    }
  } else {
    console.warn('📧 Nodemailer não configurado. Código simulado:', code);
    res.json({ success: true });
  }
});

app.post('/api/reset-password', async (req, res) => {
  const { email, code, newPassword } = req.body;
  const stored = passwordResetCodes.get(email);
  if (!stored || stored.code !== code || Date.now() > stored.expiresAt) {
    return res.status(400).json({ error: 'Código inválido ou expirado.' });
  }
  try {
    await pool.query(`UPDATE usuarios SET senha = $1 WHERE email = $2`, [newPassword, email]);
    passwordResetCodes.delete(email);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// === ROTAS ADMIN ===

const authAdmin = (req, res, next) => next();

app.get('/api/admin-dashboard', authAdmin, async (req, res) => {
  try {
    const [u, n, a] = await Promise.all([
      pool.query('SELECT COUNT(*) as total FROM usuarios'),
      pool.query('SELECT COUNT(*) as total FROM noticias'),
      pool.query('SELECT COUNT(*) as total FROM anuncios WHERE status = $1', ['ativo'])
    ]);
    res.json({
      totalUsuarios: parseInt(u.rows[0].total),
      totalNoticias: parseInt(n.rows[0].total),
      totalAnuncios: parseInt(a.rows[0].total)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/realtime', authAdmin, (req, res) => {
  res.json([
    { usuario: 'admin', acao: 'Login', categoria: 'Sistema', data: new Date().toISOString() },
    { usuario: 'joao@email.com', acao: 'Visualizou Política', categoria: 'Política', data: new Date(Date.now() - 3600000).toISOString() }
  ]);
});

app.get('/api/noticias-admin', authAdmin, async (req, res) => {
  const r = await pool.query(`
    SELECT id, titulo, categoria, TO_CHAR(data_criacao, 'DD/MM/YYYY HH24:MI') as data
    FROM noticias ORDER BY data_criacao DESC
  `);
  res.json(r.rows);
});

app.post('/api/add-news', authAdmin, upload.single('imagem'), async (req, res) => {
  const { titulo, categoria, resumo, corpo } = req.body;
  const img = req.file ? `/uploads/${req.file.filename}` : null;
  if (!titulo || !categoria || !resumo || !corpo) return res.status(400).json({ error: 'Campos obrigatórios' });
  try {
    const r = await pool.query(
      `INSERT INTO noticias (titulo, categoria, resumo, corpo, imagem) 
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [titulo, categoria, resumo, corpo, img]
    );
    res.json({ id: r.rows[0].id, success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/anuncios', authAdmin, async (req, res) => {
  const r = await pool.query(`
    SELECT id, nome, empresa, status, imagem, TO_CHAR(data_criacao, 'DD/MM/YYYY') as data
    FROM anuncios ORDER BY data_criacao DESC
  `);
  res.json(r.rows);
});

app.post('/api/add-anuncio', authAdmin, upload.single('imagem'), async (req, res) => {
  const { nome, empresa, email, telefone, tipo, mensagem } = req.body;
  const img = req.file ? `/uploads/${req.file.filename}` : null;
  if (!nome || !empresa || !email || !telefone || !tipo || !mensagem) return res.status(400).json({ error: 'Campos obrigatórios' });
  try {
    const r = await pool.query(
      `INSERT INTO anuncios (nome, empresa, email, telefone, tipo, mensagem, imagem) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [nome, empresa, email, telefone, tipo, mensagem, img]
    );
    res.json({ id: r.rows[0].id, success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/delete-anuncio/:id', authAdmin, async (req, res) => {
  const { id } = req.params;
  const { senha } = req.body;
  if (senha !== 'admin123') return res.status(401).json({ error: 'Senha incorreta' });
  try {
    const anuncio = await pool.query('SELECT imagem FROM anuncios WHERE id = $1', [id]);
    if (anuncio.rows.length === 0) return res.status(404).json({ error: 'Anúncio não encontrado' });
    if (anuncio.rows[0].imagem) {
      const p = path.join(__dirname, anuncio.rows[0].imagem);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    await pool.query('DELETE FROM anuncios WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/usuarios', authAdmin, async (req, res) => {
  const r = await pool.query(`
    SELECT nome, email, TO_CHAR(data_cadastro, 'DD/MM/YYYY') as data_cadastro
    FROM usuarios ORDER BY data_cadastro DESC
  `);
  res.json(r.rows);
});

app.get('/api/export-leads', authAdmin, async (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=leads_usuarios.csv');
  res.write('Nome,E-mail,Data de Cadastro\n');
  const r = await pool.query('SELECT nome, email, data_cadastro FROM usuarios');
  r.rows.forEach(row => {
    res.write(`"${row.nome || ''}","${row.email}","${row.data_cadastro}"\n`);
  });
  res.end();
});

app.post('/api/upload', authAdmin, upload.single('imagem'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo' });
  res.json({ filename: `/uploads/${req.file.filename}` });
});

// Rota raiz
app.get('/', (req, res) => {
  res.json({ message: 'API GERA funcionando', time: new Date().toISOString() });
});

// Iniciar servidor
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Backend rodando em http://localhost:${PORT}`);
  console.log(`🔗 URL pública: https://backend-gera.onrender.com`);
});