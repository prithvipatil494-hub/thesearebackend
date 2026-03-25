require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const app  = express();
app.use(cors());
app.use(express.json());

// ── MongoDB Connection ────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => { console.error('❌ MongoDB error:', err.message); process.exit(1); });

// ── Models ────────────────────────────────────────────────────────────────────
const User = mongoose.model('User', new mongoose.Schema({
  uid:         { type: String, required: true, unique: true },
  trackId:     { type: String, required: true, unique: true, uppercase: true },
  displayName: { type: String, default: '' },
  email:       { type: String, default: '' },
  friends:     { type: [String], default: [] },
}, { timestamps: true }));

const Location = mongoose.model('Location', new mongoose.Schema({
  trackId:   { type: String, required: true, unique: true, uppercase: true },
  lat:       { type: Number, required: true },
  lng:       { type: Number, required: true },
  accuracy:  { type: Number, default: 0 },
  speed:     { type: Number, default: 0 },
  updatedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: () => new Date(Date.now() + 24 * 60 * 60 * 1000) },
}));
Location.schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const Session = mongoose.model('Session', new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true },
  uid:       { type: String, required: true },
  trackId:   { type: String, required: true, uppercase: true },
  startTime: String,
  endTime:   String,
  points:    { type: [{ lat: Number, lng: Number, ts: { type: Date, default: Date.now } }], default: [] },
}, { timestamps: true }));

const Message = mongoose.model('Message', new mongoose.Schema({
  roomId:     { type: String, required: true },
  senderId:   { type: String, required: true },
  senderName: { type: String, default: '' },
  text:       { type: String, required: true },
  sentAt:     { type: Date, default: Date.now },
}));
Message.schema.index({ roomId: 1, sentAt: -1 });
Message.schema.index({ sentAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const ok = mongoose.connection.readyState === 1;
  res.json({ status: ok ? 'OK' : 'DEGRADED', uptime: process.uptime() });
});

// ── Track ID ──────────────────────────────────────────────────────────────────
app.post('/api/track/generate', (req, res) => {
  res.json({ trackId: 'TRK-' + uuidv4().replace(/-/g, '').substring(0, 8).toUpperCase() });
});

// ── Location ──────────────────────────────────────────────────────────────────
app.post('/api/location/update', async (req, res) => {
  const { trackId, lat, lng, accuracy = 0, speed = 0 } = req.body;
  if (!trackId || lat == null || lng == null)
    return res.status(400).json({ error: 'trackId, lat and lng required' });
  try {
    const now = new Date();
    await Location.findOneAndUpdate(
      { trackId: trackId.toUpperCase() },
      { $set: { lat, lng, accuracy, speed, updatedAt: now, expiresAt: new Date(now.getTime() + 86400000) } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/location/:trackId', async (req, res) => {
  try {
    const doc = await Location.findOne({ trackId: req.params.trackId.toUpperCase() });
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json({
      trackId: doc.trackId, lat: doc.lat, lng: doc.lng,
      accuracy: doc.accuracy, speed: doc.speed,
      isRecent: (Date.now() - doc.updatedAt.getTime()) < 30000,
      updatedAt: doc.updatedAt,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── User ──────────────────────────────────────────────────────────────────────
app.post('/api/user/upsert', async (req, res) => {
  const { uid, trackId, displayName = '', email = '' } = req.body;
  if (!uid || !trackId) return res.status(400).json({ error: 'uid and trackId required' });
  try {
    const user = await User.findOneAndUpdate(
      { uid },
      { $set: { displayName, email }, $setOnInsert: { trackId: trackId.toUpperCase() } },
      { upsert: true, new: true }
    );
    res.json(user);
  } catch (e) {
    if (e.code === 11000) return res.json(await User.findOne({ uid }));
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/user/:uid', async (req, res) => {
  try {
    const user = await User.findOne({ uid: req.params.uid });
    if (!user) return res.status(404).json({ error: 'Not found' });
    res.json(user);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/user/by-trackid/:trackId', async (req, res) => {
  try {
    const user = await User.findOne({ trackId: req.params.trackId.toUpperCase() });
    if (!user) return res.status(404).json({ error: 'Not found' });
    res.json({ uid: user.uid, trackId: user.trackId, displayName: user.displayName });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/user/:uid/friends', async (req, res) => {
  const { friends } = req.body;
  if (!Array.isArray(friends)) return res.status(400).json({ error: 'friends must be array' });
  if (friends.length > 4) return res.status(400).json({ error: 'Max 4 friends' });
  try {
    const user = await User.findOneAndUpdate(
      { uid: req.params.uid },
      { $set: { friends: friends.map(f => f.toUpperCase()) } },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'Not found' });
    res.json({ friends: user.friends });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/user/:uid/friends/:trackId', async (req, res) => {
  try {
    const user = await User.findOneAndUpdate(
      { uid: req.params.uid },
      { $pull: { friends: req.params.trackId.toUpperCase() } },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'Not found' });
    res.json({ friends: user.friends });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Sessions ──────────────────────────────────────────────────────────────────
app.post('/api/session/start', async (req, res) => {
  const { sessionId, uid, trackId, startTime } = req.body;
  if (!sessionId || !uid || !trackId) return res.status(400).json({ error: 'sessionId, uid, trackId required' });
  try {
    const s = await Session.create({ sessionId, uid, trackId, startTime });
    res.status(201).json(s);
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'Session exists' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/session/:sessionId/point', async (req, res) => {
  const pts = Array.isArray(req.body.points) ? req.body.points : [{ lat: req.body.lat, lng: req.body.lng }];
  try {
    const s = await Session.findOneAndUpdate(
      { sessionId: req.params.sessionId },
      { $push: { points: { $each: pts } } },
      { new: true }
    );
    if (!s) return res.status(404).json({ error: 'Not found' });
    res.json({ pointCount: s.points.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/session/:sessionId/end', async (req, res) => {
  try {
    const s = await Session.findOneAndUpdate(
      { sessionId: req.params.sessionId },
      { $set: { endTime: req.body.endTime ?? new Date().toISOString() } },
      { new: true }
    );
    if (!s) return res.status(404).json({ error: 'Not found' });
    res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/session/user/:uid', async (req, res) => {
  try {
    const sessions = await Session.find({ uid: req.params.uid }).sort({ createdAt: -1 }).select('-points').lean();
    res.json(sessions);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/session/:sessionId', async (req, res) => {
  try {
    const s = await Session.findOne({ sessionId: req.params.sessionId }).lean();
    if (!s) return res.status(404).json({ error: 'Not found' });
    res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Chat ──────────────────────────────────────────────────────────────────────
const roomId = (a, b) => [a.toUpperCase(), b.toUpperCase()].sort().join('::');

app.post('/api/chat/send', async (req, res) => {
  const { senderId, recipientId, senderName = '', text } = req.body;
  if (!senderId || !recipientId || !text) return res.status(400).json({ error: 'senderId, recipientId, text required' });
  try {
    const msg = await Message.create({ roomId: roomId(senderId, recipientId), senderId: senderId.toUpperCase(), senderName, text });
    res.status(201).json(msg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/chat/room/:idA/:idB', async (req, res) => {
  const rid   = roomId(req.params.idA, req.params.idB);
  const limit = Math.min(parseInt(req.query.limit ?? '50'), 100);
  try {
    const msgs = await Message.find({ roomId: rid }).sort({ sentAt: -1 }).limit(limit).lean();
    res.json(msgs.reverse());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 LiveLoc running on port ${PORT}`));
