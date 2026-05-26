// ═══════════════════════════════════════════════════════
//  Problem Bank API  —  server.js
//  Deploy on Railway / Render / any Node host
//  Node 18+  |  npm install express cors firebase-admin
// ═══════════════════════════════════════════════════════

const express = require('express');
const cors    = require('cors');

// ── Firebase Admin ───────────────────────────────────────
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore }                 = require('firebase-admin/firestore');
const { getAuth }                      = require('firebase-admin/auth');

// Supports both serviceAccountKey.json and env-var approach (for Railway)
let firebaseApp;
if (!getApps().length) {
  const credential = process.env.FIREBASE_PRIVATE_KEY
    ? cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        // Railway stores the key as a single-line string with literal \n
        privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      })
    : cert(require('./serviceAccountKey.json'));   // local dev

  firebaseApp = initializeApp({ credential });
}

const db = getFirestore();

// ── Express setup ────────────────────────────────────────
const app = express();

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .concat(['http://localhost:5500', 'http://127.0.0.1:5500']);

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes('*')) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));

// ── Middleware: verify Firebase ID token + admin claim ───
const verifyAdmin = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized — no token' });
  }
  try {
    const token   = authHeader.split(' ')[1];
    const decoded = await getAuth().verifyIdToken(token);
    // Accept if the custom claim "admin" or "isAdmin" is truthy
    if (!decoded.admin && !decoded.isAdmin) {
      return res.status(403).json({ error: 'Forbidden — not an admin' });
    }
    req.user = decoded;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// ── Health check ─────────────────────────────────────────
app.get('/', (_req, res) => res.json({ status: 'ok', service: 'Problem Bank API' }));

// ────────────────────────────────────────────────────────
//  POST /api/problems  — create a new problem
// ────────────────────────────────────────────────────────
app.post('/api/problems', verifyAdmin, async (req, res) => {
  try {
    const { title, statement, constraints, examples, tests, difficulty, tags } = req.body;

    if (!title?.trim())     return res.status(400).json({ error: 'title is required' });
    if (!statement?.trim()) return res.status(400).json({ error: 'statement is required' });

    const problemData = {
      title:       title.trim(),
      statement:   statement.trim(),
      constraints: (constraints || '').trim(),
      examples:    Array.isArray(examples) ? examples : [],
      tests:       Array.isArray(tests)    ? tests    : [],
      difficulty:  difficulty || 'medium',
      tags:        Array.isArray(tags) ? tags : [],
      createdAt:   new Date().toISOString(),
      createdBy:   req.user.uid,
      status:      'active',
    };

    const ref          = await db.collection('problems_bank').add(problemData);
    const BASE_URL     = process.env.PUBLIC_URL || `https://${req.headers.host}`;
    const shareableLink = `${BASE_URL}/problems/${ref.id}`;

    await ref.update({ shareableLink, id: ref.id });

    res.json({
      success: true,
      problemId:    ref.id,
      shareableLink,
      embedCode: `<iframe src="${shareableLink}/embed" width="100%" height="600" frameborder="0"></iframe>`,
    });
  } catch (e) {
    console.error('POST /api/problems', e);
    res.status(500).json({ error: e.message });
  }
});

// ────────────────────────────────────────────────────────
//  GET /api/problems  — list all problems (admin only)
// ────────────────────────────────────────────────────────
app.get('/api/problems', verifyAdmin, async (req, res) => {
  try {
    const snap = await db.collection('problems_bank')
      .where('status', '==', 'active')
      .orderBy('createdAt', 'desc')
      .get();
    const problems = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ problems });
  } catch (e) {
    console.error('GET /api/problems', e);
    res.status(500).json({ error: e.message });
  }
});

// ────────────────────────────────────────────────────────
//  GET /api/problems/:id  — get a single problem (public)
// ────────────────────────────────────────────────────────
app.get('/api/problems/:id', async (req, res) => {
  try {
    const docSnap = await db.collection('problems_bank').doc(req.params.id).get();
    if (!docSnap.exists) return res.status(404).json({ error: 'Not found' });
    // Strip hidden tests for public access (no auth)
    const data = { id: docSnap.id, ...docSnap.data() };
    if (!req.headers.authorization) delete data.tests;   // hide hidden tests
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ────────────────────────────────────────────────────────
//  PUT /api/problems/:id  — update a problem (admin only)
// ────────────────────────────────────────────────────────
app.put('/api/problems/:id', verifyAdmin, async (req, res) => {
  try {
    const ref = db.collection('problems_bank').doc(req.params.id);
    const existing = await ref.get();
    if (!existing.exists) return res.status(404).json({ error: 'Not found' });

    const { title, statement, constraints, examples, tests, difficulty, tags } = req.body;
    const updates = {};
    if (title       !== undefined) updates.title       = title.trim();
    if (statement   !== undefined) updates.statement   = statement.trim();
    if (constraints !== undefined) updates.constraints = constraints.trim();
    if (examples    !== undefined) updates.examples    = examples;
    if (tests       !== undefined) updates.tests       = tests;
    if (difficulty  !== undefined) updates.difficulty  = difficulty;
    if (tags        !== undefined) updates.tags        = tags;
    updates.updatedAt = new Date().toISOString();

    await ref.update(updates);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ────────────────────────────────────────────────────────
//  DELETE /api/problems/:id  — soft-delete (admin only)
// ────────────────────────────────────────────────────────
app.delete('/api/problems/:id', verifyAdmin, async (req, res) => {
  try {
    const ref = db.collection('problems_bank').doc(req.params.id);
    await ref.update({ status: 'deleted', deletedAt: new Date().toISOString() });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ────────────────────────────────────────────────────────
//  POST /api/problems/:id/import-to-contest
//  Copies a problem from the bank into a contest sub-collection
// ────────────────────────────────────────────────────────
app.post('/api/problems/:id/import-to-contest', verifyAdmin, async (req, res) => {
  try {
    const { contestId, problemOrder } = req.body;
    if (!contestId) return res.status(400).json({ error: 'contestId is required' });

    const docSnap = await db.collection('problems_bank').doc(req.params.id).get();
    if (!docSnap.exists) return res.status(404).json({ error: 'Problem not found in bank' });

    const data = docSnap.data();
    const contestProblem = {
      title:        data.title,
      statement:    data.statement,
      constraints:  data.constraints || '',
      examples:     data.examples    || [],
      tests:        data.tests       || [],
      order:        typeof problemOrder === 'number' ? problemOrder : 1,
      importedFrom: req.params.id,
      importedAt:   new Date().toISOString(),
    };

    const ref = await db
      .collection('contests').doc(contestId)
      .collection('problems').add(contestProblem);

    res.json({
      success:          true,
      contestProblemId: ref.id,
      message:          'Problem imported successfully',
    });
  } catch (e) {
    console.error('import-to-contest', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Start server ─────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅  Problem Bank API running → http://localhost:${PORT}`);
});
