if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const Joi = require('joi');
const { initDatabase } = require('./database');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const server = http.createServer(app);

// Настройка CORS
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:3000', 'https://marketplace-production-33bc.up.railway.app'];

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret';
const RAILWAY_URL = process.env.RAILWAY_URL || 'https://marketplace-production-33bc.up.railway.app';

// Безопасность с правильной CSP
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://cdn.tailwindcss.com", "https://cdn.socket.io", "'unsafe-inline'"],
        styleSrc: ["'self'", "https://fonts.googleapis.com", "'unsafe-inline'"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'", "ws://localhost:3000", "wss://localhost:3000", "wss://marketplace-production-33bc.up.railway.app"],
        frameSrc: ["'self'", "https://checkout.stripe.com"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
  })
);

app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));
app.set('trust proxy', 1);

// ---------- Rate Limiting ----------
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Слишком много запросов, попробуйте позже.'
});
app.use(generalLimiter);

// Аутентификация с возвратом времени блокировки
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    const retryAfter = Math.ceil((req.rateLimit.resetTime - Date.now()) / 1000);
    res.status(429).json({
      error: 'Слишком много попыток',
      retryAfter: retryAfter,
      message: `Пожалуйста, подождите ${retryAfter} сек. перед следующей попыткой.`
    });
  }
});

const paymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: 'Слишком много запросов на пополнение, попробуйте позже.'
});

// ---------- Multer ----------
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    cb(null, uuidv4() + path.extname(file.originalname));
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|gif|webp/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);
    if (mimetype && extname) return cb(null, true);
    cb(new Error('Only image files are allowed!'));
  }
});

let run, get, all;

function addNotification(userId, message, type) {
  const id = uuidv4();
  run('INSERT INTO notifications (id, userId, message, type) VALUES (?, ?, ?, ?)', [id, userId, message, type]);
}

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

// ---------- Валидация Joi ----------
const registerSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(6).required(),
  name: Joi.string().min(1).required(),
  phone: Joi.string().allow('').optional()
});

const listingSchema = Joi.object({
  title: Joi.string().min(3).max(100).required(),
  description: Joi.string().min(10).required(),
  price: Joi.number().positive().required(),
  category: Joi.string().valid('electronics', 'clothing', 'auto', 'realty', 'other').required(),
  condition: Joi.string().valid('new', 'used').optional(),
  location: Joi.string().optional()
});

// ---------- AUTH ----------
app.post('/api/register', authLimiter, async (req, res) => {
  const { error, value } = registerSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });

  const { email, password, name, phone } = value;
  try {
    const existing = get('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) return res.status(409).json({ error: 'Email already in use' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const id = uuidv4();
    run('INSERT INTO users (id, email, password, name, phone) VALUES (?, ?, ?, ?, ?)', [id, email, hashedPassword, name, phone || null]);
    const token = jwt.sign({ id, email, name, role: 'user' }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user: { id, email, name, phone } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Missing fields' });

  const user = get('SELECT * FROM users WHERE email = ?', [email]);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, phone: user.phone } });
});

// ---------- LISTINGS ----------
app.get('/api/listings', (req, res) => {
  const { search, category, minPrice, maxPrice, page = 1, limit = 12 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  let query = 'SELECT l.*, u.name as sellerName, u.phone as sellerPhone, u.rating as sellerRating FROM listings l LEFT JOIN users u ON l.userId = u.id WHERE l.status = "active"';
  const params = [];

  if (search) {
    query += ' AND l.title LIKE ?';
    params.push(`%${search}%`);
  }
  if (category && category !== 'all') {
    query += ' AND l.category = ?';
    params.push(category);
  }
  if (minPrice) {
    query += ' AND l.price >= ?';
    params.push(parseFloat(minPrice));
  }
  if (maxPrice) {
    query += ' AND l.price <= ?';
    params.push(parseFloat(maxPrice));
  }

  query += ' ORDER BY l.createdAt DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), offset);

  const listings = all(query, params);
  const countQuery = 'SELECT COUNT(*) as total FROM listings WHERE status = "active"' +
    (search ? ' AND title LIKE ?' : '') +
    (category && category !== 'all' ? ' AND category = ?' : '') +
    (minPrice ? ' AND price >= ?' : '') +
    (maxPrice ? ' AND price <= ?' : '');
  const countParams = [];
  if (search) countParams.push(`%${search}%`);
  if (category && category !== 'all') countParams.push(category);
  if (minPrice) countParams.push(parseFloat(minPrice));
  if (maxPrice) countParams.push(parseFloat(maxPrice));
  const totalRow = get(countQuery, countParams);
  const total = totalRow ? totalRow.total : 0;

  res.json({ listings, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
});

app.get('/api/listings/:id', (req, res) => {
  const listing = get(
    'SELECT l.*, u.name as sellerName, u.phone as sellerPhone, u.rating as sellerRating FROM listings l LEFT JOIN users u ON l.userId = u.id WHERE l.id = ?',
    [req.params.id]
  );
  if (!listing) return res.status(404).json({ error: 'Not found' });
  listing.images = listing.images ? JSON.parse(listing.images) : [];
  res.json(listing);
});

app.post('/api/listings', authenticateToken, upload.array('images', 5), (req, res) => {
  const { error, value } = listingSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });

  const { title, description, price, category, condition, location } = value;
  const images = req.files ? req.files.map(f => '/uploads/' + f.filename) : [];
  const id = uuidv4();
  run('INSERT INTO listings (id, title, description, price, category, condition, location, images, userId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, title, description, parseFloat(price), category, condition || 'used', location || '', JSON.stringify(images), req.user.id]);
  const listing = get('SELECT * FROM listings WHERE id = ?', [id]);
  listing.images = JSON.parse(listing.images);
  res.status(201).json(listing);
});

app.patch('/api/listings/:id', authenticateToken, (req, res) => {
  const { status } = req.body;
  const listing = get('SELECT * FROM listings WHERE id = ?', [req.params.id]);
  if (!listing) return res.status(404).json({ error: 'Not found' });
  if (listing.userId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  run('UPDATE listings SET status = ? WHERE id = ?', [status, req.params.id]);

  const sellerId = listing.userId;
  if (req.user.id !== sellerId) {
    addNotification(sellerId, `Статус вашего объявления "${listing.title}" изменён на "${status}"`, 'listing_status');
    io.to(sellerId).emit('notification', {
      message: `Статус вашего объявления "${listing.title}" изменён на "${status}"`,
      type: 'listing_status'
    });
  }

  res.json({ success: true });
});

app.delete('/api/listings/:id', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  run('DELETE FROM listings WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

// ---------- FAVORITES ----------
app.get('/api/favorites', authenticateToken, (req, res) => {
  const favs = all('SELECT l.*, u.name as sellerName FROM favorites f JOIN listings l ON f.listingId = l.id JOIN users u ON l.userId = u.id WHERE f.userId = ?', [req.user.id]);
  favs.forEach(f => f.images = f.images ? JSON.parse(f.images) : []);
  res.json(favs);
});

app.post('/api/favorites/:listingId', authenticateToken, (req, res) => {
  const { listingId } = req.params;
  const existing = get('SELECT * FROM favorites WHERE userId = ? AND listingId = ?', [req.user.id, listingId]);
  if (existing) return res.status(409).json({ error: 'Already in favorites' });
  run('INSERT INTO favorites (id, userId, listingId) VALUES (?, ?, ?)', [uuidv4(), req.user.id, listingId]);

  const listing = get('SELECT userId, title FROM listings WHERE id = ?', [listingId]);
  if (listing && listing.userId !== req.user.id) {
    addNotification(listing.userId, `Кто-то добавил ваше объявление "${listing.title}" в избранное`, 'favorite');
    io.to(listing.userId).emit('notification', {
      message: `Кто-то добавил ваше объявление "${listing.title}" в избранное`,
      type: 'favorite'
    });
  }

  res.json({ success: true });
});

app.delete('/api/favorites/:listingId', authenticateToken, (req, res) => {
  run('DELETE FROM favorites WHERE userId = ? AND listingId = ?', [req.user.id, req.params.listingId]);
  res.json({ success: true });
});

// ---------- MESSAGES ----------
app.get('/api/messages/:listingId', authenticateToken, (req, res) => {
  const messages = all(
    'SELECT m.*, u.name as senderName FROM messages m JOIN users u ON m.senderId = u.id WHERE m.listingId = ? ORDER BY m.createdAt ASC',
    [req.params.listingId]
  );
  res.json(messages);
});

app.post('/api/messages', authenticateToken, (req, res) => {
  const { listingId, text } = req.body;
  if (!listingId || !text) return res.status(400).json({ error: 'Missing fields' });
  const listing = get('SELECT userId FROM listings WHERE id = ?', [listingId]);
  if (!listing) return res.status(404).json({ error: 'Listing not found' });
  const id = uuidv4();
  run('INSERT INTO messages (id, text, senderId, receiverId, listingId) VALUES (?, ?, ?, ?, ?)', [id, text, req.user.id, listing.userId, listingId]);
  const msg = get('SELECT * FROM messages WHERE id = ?', [id]);
  res.status(201).json(msg);
});

// ---------- REVIEWS ----------
app.get('/api/reviews/user/:userId', (req, res) => {
  const reviews = all(
    'SELECT r.*, u.name as authorName FROM reviews r JOIN users u ON r.authorId = u.id WHERE r.userId = ? ORDER BY r.createdAt DESC',
    [req.params.userId]
  );
  res.json(reviews);
});

app.post('/api/reviews', authenticateToken, (req, res) => {
  const { userId, rating, text } = req.body;
  if (!userId || !rating || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Missing fields or invalid rating' });
  }
  if (userId === req.user.id) {
    return res.status(400).json({ error: 'Cannot review yourself' });
  }

  const id = uuidv4();
  run('INSERT INTO reviews (id, text, rating, authorId, userId) VALUES (?, ?, ?, ?, ?)',
    [id, text || '', rating, req.user.id, userId]);

  const avg = get('SELECT AVG(rating) as avgRating FROM reviews WHERE userId = ?', [userId]);
  run('UPDATE users SET rating = ? WHERE id = ?', [avg ? (avg.avgRating || 0) : 0, userId]);

  const authorName = req.user.name;
  addNotification(userId, `Вам оставили новый отзыв от ${authorName} (${'⭐'.repeat(rating)})`, 'review');
  io.to(userId).emit('notification', {
    message: `Вам оставили новый отзыв от ${authorName} (${'⭐'.repeat(rating)})`,
    type: 'review'
  });

  const review = get('SELECT * FROM reviews WHERE id = ?', [id]);
  res.status(201).json(review);
});

// ---------- WALLET ----------
app.get('/api/wallet', authenticateToken, (req, res) => {
  const user = get('SELECT id, balance FROM users WHERE id = ?', [req.user.id]);
  const transactions = all(
    'SELECT * FROM transactions WHERE userId = ? ORDER BY createdAt DESC LIMIT 50',
    [req.user.id]
  );
  res.json({ balance: user.balance, transactions });
});

app.post('/api/wallet/deposit', authenticateToken, paymentLimiter, (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  const user = get('SELECT balance FROM users WHERE id = ?', [req.user.id]);
  const newBalance = user.balance + parseFloat(amount);
  run('UPDATE users SET balance = ? WHERE id = ?', [newBalance, req.user.id]);
  run('INSERT INTO transactions (id, type, amount, userId, status) VALUES (?, ?, ?, ?, ?)',
    [uuidv4(), 'deposit', parseFloat(amount), req.user.id, 'completed']);
  res.json({ balance: newBalance });
});

// ---------- STRIPE ----------
app.post('/api/stripe/create-checkout-session', authenticateToken, paymentLimiter, async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Укажите сумму' });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'rub',
          product_data: {
            name: 'Пополнение баланса Marketplace',
          },
          unit_amount: amount * 100,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${RAILWAY_URL}/api/stripe/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${RAILWAY_URL}/wallet.html`,
      client_reference_id: req.user.id,
      metadata: {
        userId: req.user.id
      }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    res.status(500).json({ error: 'Ошибка создания сессии' });
  }
});

app.get('/api/stripe/success', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.redirect('/wallet.html');

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status === 'paid') {
      const userId = session.metadata.userId;
      const amount = session.amount_total / 100;

      const existing = get('SELECT id FROM transactions WHERE listingId = ?', [session_id]);
      if (!existing) {
        const user = get('SELECT balance FROM users WHERE id = ?', [userId]);
        if (user) {
          const newBalance = user.balance + amount;
          run('UPDATE users SET balance = ? WHERE id = ?', [newBalance, userId]);
          run('INSERT INTO transactions (id, type, amount, userId, listingId, status) VALUES (?, ?, ?, ?, ?, ?)',
            [uuidv4(), 'deposit', amount, userId, session_id, 'completed']);
        }
      }
    }
    res.redirect('/wallet.html');
  } catch (err) {
    console.error('Stripe success error:', err);
    res.redirect('/wallet.html?error=stripe_error');
  }
});

// ---------- ESCROW ----------
app.post('/api/escrow/buy', authenticateToken, (req, res) => {
  const { listingId } = req.body;
  if (!listingId) return res.status(400).json({ error: 'Missing listingId' });

  const listing = get('SELECT * FROM listings WHERE id = ? AND status = "active"', [listingId]);
  if (!listing) return res.status(404).json({ error: 'Listing not found or not active' });
  if (listing.userId === req.user.id) return res.status(400).json({ error: 'Cannot buy your own listing' });

  const buyer = get('SELECT balance FROM users WHERE id = ?', [req.user.id]);
  if (buyer.balance < listing.price) return res.status(400).json({ error: 'Недостаточно средств' });

  run('UPDATE users SET balance = balance - ? WHERE id = ?', [listing.price, req.user.id]);
  const escrowId = uuidv4();
  run('INSERT INTO escrow (id, buyerId, sellerId, listingId, amount, status) VALUES (?, ?, ?, ?, ?, ?)',
    [escrowId, req.user.id, listing.userId, listingId, listing.price, 'pending']);
  run('INSERT INTO transactions (id, type, amount, userId, listingId, relatedUserId, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [uuidv4(), 'purchase', listing.price, req.user.id, listingId, listing.userId, 'pending']);
  run('UPDATE listings SET status = ? WHERE id = ?', ['sold_pending', listingId]);

  addNotification(req.user.id, `Вы купили "${listing.title}". Подтвердите получение, когда товар придёт.`, 'escrow_buy');
  addNotification(listing.userId, `Ваше объявление "${listing.title}" куплено. Ожидайте подтверждения от покупателя.`, 'escrow_sell');

  io.to(req.user.id).emit('notification', {
    message: `Вы купили "${listing.title}". Подтвердите получение, когда товар придёт.`,
    type: 'escrow_buy'
  });
  io.to(listing.userId).emit('notification', {
    message: `Ваше объявление "${listing.title}" куплено. Ожидайте подтверждения от покупателя.`,
    type: 'escrow_sell'
  });

  res.json({ success: true, escrowId });
});

app.post('/api/escrow/confirm', authenticateToken, (req, res) => {
  const { escrowId } = req.body;
  const escrow = get('SELECT * FROM escrow WHERE id = ? AND buyerId = ? AND status = ?', [escrowId, req.user.id, 'pending']);
  if (!escrow) return res.status(404).json({ error: 'Сделка не найдена' });

  run('UPDATE users SET balance = balance + ? WHERE id = ?', [escrow.amount, escrow.sellerId]);
  run('UPDATE escrow SET status = ? WHERE id = ?', ['completed', escrowId]);
  run('UPDATE listings SET status = ? WHERE id = ?', ['sold', escrow.listingId]);

  run('UPDATE transactions SET status = ? WHERE userId = ? AND listingId = ? AND type = ? AND status = ?',
    ['completed', escrow.buyerId, escrow.listingId, 'purchase', 'pending']);
  run('INSERT INTO transactions (id, type, amount, userId, listingId, relatedUserId, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [uuidv4(), 'sale', escrow.amount, escrow.sellerId, escrow.listingId, escrow.buyerId, 'completed']);

  addNotification(escrow.buyerId, 'Вы подтвердили получение. Деньги переведены продавцу.', 'escrow_completed');
  addNotification(escrow.sellerId, 'Покупатель подтвердил получение. Деньги зачислены на ваш счёт.', 'escrow_completed');

  io.to(escrow.buyerId).emit('notification', {
    message: 'Вы подтвердили получение. Деньги переведены продавцу.',
    type: 'escrow_completed'
  });
  io.to(escrow.sellerId).emit('notification', {
    message: 'Покупатель подтвердил получение. Деньги зачислены на ваш счёт.',
    type: 'escrow_completed'
  });

  res.json({ success: true });
});

app.post('/api/escrow/cancel', authenticateToken, (req, res) => {
  const { escrowId } = req.body;
  const escrow = get('SELECT * FROM escrow WHERE id = ? AND buyerId = ? AND status = ?', [escrowId, req.user.id, 'pending']);
  if (!escrow) return res.status(404).json({ error: 'Сделка не найдена' });

  run('UPDATE users SET balance = balance + ? WHERE id = ?', [escrow.amount, escrow.buyerId]);
  run('UPDATE escrow SET status = ? WHERE id = ?', ['cancelled', escrowId]);
  run('UPDATE listings SET status = ? WHERE id = ?', ['active', escrow.listingId]);

  run('UPDATE transactions SET status = ? WHERE userId = ? AND listingId = ? AND type = ? AND status = ?',
    ['cancelled', escrow.buyerId, escrow.listingId, 'purchase', 'pending']);

  addNotification(escrow.buyerId, 'Сделка отменена. Деньги возвращены.', 'escrow_cancelled');
  addNotification(escrow.sellerId, 'Покупатель отменил сделку.', 'escrow_cancelled');

  io.to(escrow.buyerId).emit('notification', {
    message: 'Сделка отменена. Деньги возвращены.',
    type: 'escrow_cancelled'
  });
  io.to(escrow.sellerId).emit('notification', {
    message: 'Покупатель отменил сделку.',
    type: 'escrow_cancelled'
  });

  res.json({ success: true });
});

// ---------- NOTIFICATIONS ----------
app.get('/api/notifications', authenticateToken, (req, res) => {
  const notifications = all(
    'SELECT * FROM notifications WHERE userId = ? ORDER BY createdAt DESC LIMIT 50',
    [req.user.id]
  );
  res.json(notifications);
});

app.post('/api/notifications/read', authenticateToken, (req, res) => {
  run('UPDATE notifications SET read = 1 WHERE userId = ? AND read = 0', [req.user.id]);
  res.json({ success: true });
});

// ---------- PROFILE ----------
app.get('/api/profile', authenticateToken, (req, res) => {
  const user = get('SELECT id, email, name, phone, role, rating, balance FROM users WHERE id = ?', [req.user.id]);
  const listings = all('SELECT * FROM listings WHERE userId = ? ORDER BY createdAt DESC', [req.user.id]);
  listings.forEach(l => l.images = l.images ? JSON.parse(l.images) : []);
  res.json({ user, listings });
});

// ---------- WebSocket ----------
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication error'));
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return next(new Error('Authentication error'));
    socket.userId = decoded.id;
    socket.userName = decoded.name;
    next();
  });
});

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.userName} (${socket.userId})`);
  socket.join(socket.userId);

  socket.on('send_message', async (data) => {
    const { listingId, text } = data;
    if (!listingId || !text) return;

    const listing = get('SELECT userId, title FROM listings WHERE id = ?', [listingId]);
    if (!listing) return;

    let receiverId;
    if (listing.userId !== socket.userId) {
      receiverId = listing.userId;
    } else {
      const lastMsg = get(
        'SELECT senderId FROM messages WHERE listingId = ? AND senderId != ? ORDER BY createdAt DESC LIMIT 1',
        [listingId, socket.userId]
      );
      if (!lastMsg) {
        socket.emit('error', 'Нет собеседника для этого объявления');
        return;
      }
      receiverId = lastMsg.senderId;
    }

    if (receiverId === socket.userId) return;

    const id = uuidv4();
    run('INSERT INTO messages (id, text, senderId, receiverId, listingId) VALUES (?, ?, ?, ?, ?)',
      [id, text, socket.userId, receiverId, listingId]);

    const msg = {
      id,
      text,
      senderId: socket.userId,
      senderName: socket.userName,
      receiverId,
      listingId,
      createdAt: new Date().toISOString()
    };

    io.to(receiverId).emit('new_message', msg);
    socket.emit('message_sent', msg);

    addNotification(receiverId, `Новое сообщение от ${socket.userName} по объявлению "${listing.title}"`, 'message');
    io.to(receiverId).emit('notification', {
      message: `Новое сообщение от ${socket.userName} по объявлению "${listing.title}"`,
      type: 'message'
    });
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.userName}`);
  });
});

// Fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling
app.use((err, req, res, next) => {
  console.error(err);
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  if (err.message === 'Only image files are allowed!') {
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: 'Something went wrong' });
});

// Запуск
initDatabase().then(({ run: _run, get: _get, all: _all }) => {
  run = _run;
  get = _get;
  all = _all;

  const bcrypt = require('bcryptjs');
  const { v4: uuidv4 } = require('uuid');
  const admin = get('SELECT id FROM users WHERE email = ?', ['admin@marketplace.com']);
  if (!admin) {
    const hashedPassword = bcrypt.hashSync('admin123', 10);
    run('INSERT INTO users (id, email, password, name, role, balance) VALUES (?, ?, ?, ?, ?, ?)', [
      uuidv4(), 'admin@marketplace.com', hashedPassword, 'Admin', 'admin', 100000
    ]);
  }

  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});