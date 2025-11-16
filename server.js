// server.js - projeto completo
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const nodemailer = require('nodemailer');
const { stringify: csvStringify } = require('csv-stringify/sync');

const app = express();
const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || 'troque_esta_chave_para_producao';
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || `http://localhost:${PORT}`;

app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cors({ origin: FRONTEND_ORIGIN, credentials: true }));

// uploads dir
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

// multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const uniq = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `img-${uniq}${path.extname(file.originalname)}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/'))
});

// nodemailer
let transporter = null;
if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
  transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
  });
  transporter.verify().then(() => console.log('✅ Nodemailer pronto')).catch(e => console.warn('⚠️ Nodemailer erro:', e.message));
} else {
  console.warn('⚠️ EMAIL_USER / EMAIL_PASS não configurados. Envio de e-mails será simulado em dev.');
}

// ========== Banco SQLite ==========
const dbFile = path.join(__dirname, 'gera.db');
const db = new sqlite3.Database(dbFile);

function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}
function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}
function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

async function initDB() {
  await runAsync(`CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    senha TEXT NOT NULL,
    idade INTEGER,
    verificado INTEGER DEFAULT 0,
    data_cadastro TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  await runAsync(`CREATE TABLE IF NOT EXISTS noticias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    titulo TEXT NOT NULL,
    resumo TEXT NOT NULL,
    corpo TEXT NOT NULL,
    categoria TEXT NOT NULL,
    imagem TEXT,
    data_criacao TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  await runAsync(`CREATE TABLE IF NOT EXISTS anuncios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    empresa TEXT NOT NULL,
    email TEXT NOT NULL,
    telefone TEXT NOT NULL,
    tipo TEXT NOT NULL,
    mensagem TEXT NOT NULL,
    imagem TEXT,
    status TEXT DEFAULT 'pendente',
    data_criacao TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  // cria admin se não existir
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@admin.com';
  const adminPass = process.env.ADMIN_PASS || 'admin123';
  const admin = await getAsync('SELECT * FROM usuarios WHERE email = ?', [adminEmail]).catch(() => null);
  if (!admin) {
    const hashed = await bcrypt.hash(adminPass, 10);
    await runAsync('INSERT INTO usuarios (nome,email,senha,idade,verificado) VALUES (?,?,?,?,1)',
      ['Administrador', adminEmail, hashed, 30]);
    console.log('✅ Admin criado:', adminEmail);
  }
}
initDB().catch(console.error);

// === Verification code storage (in-memory) ===
const verificationCodes = new Map(); // email -> { code, expiresAt }

// helper
function generateCode6() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// serve static frontend and uploads
app.use('/uploads', express.static(uploadsDir));


// ========== ROTAS PÚBLICAS ==========

// auth middleware
function authenticateAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Não autenticado' });
  const parts = auth.split(' ');
  if (parts.length !== 2) return res.status(401).json({ error: 'Formato de token inválido' });
  const token = parts[1];
  try {
    const data = jwt.verify(token, JWT_SECRET);
    if (!data.isAdmin) return res.status(403).json({ error: 'Acesso negado' });
    req.user = data;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido' });
  }
}
// listar notícias (público)
app.get('/api/noticias', async (req, res) => {
  try {
    const rows = await allAsync('SELECT id,titulo,resumo,categoria,imagem,data_criacao FROM noticias ORDER BY data_criacao DESC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ver 1 noticia
app.get('/api/noticia', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'id requerido' });
  try {
    const row = await getAsync('SELECT * FROM noticias WHERE id = ?', [id]);
    res.json(row || {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// enviar anúncio (public)
app.post('/api/add-ad', upload.single('imagem'), async (req, res) => {
  try {
    const { nome, empresa, email, telefone, tipo, mensagem } = req.body;
    if (!nome || !empresa || !email || !telefone || !tipo || !mensagem) {
      return res.status(400).json({ error: 'Campos obrigatórios faltando' });
    }
    const imagem = req.file ? `/uploads/${req.file.filename}` : null;
    const r = await runAsync(
      'INSERT INTO anuncios (nome,empresa,email,telefone,tipo,mensagem,imagem) VALUES (?,?,?,?,?,?,?)',
      [nome, empresa, email, telefone, tipo, mensagem, imagem]
    );
    res.json({ success: true, id: r.lastID });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== AUTENTICAÇÃO E VERIFICAÇÃO ==========

// registro: cria usuário (verificado = false) e envia código automaticamente
app.post('/api/register', async (req, res) => {
  try {
    const { nome, email, senha, idade } = req.body;
    if (!nome || !email || !senha || !idade) return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
    const age = parseInt(idade, 10);
    if (isNaN(age) || age < 13 || age > 120) return res.status(400).json({ error: 'Idade inválida.' });

    const hashed = await bcrypt.hash(senha, 10);
    const inserted = await runAsync('INSERT INTO usuarios (nome,email,senha,idade,verificado) VALUES (?,?,?,?,0)',
      [nome, email.toLowerCase(), hashed, age]);
    // envia código
    const code = generateCode6();
    verificationCodes.set(email.toLowerCase(), { code, expiresAt: Date.now() + 3 * 60 * 1000 });
    if (transporter) {
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: email,
        subject: 'Código de verificação - GERA',
        text: `Seu código de verificação é: ${code}\nValido por 3 minutos.`
      });
      return res.json({ success: true, message: 'Usuário criado. Código enviado por e-mail.' });
    } else {
      // dev fallback
      return res.json({ success: true, message: 'Usuário criado (dev). Código (simulado) retornado.', simulatedCode: code });
    }
  } catch (err) {
    if (err && err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'E-mail já cadastrado.' });
    }
    return res.status(500).json({ error: err.message });
  }
});

// reenviar código
app.post('/api/send-verification-code', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email obrigatório' });
    const user = await getAsync('SELECT * FROM usuarios WHERE email = ?', [email.toLowerCase()]);
    if (!user) return res.status(404).json({ error: 'E-mail não cadastrado' });

    const code = generateCode6();
    verificationCodes.set(email.toLowerCase(), { code, expiresAt: Date.now() + 3 * 60 * 1000 });
    if (transporter) {
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: email,
        subject: 'Código de verificação - GERA',
        text: `Seu código de verificação é: ${code}\nValido por 3 minutos.`
      });
      return res.json({ success: true });
    } else {
      return res.json({ success: true, simulatedCode: code });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// verificar o código
app.post('/api/verify-code', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'email e code obrigatórios' });
    const stored = verificationCodes.get(email.toLowerCase());
    if (!stored || stored.code !== String(code) || Date.now() > stored.expiresAt) {
      return res.status(400).json({ error: 'Código inválido ou expirado' });
    }
    await runAsync('UPDATE usuarios SET verificado = 1 WHERE email = ?', [email.toLowerCase()]);
    verificationCodes.delete(email.toLowerCase());
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// Upload genérico de imagem (usado pelo frontend do admin)
app.post('/api/upload', authenticateAdmin, upload.single('imagem'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado ou arquivo inválido.' });
    }
    // Retorna o caminho público da imagem
    const imageUrl = `/uploads/${req.file.filename}`;
    res.json({ success: true, imageUrl, filename: req.file.filename });
  } catch (err) {
    console.error('Erro no upload:', err);
    res.status(500).json({ error: 'Erro interno ao fazer upload.' });
  }
});
// login usuário (apenas verificados)
app.post('/api/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    if (!email || !senha) return res.status(400).json({ error: 'email e senha obrigatórios' });
    const user = await getAsync('SELECT * FROM usuarios WHERE email = ?', [email.toLowerCase()]);
    if (!user) return res.status(401).json({ error: 'Credenciais inválidas' });
    const ok = await bcrypt.compare(senha, user.senha);
    if (!ok) return res.status(401).json({ error: 'Credenciais inválidas' });
    if (user.verificado !== 1) return res.status(401).json({ error: 'E-mail não verificado' });
    const token = jwt.sign({ id: user.id, email: user.email, isAdmin: false }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ success: true, token, nome: user.nome });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// admin login (gera token admin)
app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    if (!email || !senha) return res.status(400).json({ error: 'email e senha obrigatórios' });
    const user = await getAsync('SELECT * FROM usuarios WHERE email = ?', [email.toLowerCase()]);
    if (!user) return res.status(401).json({ error: 'Credenciais inválidas' });
    const ok = await bcrypt.compare(senha, user.senha);
    if (!ok) return res.status(401).json({ error: 'Credenciais inválidas' });
    // apenas admin (criado manualmente) terá isAdmin true por convenção (email ADMIN_EMAIL)
    const isAdmin = (email.toLowerCase() === (process.env.ADMIN_EMAIL || 'admin@admin.com').toLowerCase());
    if (!isAdmin) return res.status(403).json({ error: 'Acesso negado. Usuário não é administrador.' });
    const token = jwt.sign({ id: user.id, email: user.email, isAdmin: true }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ success: true, token, isAdmin: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});



// ========== ROTAS ADMIN (protegidas) ==========

// dashboard counts
app.get('/api/admin/dashboard', authenticateAdmin, async (req, res) => {
  try {
    const usuarios = await getAsync('SELECT COUNT(*) as c FROM usuarios');
    const noticias = await getAsync('SELECT COUNT(*) as c FROM noticias');
    const anuncios = await getAsync('SELECT COUNT(*) as c FROM anuncios');
    res.json({
      totalUsuarios: usuarios.c || 0,
      totalNoticias: noticias.c || 0,
      totalAnuncios: anuncios.c || 0
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// listar usuários
app.get('/api/admin/users', authenticateAdmin, async (req, res) => {
  try {
    const rows = await allAsync('SELECT id,nome,email,idade,verificado,data_cadastro FROM usuarios ORDER BY data_cadastro DESC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// export leads CSV
app.get('/api/admin/export-leads', authenticateAdmin, async (req, res) => {
  try {
    const rows = await allAsync('SELECT nome,email,data_cadastro FROM usuarios ORDER BY data_cadastro DESC');
    const csv = csvStringify(rows, { header: true });
    res.header('Content-Type', 'text/csv');
    res.attachment(`leads_${new Date().toISOString().slice(0,10)}.csv`);
    res.send(csv);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// CRUD notícias (admin)
app.get('/api/admin/news', authenticateAdmin, async (req, res) => {
  try {
    const rows = await allAsync('SELECT id,titulo,categoria,resumo,imagem,data_criacao FROM noticias ORDER BY data_criacao DESC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/news', authenticateAdmin, upload.single('imagem'), async (req, res) => {
  try {
    const { titulo, resumo, corpo, categoria } = req.body;
    if (!titulo || !resumo || !corpo || !categoria) return res.status(400).json({ error: 'Campos obrigatórios' });
    const imagem = req.file ? `/uploads/${req.file.filename}` : null;
    const r = await runAsync('INSERT INTO noticias (titulo,resumo,corpo,categoria,imagem) VALUES (?,?,?,?,?)',
      [titulo, resumo, corpo, categoria, imagem]);
    res.json({ success: true, id: r.lastID });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/news/:id', authenticateAdmin, upload.single('imagem'), async (req, res) => {
  try {
    const id = req.params.id;
    const { titulo, resumo, corpo, categoria, imagemUrl } = req.body;
    const newImage = req.file ? `/uploads/${req.file.filename}` : (imagemUrl || null);
    // se trocar imagem, remover arquivo antigo
    const old = await getAsync('SELECT imagem FROM noticias WHERE id = ?', [id]);
    if (req.file && old && old.imagem) {
      const oldPath = path.join(__dirname, old.imagem);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    await runAsync('UPDATE noticias SET titulo=?,resumo=?,corpo=?,categoria=?,imagem=? WHERE id=?',
      [titulo, resumo, corpo, categoria, newImage, id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/news/:id', authenticateAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const old = await getAsync('SELECT imagem FROM noticias WHERE id = ?', [id]);
    if (old && old.imagem) {
      const oldPath = path.join(__dirname, old.imagem);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    await runAsync('DELETE FROM noticias WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// CRUD anúncios (admin)
app.get('/api/admin/ads', authenticateAdmin, async (req, res) => {
  try {
    const rows = await allAsync('SELECT id,nome,empresa,email,telefone,tipo,status,imagem,data_criacao FROM anuncios ORDER BY data_criacao DESC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/ads', authenticateAdmin, upload.single('imagem'), async (req, res) => {
  try {
    const { nome, empresa, email, telefone, tipo, mensagem } = req.body;
    if (!nome || !empresa || !email || !telefone || !tipo || !mensagem) return res.status(400).json({ error: 'Campos obrigatórios' });
    const imagem = req.file ? `/uploads/${req.file.filename}` : null;
    const r = await runAsync('INSERT INTO anuncios (nome,empresa,email,telefone,tipo,mensagem,imagem) VALUES (?,?,?,?,?,?,?)',
      [nome,empresa,email,telefone,tipo,mensagem,imagem]);
    res.json({ success: true, id: r.lastID });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/ads/:id', authenticateAdmin, upload.single('imagem'), async (req, res) => {
  try {
    const id = req.params.id;
    const { nome, empresa, email, telefone, tipo, mensagem, status, imagemUrl } = req.body;
    const newImage = req.file ? `/uploads/${req.file.filename}` : (imagemUrl || null);
    const old = await getAsync('SELECT imagem FROM anuncios WHERE id = ?', [id]);
    if (req.file && old && old.imagem) {
      const oldPath = path.join(__dirname, old.imagem);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    await runAsync('UPDATE anuncios SET nome=?,empresa=?,email=?,telefone=?,tipo=?,mensagem=?,status=?,imagem=? WHERE id=?',
      [nome,empresa,email,telefone,tipo,mensagem,status || 'pendente',newImage,id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/ads/:id', authenticateAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const old = await getAsync('SELECT imagem FROM anuncios WHERE id = ?', [id]);
    if (old && old.imagem) {
      const oldPath = path.join(__dirname, old.imagem);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    await runAsync('DELETE FROM anuncios WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/', (req, res) => {
  res.json({ status: 'API online' });
});


// start
app.listen(PORT, () => {
  console.log(`🚀 Server rodando em http://localhost:${PORT}`);
});