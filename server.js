require('dotenv').config();

const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
const http     = require('http');
const socketIo = require('socket.io');
const Redis    = require('ioredis');

const app    = express();
const server = http.createServer(app);

// ─── Redis ────────────────────────────────────────────────────────────────────
const redis = new Redis(
  "redis://default:4rgHpsmaNQ2qIXA8ktlxeoX2UFNdFXKQ@redis-16268.crce292.ap-south-1-2.ec2.cloud.redislabs.com:16268",
  {
    connectTimeout: 5000,
    maxRetriesPerRequest: 2,
    lazyConnect: false,
  }
);

redis.on("connect", () => console.log("✅ Redis connected"));
redis.on("error",   (e) => console.error("❌ Redis error:", e.message));

const REDIS_TTL = 30;

async function cacheLocation(trackId, data) {
  const key     = `loc:${trackId}`;
  const payload = JSON.stringify({ ...data, ts: Date.now() });
  await redis.setex(key, REDIS_TTL, payload);
}

// FIX BUG 2 (part 1): store recipientId in targeted cache so DB fallback works
async function cacheLocationTargeted(trackId, recipientId, data) {
  const key     = `loc:${trackId}:for:${recipientId}`;
  const payload = JSON.stringify({ ...data, recipientId, ts: Date.now() });
  await redis.setex(key, REDIS_TTL, payload);
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────
const io = socketIo(server, {
  cors: {
    origin: [
      'http://localhost:3000',
      'http://localhost:5173',
      /\.vercel\.app$/,
    ],
    credentials: true,
    methods: ['GET', 'POST'],
  },
  transports:   ['websocket', 'polling'],
  pingTimeout:  60000,
  pingInterval: 25000,
});

// ─── CORS + JSON ──────────────────────────────────────────────────────────────
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:5173',
    /\.vercel\.app$/,
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());

// ─── MongoDB ──────────────────────────────────────────────────────────────────
const MONGODB_URI = process.env.MONGODB_URI || 'your_mongodb_connection_string_here';

mongoose.connect(MONGODB_URI, {
  useNewUrlParser:    true,
  useUnifiedTopology: true,
})
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// ─── SCHEMAS ──────────────────────────────────────────────────────────────────

const userRegistrySchema = new mongoose.Schema({
  uid:         { type: String, required: true, unique: true, index: true },
  trackId:     { type: String, required: true, unique: true, index: true },
  displayName: { type: String, default: '' },
  email:       { type: String, default: '' },
  friends:     { type: [String], default: [] },
  createdAt:   { type: Date, default: Date.now },
  updatedAt:   { type: Date, default: Date.now },
}, { collection: 'user_registry' });

userRegistrySchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

// FIX BUG 2 (part 2): added recipientId field so targeted locations can be
// stored and queried separately from broadcast locations in MongoDB fallback
const locationSchema = new mongoose.Schema({
  trackId:     { type: String, required: true, index: true },
  recipientId: { type: String, default: null, index: true }, // null = broadcast
  uid:         { type: String, index: true },
  lat:         { type: Number, required: true },
  lng:         { type: Number, required: true },
  speed:       { type: Number, default: 0 },
  accuracy:    { type: Number, default: 0 },
  timestamp:   { type: Date,   default: Date.now, index: true },
  isActive:    { type: Boolean, default: true },
}, { collection: 'locations' });

// Compound unique index: one record per (trackId, recipientId) pair
locationSchema.index({ trackId: 1, recipientId: 1 }, { unique: true });

const pathHistorySchema = new mongoose.Schema({
  trackId:     { type: String, required: true, index: true },
  points:      [{ lat: Number, lng: Number, timestamp: Date }],
  lastUpdated: { type: Date, default: Date.now, index: true },
}, { collection: 'path_history' });

pathHistorySchema.pre('save', function (next) {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  this.points = this.points.filter(p => p.timestamp > cutoff);
  next();
});

const messageSchema = new mongoose.Schema({
  conversationId: { type: String, index: true },
  senderId:       String,
  senderName:     String,
  text:           String,
  timestamp:      { type: Number, default: () => Date.now() },
}, { collection: 'messages' });

const conversationSchema = new mongoose.Schema({
  conversationId: { type: String, unique: true },
  participants:   [String],
  names:          { type: Map, of: String },
  lastMessage:    String,
  lastTimestamp:  Number,
  unread:         { type: Map, of: Number, default: {} },
}, { collection: 'conversations' });

// ─── Models ───────────────────────────────────────────────────────────────────
const UserRegistry = mongoose.model('UserRegistry', userRegistrySchema);
const Location     = mongoose.model('Location',     locationSchema);
const PathHistory  = mongoose.model('PathHistory',  pathHistorySchema);
const Message      = mongoose.model('Message',      messageSchema);
const Conversation = mongoose.model('Conversation', conversationSchema);

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function generateUniqueTrackId() {
  let trackId;
  let collision = true;
  while (collision) {
    trackId   = 'TRK-' + Math.random().toString(36).substr(2, 9).toUpperCase();
    collision = !!(await UserRegistry.findOne({ trackId }));
  }
  return trackId;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    message:   '✅ LiveLoc Backend v2 — Persistent Track IDs + Redis Cache',
    status:    'online',
    timestamp: new Date().toISOString(),
    endpoints: {
      health:               'GET  /api/health',
      ensureTrackId:        'POST /api/track/ensure',
      updateLocation:       'POST /api/location/update',
      updateLocationTarget: 'POST /api/location/update-targeted',
      getLocation:          'GET  /api/location/:trackId?viewer=<trackId>',
      getPath:              'GET  /api/path/:trackId',
      deactivate:           'POST /api/location/deactivate/:trackId',
      sendMessage:          'POST /api/chat/send',
      getConversations:     'GET  /api/chat/conversations/:trackId',
      getMessages:          'GET  /api/chat/messages/:conversationId',
      markRead:             'POST /api/chat/read',
      stats:                'GET  /api/stats',
    },
  });
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status:   'OK',
    timestamp: new Date(),
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    uptime:   process.uptime(),
  });
});

// ── /api/track/ensure ─────────────────────────────────────────────────────────
app.post('/api/track/ensure', async (req, res) => {
  try {
    const { uid, displayName = '', email = '' } = req.body;

    if (!uid) {
      return res.status(400).json({ error: 'Missing required field: uid' });
    }

    const existing = await UserRegistry.findOne({ uid });
    if (existing) {
      if (displayName || email) {
        await UserRegistry.updateOne(
          { uid },
          { $set: { displayName, email, updatedAt: new Date() } }
        );
      }
      console.log(`📍 [ensure] Reusing trackId for uid=${uid}: ${existing.trackId}`);
      return res.json({ trackId: existing.trackId, reused: true });
    }

    const trackId = await generateUniqueTrackId();

    try {
      await UserRegistry.create({ uid, trackId, displayName, email });
      console.log(`📍 [ensure] Created new trackId for uid=${uid}: ${trackId}`);
      return res.json({ trackId, reused: false });
    } catch (dupErr) {
      if (dupErr.code === 11000) {
        const winner = await UserRegistry.findOne({ uid });
        if (winner) {
          console.log(`📍 [ensure] Race resolved, returning trackId for uid=${uid}: ${winner.trackId}`);
          return res.json({ trackId: winner.trackId, reused: true });
        }
      }
      throw dupErr;
    }
  } catch (error) {
    console.error('Error in /api/track/ensure:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── /api/track/generate  (legacy) ────────────────────────────────────────────
app.post('/api/track/generate', async (req, res) => {
  try {
    const trackId = await generateUniqueTrackId();
    console.log('📍 [generate] Generated Track ID:', trackId);
    res.json({ trackId });
  } catch (error) {
    console.error('Error generating track ID:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── /api/location/update  (broadcast) ────────────────────────────────────────
app.post('/api/location/update', async (req, res) => {
  try {
    const { trackId, uid, lat, lng, speed = 0, accuracy = 0 } = req.body;

    if (!trackId || lat === undefined || lng === undefined) {
      return res.status(400).json({ error: 'Missing required fields: trackId, lat, lng' });
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'Invalid coordinates' });
    }

    const data = { trackId, uid, lat, lng, accuracy, speed };

    await cacheLocation(trackId, data);

    const updateFields = {
      lat, lng, speed, accuracy,
      timestamp: new Date(),
      isActive:  true,
      recipientId: null, // broadcast — no specific recipient
      ...(uid ? { uid } : {}),
    };

    Location.findOneAndUpdate(
      { trackId, recipientId: null },
      updateFields,
      { upsert: true, new: true }
    ).catch(e => console.error('DB write error:', e.message));

    PathHistory.findOneAndUpdate(
      { trackId },
      {
        $push: {
          points: {
            $each:  [{ lat, lng, timestamp: new Date() }],
            $slice: -1000,
          },
        },
        lastUpdated: new Date(),
      },
      { upsert: true }
    ).catch(e => console.error('PathHistory write error:', e.message));

    const payload = { trackId, lat, lng, speed, accuracy, timestamp: new Date() };
    io.emit('location:updated', payload);
    io.to(`track:${trackId}`).emit('location:updated', payload);
    io.emit(`location:${trackId}`, payload);

    res.json({ ok: true });
  } catch (error) {
    console.error('Error updating location:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── /api/location/update-targeted ────────────────────────────────────────────
// FIX BUG 1: was `router.post(...)` which is undefined — changed to `app.post`
// FIX BUG 2: now also persists to MongoDB with recipientId so DB fallback works
app.post('/api/location/update-targeted', async (req, res) => {
  try {
    const { trackId, uid, lat, lng, accuracy = 0, speed = 0, recipientId } = req.body;

    if (!trackId || !recipientId || lat == null || lng == null) {
      return res.status(400).json({ error: 'Missing fields: trackId, recipientId, lat, lng' });
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'Invalid coordinates' });
    }

    const data = { trackId, uid, lat, lng, accuracy, speed };

    // 1. Write to Redis under targeted key
    await cacheLocationTargeted(trackId, recipientId, data);

    // 2. Also persist to MongoDB with recipientId so it survives the 30s TTL
    const updateFields = {
      lat, lng, speed, accuracy,
      timestamp: new Date(),
      isActive:  true,
      recipientId,
      ...(uid ? { uid } : {}),
    };

    Location.findOneAndUpdate(
      { trackId, recipientId },
      updateFields,
      { upsert: true, new: true }
    ).catch(e => console.error('DB targeted write error:', e.message));

    res.json({ ok: true });
  } catch (e) {
    console.error('update-targeted error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── /api/location/:trackId ────────────────────────────────────────────────────
// FIX BUG 2 (part 3): MongoDB fallback now also checks the targeted key when
// a viewer param is present, so targeted locations survive after Redis TTL.
//
// Priority:
//   1. Redis targeted key  loc:<trackId>:for:<viewerId>   (if viewer provided)
//   2. Redis broadcast key loc:<trackId>
//   3. MongoDB targeted    (trackId + recipientId=viewerId)
//   4. MongoDB broadcast   (trackId + recipientId=null)
app.get('/api/location/:trackId', async (req, res) => {
  try {
    const { trackId } = req.params;
    const viewerId    = req.query.viewer;

    if (!trackId) return res.status(400).json({ error: 'Track ID is required' });

    // ── 1 & 2: Redis ──────────────────────────────────────────────────────────
    let raw = null;

    if (viewerId) {
      raw = await redis.get(`loc:${trackId}:for:${viewerId}`);
    }
    if (!raw) {
      raw = await redis.get(`loc:${trackId}`);
    }

    if (raw) {
      const data  = JSON.parse(raw);
      const ageMs = Date.now() - (data.ts ?? 0);
      return res.json({
        ...data,
        isRecent:    ageMs < REDIS_TTL * 1000,
        hasLocation: true,
      });
    }

    // ── Verify track ID exists ─────────────────────────────────────────────────
    const registered = await UserRegistry.findOne({ trackId });
    if (!registered) {
      return res.status(404).json({ error: 'Track ID not found' });
    }

    // ── 3: MongoDB targeted fallback ──────────────────────────────────────────
    if (viewerId) {
      const targeted = await Location.findOne({ trackId, recipientId: viewerId });
      if (targeted) {
        const isRecent = targeted.timestamp > new Date(Date.now() - 30_000);
        return res.json({ ...targeted.toObject(), isRecent, hasLocation: true });
      }
    }

    // ── 4: MongoDB broadcast fallback ─────────────────────────────────────────
    const location = await Location.findOne({ trackId, recipientId: null });
    if (!location) {
      return res.json({
        trackId,
        lat:         null,
        lng:         null,
        speed:       0,
        accuracy:    0,
        isRecent:    false,
        hasLocation: false,
      });
    }

    const isRecent = location.timestamp > new Date(Date.now() - 30_000);
    res.json({ ...location.toObject(), isRecent, hasLocation: true });
  } catch (error) {
    console.error('Error fetching location:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── /api/path/:trackId ────────────────────────────────────────────────────────
app.get('/api/path/:trackId', async (req, res) => {
  try {
    const { trackId }   = req.params;
    const { hours = 2 } = req.query;
    if (!trackId) return res.status(400).json({ error: 'Track ID is required' });

    const pathHistory = await PathHistory.findOne({ trackId });
    if (!pathHistory) return res.json({ points: [] });

    const cutoff = new Date(Date.now() - parseInt(hours) * 60 * 60 * 1000);
    res.json({ points: pathHistory.points.filter(p => p.timestamp > cutoff) });
  } catch (error) {
    console.error('Error fetching path history:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── /api/location/deactivate/:trackId ────────────────────────────────────────
app.post('/api/location/deactivate/:trackId', async (req, res) => {
  try {
    const { trackId } = req.params;
    if (!trackId) return res.status(400).json({ error: 'Track ID is required' });

    await redis.del(`loc:${trackId}`);
    await Location.updateMany({ trackId }, { isActive: false });
    console.log(`📍 Location deactivated for ${trackId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deactivating location:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── /api/stats ────────────────────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  try {
    const [registeredUsers, totalLocations, activeLocations, totalPaths, totalMessages] =
      await Promise.all([
        UserRegistry.countDocuments(),
        Location.countDocuments(),
        Location.countDocuments({ isActive: true }),
        PathHistory.countDocuments(),
        Message.countDocuments(),
      ]);

    res.json({
      registeredUsers,
      totalLocations,
      activeLocations,
      inactiveLocations: totalLocations - activeLocations,
      totalPaths,
      totalMessages,
      timestamp: new Date(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Manual cleanup ────────────────────────────────────────────────────────────
app.post('/api/cleanup', async (req, res) => {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [dl, dp] = await Promise.all([
      Location.deleteMany({ timestamp: { $lt: cutoff } }),
      PathHistory.deleteMany({ lastUpdated: { $lt: cutoff } }),
    ]);
    console.log(`🧹 Manual cleanup: ${dl.deletedCount} locations, ${dp.deletedCount} paths`);
    res.json({
      success: true,
      deletedLocations: dl.deletedCount,
      deletedPaths:     dp.deletedCount,
      note: 'UserRegistry (track IDs) was NOT touched.',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Chat Routes ──────────────────────────────────────────────────────────────

app.post('/api/chat/send', async (req, res) => {
  try {
    const { conversationId, senderId, senderName, receiverId, receiverName, text } = req.body;
    if (!conversationId || !senderId || !receiverId || !text) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const ts = Date.now();
    await Message.create({ conversationId, senderId, senderName, text, timestamp: ts });

    await Conversation.findOneAndUpdate(
      { conversationId },
      {
        $set: {
          conversationId,
          lastMessage: text,
          lastTimestamp: ts,
          [`names.${senderId}`]: senderName,
          [`names.${receiverId}`]: receiverName,
        },
        $addToSet: { participants: { $each: [senderId, receiverId] } },
        $inc: { [`unread.${receiverId}`]: 1 },
      },
      { upsert: true, new: true }
    );

    io.to(`conversation:${conversationId}`).emit('chat:message', {
      conversationId, senderId, senderName, text, timestamp: ts,
    });
    io.to(`user:${receiverId}`).emit('chat:newMessage', {
      conversationId, senderId, senderName, text, timestamp: ts,
    });

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/chat/conversations/:trackId', async (req, res) => {
  try {
    const { trackId } = req.params;
    if (!trackId) return res.status(400).json({ error: 'Track ID is required' });

    const convos = await Conversation.find({ participants: trackId }).sort({ lastTimestamp: -1 });
    res.json(convos.map(c => ({
      conversationId: c.conversationId,
      participants:   c.participants,
      names:          Object.fromEntries(c.names || []),
      lastMessage:    c.lastMessage,
      lastTimestamp:  c.lastTimestamp,
      unread:         Object.fromEntries(c.unread || []),
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/chat/messages/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params;
    if (!conversationId) return res.status(400).json({ error: 'Conversation ID is required' });

    const msgs = await Message.find({ conversationId }).sort({ timestamp: 1 }).limit(200);
    res.json(msgs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/chat/read', async (req, res) => {
  try {
    const { conversationId, trackId } = req.body;
    if (!conversationId || !trackId) return res.status(400).json({ error: 'Missing required fields' });

    await Conversation.findOneAndUpdate(
      { conversationId },
      { $set: { [`unread.${trackId}`]: 0 } }
    );
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('👤 Connected:', socket.id);

  socket.on('track:subscribe',   (id) => { socket.join(`track:${id}`);        socket.emit('track:subscribed',    { trackId: id,        success: true }); });
  socket.on('track:unsubscribe', (id) => { socket.leave(`track:${id}`);       socket.emit('track:unsubscribed',  { trackId: id,        success: true }); });
  socket.on('user:join',         (id) => { socket.join(`user:${id}`);         socket.emit('user:joined',         { trackId: id,        success: true }); });
  socket.on('conversation:join', (id) => { socket.join(`conversation:${id}`); socket.emit('conversation:joined', { conversationId: id, success: true }); });
  socket.on('conversation:leave',(id) => { socket.leave(`conversation:${id}`); });

  socket.on('location:update', async (data) => {
    try {
      const { trackId, uid, lat, lng, speed = 0, accuracy = 0 } = data;
      if (!trackId || lat === undefined || lng === undefined) {
        socket.emit('error', { message: 'Missing required fields' }); return;
      }
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        socket.emit('error', { message: 'Invalid coordinates' }); return;
      }

      await cacheLocation(trackId, { trackId, uid, lat, lng, speed, accuracy });

      const fields = { lat, lng, speed, accuracy, timestamp: new Date(), isActive: true, recipientId: null, ...(uid ? { uid } : {}) };
      Location.findOneAndUpdate({ trackId, recipientId: null }, fields, { upsert: true })
        .catch(e => console.error('Socket DB write error:', e.message));

      PathHistory.findOneAndUpdate(
        { trackId },
        { $push: { points: { $each: [{ lat, lng, timestamp: new Date() }], $slice: -1000 } }, lastUpdated: new Date() },
        { upsert: true }
      ).catch(e => console.error('Socket PathHistory write error:', e.message));

      const payload = { trackId, lat, lng, speed, accuracy, timestamp: new Date() };
      io.emit('location:updated', payload);
      io.to(`track:${trackId}`).emit('location:updated', payload);
    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('ping', () => socket.emit('pong', { timestamp: new Date() }));
  socket.on('disconnect', (reason) => console.log('👤 Disconnected:', socket.id, reason));
  socket.on('error', (err) => console.error('Socket error:', err));
});

// ─── Auto-Cleanup (48 h — only Location + PathHistory, NEVER UserRegistry) ────
setInterval(async () => {
  try {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const [dl, dp] = await Promise.all([
      Location.deleteMany({ timestamp: { $lt: cutoff } }),
      PathHistory.deleteMany({ lastUpdated: { $lt: cutoff } }),
    ]);
    if (dl.deletedCount > 0 || dp.deletedCount > 0) {
      console.log(`🧹 Auto-cleanup: ${dl.deletedCount} stale locations, ${dp.deletedCount} stale paths`);
    }
  } catch (err) {
    console.error('Auto-cleanup error:', err);
  }
}, 60 * 60 * 1000);

// ─── Error handlers ───────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found', path: req.path, method: req.method });
});
app.use((err, req, res, _next) => {
  console.error('Global error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Socket.IO ready`);
  console.log(`⚡ Redis cache active (${REDIS_TTL}s TTL)`);
  console.log(`🔒 UserRegistry is permanent — track IDs never deleted`);
  console.log(`🧹 Auto-cleanup targets only Location + PathHistory (48 h cutoff)`);
});
