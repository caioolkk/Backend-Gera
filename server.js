const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Configurar upload de arquivos
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Apenas arquivos de imagem são permitidos'), false);
    }
  }
});

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/admin', express.static(path.join(__dirname, '../admin')));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Banco de dados
const db = new sqlite3.Database('./db.sqlite');

// Criar tabelas
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS noticias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    titulo TEXT NOT NULL,
    resumo TEXT NOT NULL,
    corpo TEXT NOT NULL,
    categoria TEXT NOT NULL,
    imagem TEXT,
    data_criacao DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    senha TEXT NOT NULL,
    nome TEXT,
    is_admin BOOLEAN DEFAULT 0,
    data_cadastro DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS anuncios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    empresa TEXT NOT NULL,
    email TEXT NOT NULL,
    telefone TEXT NOT NULL,
    tipo TEXT NOT NULL,
    mensagem TEXT NOT NULL,
    imagem TEXT,
    status TEXT DEFAULT 'pendente',
    data_criacao DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Usuário admin
  db.get(`SELECT * FROM usuarios WHERE email = 'admin@admin.com'`, (err, row) => {
    if (!row) {
      db.run(`INSERT INTO usuarios (email, senha, nome, is_admin) VALUES (?, ?, ?, ?)`,
        ['admin@admin.com', 'admin123', 'Administrador', 1]
      );
      console.log('✅ Usuário admin criado: admin@admin.com / admin123');
    }
  });
});

// === ROTAS PÚBLICAS ===
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

app.get('/api/news-by-category', (req, res) => {
  const query = `
    SELECT id, titulo, resumo, categoria, imagem, 
           strftime('%d/%m/%Y às %H:%M', data_criacao) as data
    FROM noticias
    ORDER BY data_criacao DESC
  `;
  db.all(query, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const categorias = {};
    rows.forEach(row => {
      if (!categorias[row.categoria]) categorias[row.categoria] = [];
      categorias[row.categoria].push(row);
    });
    res.json(categorias);
  });
});

app.get('/api/noticia', (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'ID necessário' });
  const query = `
    SELECT id, titulo, resumo, corpo, categoria, imagem,
           strftime('%d/%m/%Y às %H:%M', data_criacao) as data
    FROM noticias WHERE id = ?
  `;
  db.get(query, [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(row || {});
  });
});

app.get('/api/noticias', (req, res) => {
  const { categoria } = req.query;
  let query = `
    SELECT id, titulo, resumo, categoria, imagem,
           strftime('%d/%m/%Y às %H:%M', data_criacao) as data
    FROM noticias
  `;
  const params = [];
  if (categoria) {
    query += ' WHERE categoria = ?';
    params.push(categoria);
  }
  query += ' ORDER BY data_criacao DESC';
  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/search', (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  const query = `
    SELECT id, titulo, resumo, categoria, imagem,
           strftime('%d/%m/%Y às %H:%M', data_criacao) as data
    FROM noticias
    WHERE titulo LIKE ? OR resumo LIKE ? OR corpo LIKE ?
    ORDER BY data_criacao DESC
  `;
  const term = `%${q}%`;
  db.all(query, [term, term, term], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/add-ad', upload.single('imagem'), (req, res) => {
  const { nome, empresa, email, telefone, tipo, mensagem } = req.body;
  const imagem = req.file ? `/uploads/${req.file.filename}` : null;
  
  const query = `
    INSERT INTO anuncios (nome, empresa, email, telefone, tipo, mensagem, imagem)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;
  db.run(query, [nome, empresa, email, telefone, tipo, mensagem, imagem], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, success: true });
  });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const query = 'SELECT id, email, is_admin FROM usuarios WHERE email = ? AND senha = ?';
  db.get(query, [email, password], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (row) {
      res.json({
        success: true,
        token: 'fake-jwt-token',
        isAdmin: row.is_admin
      });
    } else {
      res.status(401).json({ error: 'Credenciais inválidas' });
    }
  });
});

app.post('/api/register', (req, res) => {
  const { email, password } = req.body;
  const query = 'INSERT INTO usuarios (email, senha) VALUES (?, ?)';
  db.run(query, [email, password], function(err) {
    if (err) {
      if (err.message.includes('UNIQUE')) {
        return res.status(400).json({ error: 'E-mail já cadastrado' });
      }
      return res.status(500).json({ error: err.message });
    }
    res.json({ success: true, id: this.lastID });
  });
});

// === ROTAS ADMIN ===
const authAdmin = (req, res, next) => {
  // Em produção, adicione autenticação real
  next();
};

app.get('/api/admin-dashboard', authAdmin, (req, res) => {
  const stats = {};
  db.get('SELECT COUNT(*) as total FROM usuarios', (err, row) => {
    stats.totalUsuarios = row ? row.total : 0;
    db.get('SELECT COUNT(*) as total FROM noticias', (err, row) => {
      stats.totalNoticias = row ? row.total : 0;
      db.get('SELECT COUNT(*) as total FROM anuncios WHERE status = "ativo"', (err, row) => {
        stats.totalAnuncios = row ? row.total : 0;
        res.json(stats);
      });
    });
  });
});

app.get('/api/realtime', authAdmin, (req, res) => {
  res.json([
    { usuario: 'admin', acao: 'Login', categoria: 'Sistema', data: new Date().toISOString() },
    { usuario: 'joao@email.com', acao: 'Visualizou Política', categoria: 'Política', data: new Date(Date.now() - 3600000).toISOString() }
  ]);
});

// Notícias
app.get('/api/noticias-admin', authAdmin, (req, res) => {
  const query = `
    SELECT id, titulo, categoria, 
           strftime('%d/%m/%Y %H:%M', data_criacao) as data
    FROM noticias
    ORDER BY data_criacao DESC
  `;
  db.all(query, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/add-news', authAdmin, upload.single('imagem'), (req, res) => {
  const { titulo, categoria, resumo, corpo } = req.body;
  const imagem = req.file ? `/uploads/${req.file.filename}` : null;
  
  if (!titulo || !categoria || !resumo || !corpo) {
    return res.status(400).json({ error: 'Todos os campos obrigatórios devem ser preenchidos' });
  }
  
  const query = `
    INSERT INTO noticias (titulo, categoria, resumo, corpo, imagem)
    VALUES (?, ?, ?, ?, ?)
  `;
  db.run(query, [titulo, categoria, resumo, corpo, imagem], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, success: true });
  });
});

// Anúncios
app.get('/api/anuncios', authAdmin, (req, res) => {
  const query = `
    SELECT id, nome, empresa, status, imagem,
           strftime('%d/%m/%Y', data_criacao) as data
    FROM anuncios
    ORDER BY data_criacao DESC
  `;
  db.all(query, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/add-anuncio', authAdmin, upload.single('imagem'), (req, res) => {
  const { nome, empresa, email, telefone, tipo, mensagem } = req.body;
  const imagem = req.file ? `/uploads/${req.file.filename}` : null;
  
  if (!nome || !empresa || !email || !telefone || !tipo || !mensagem) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
  }
  
  const query = `
    INSERT INTO anuncios (nome, empresa, email, telefone, tipo, mensagem, imagem)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;
  db.run(query, [nome, empresa, email, telefone, tipo, mensagem, imagem], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, success: true });
  });
});

app.delete('/api/delete-anuncio/:id', authAdmin, (req, res) => {
  const { id } = req.params;
  const { senha } = req.body;
  
  // Verificar senha do admin (em produção, use hash)
  if (senha !== 'admin123') {
    return res.status(401).json({ error: 'Senha do administrador incorreta' });
  }
  
  // Verificar se o anúncio existe e obter o caminho da imagem
  db.get('SELECT imagem FROM anuncios WHERE id = ?', [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Anúncio não encontrado' });
    
    // Excluir arquivo de imagem se existir
    if (row.imagem) {
      const imagePath = path.join(__dirname, '..', row.imagem);
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }
    }
    
    // Excluir do banco
    db.run('DELETE FROM anuncios WHERE id = ?', [id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
  });
});

// Usuários
app.get('/api/usuarios', authAdmin, (req, res) => {
  const query = `
    SELECT nome, email, 
           strftime('%d/%m/%Y', data_cadastro) as data_cadastro
    FROM usuarios
    ORDER BY data_cadastro DESC
  `;
  db.all(query, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/export-leads', authAdmin, (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=leads_usuarios.csv');
  res.write('Nome,E-mail,Data de Cadastro\n');
  db.each('SELECT nome, email, data_cadastro FROM usuarios', (err, row) => {
    if (row) {
      res.write(`"${row.nome || ''}","${row.email}","${row.data_cadastro}"\n`);
    }
  }, () => {
    res.end();
  });
});

// Upload de imagens
app.post('/api/upload', authAdmin, upload.single('imagem'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  }
  res.json({ filename: `/uploads/${req.file.filename}` });
});

// Servir admin
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../admin/index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Servidor rodando em http://localhost:${PORT}`);
  console.log(`🏠 Frontend: http://localhost:${PORT}`);
  console.log(`🛠️  Admin: http://localhost:${PORT}/admin`);
  console.log(`🔐 Login admin: admin@admin.com / admin123`);
});