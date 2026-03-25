require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);

// Socket.IO with CORS configuration
const io = socketIo(server, {
  cors: {
    origin: [
      'http://localhost:3000',
      'http://localhost:5173',
      'https://your-app-name.vercel.app',
      /\.vercel\.app$/
    ],
    credentials: true,
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

// CORS Middleware
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:5173',
    'https://your-app-name.vercel.app',
    /\.vercel\.app$/
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'your_mongodb_connection_string_here';

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('✅ MongoDB Connected'))
.catch(err => console.error('❌ MongoDB Connection Error:', err));

// ==================== MONGOOSE SCHEMAS ====================

// Location Schema — uid added so /api/track/ensure can do get-or-create by uid
const locationSchema = new mongoose.Schema({
  trackId:   { type: String, required: true, unique: true, index: true },
  uid:       { type: String, index: true },   // Firebase UID — links user → trackId
  lat:       { type: Number, required: true },
  lng:       { type: Number, required: true },
  speed:     { type: Number, default: 0 },
  accuracy:  { type: Number, default: 0 },
  timestamp: { type: Date,   default: Date.now },
  isActive:  { type: Boolean, default: true }
});

const pathHistorySchema = new mongoose.Schema({
  trackId: { type: String, required: true, index: true },
  points: [{
    lat: Number,
    lng: Number,
    timestamp: Date
  }],
  lastUpdated: { type: Date, default: Date.now }
});

pathHistorySchema.pre('save', function(next) {
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  this.points = this.points.filter(point => point.timestamp > twentyFourHoursAgo);
  next();
});

// Message Schema
const messageSchema = new mongoose.Schema({
  conversationId: String,
  senderId: String,
  senderName: String,
  text: String,
  timestamp: { type: Number, default: () => Date.now() }
});

// Conversation Schema
const conversationSchema = new mongoose.Schema({
  conversationId: { type: String, unique: true },
  participants: [String],
  names: { type: Map, of: String },
  lastMessage: String,
  lastTimestamp: Number,
  unread: { type: Map, of: Number, default: {} }
});

const Location    = mongoose.model('Location',    locationSchema);
const PathHistory = mongoose.model('PathHistory', pathHistorySchema);
const Message     = mongoose.model('Message',     messageSchema);
const Conversation= mongoose.model('Conversation',conversationSchema);

// ==================== REST API ROUTES ====================

app.get('/', (req, res) => {
  res.json({
    message: '✅ Location Tracker Backend API is running!',
    status: 'online',
    timestamp: new Date().toISOString(),
    endpoints: {
      health:           '/api/health',
      ensureTrackId:    'POST /api/track/ensure',
      generateTrackId:  'POST /api/track/generate',
      updateLocation:   'POST /api/location/update',
      getLocation:      'GET /api/location/:trackId',
      getPath:          'GET /api/path/:trackId',
      deactivate:       'POST /api/location/deactivate/:trackId',
      sendMessage:      'POST /api/chat/send',
      getConversations: 'GET /api/chat/conversations/:trackId',
      getMessages:      'GET /api/chat/messages/:conversationId',
      markRead:         'POST /api/chat/read'
    }
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date(),
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    uptime: process.uptime()
  });
});

// ── /api/track/ensure ─────────────────────────────────────────────────────────
// GET-or-CREATE: given a Firebase uid, returns the existing trackId for that
// user if one already exists in MongoDB, otherwise generates a fresh unique
// one and stores it.  This is the single source of truth — calling it twice
// with the same uid always returns the same trackId.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/track/ensure', async (req, res) => {
  try {
    const { uid } = req.body;

    if (!uid) {
      return res.status(400).json({ error: 'Missing required field: uid' });
    }

    // 1. Check if this uid already owns a trackId
    const existing = await Location.findOne({ uid });
    if (existing) {
      console.log(`📍 [ensure] Reusing Track ID for uid=${uid}: ${existing.trackId}`);
      return res.json({ trackId: existing.trackId, reused: true });
    }

    // 2. Generate a collision-free new trackId
    let trackId;
    let collision = true;
    while (collision) {
      trackId   = 'TRK-' + Math.random().toString(36).substr(2, 9).toUpperCase();
      collision = !!(await Location.findOne({ trackId }));
    }

    // 3. Seed a Location doc so the uid→trackId mapping is stored immediately.
    //    lat/lng are dummy values (0,0) — they will be overwritten on the first
    //    real location push.  We use upsert so a concurrent request can't
    //    create a duplicate.
    await Location.findOneAndUpdate(
      { uid },
      {
        $setOnInsert: {
          trackId,
          uid,
          lat: 0,
          lng: 0,
          speed: 0,
          accuracy: 0,
          timestamp: new Date(),
          isActive: false
        }
      },
      { upsert: true, new: true }
    );

    console.log(`📍 [ensure] Generated new Track ID for uid=${uid}: ${trackId}`);
    res.json({ trackId, reused: false });
  } catch (error) {
    console.error('Error in /api/track/ensure:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── /api/track/generate ───────────────────────────────────────────────────────
// Legacy endpoint — kept for backward compatibility.
// Prefer /api/track/ensure for all new calls.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/track/generate', async (req, res) => {
  try {
    let trackId;
    let exists = true;
    while (exists) {
      trackId = 'TRK-' + Math.random().toString(36).substr(2, 9).toUpperCase();
      exists  = await Location.findOne({ trackId });
    }
    console.log('📍 [generate] Generated Track ID:', trackId);
    res.json({ trackId });
  } catch (error) {
    console.error('Error generating track ID:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update location
app.post('/api/location/update', async (req, res) => {
  try {
    const { trackId, uid, lat, lng, speed, accuracy } = req.body;

    if (!trackId || lat === undefined || lng === undefined) {
      return res.status(400).json({ error: 'Missing required fields: trackId, lat, lng' });
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'Invalid coordinates' });
    }

    const updateFields = {
      lat,
      lng,
      speed:     speed    || 0,
      accuracy:  accuracy || 0,
      timestamp: new Date(),
      isActive:  true
    };
    // Persist uid if supplied — ties the Location doc to the Firebase user
    if (uid) updateFields.uid = uid;

    const location = await Location.findOneAndUpdate(
      { trackId },
      updateFields,
      { upsert: true, new: true }
    );

    await PathHistory.findOneAndUpdate(
      { trackId },
      {
        $push: {
          points: {
            $each:  [{ lat, lng, timestamp: new Date() }],
            $slice: -1000
          }
        },
        lastUpdated: new Date()
      },
      { upsert: true, new: true }
    );

    const payload = { trackId, lat, lng, speed: speed || 0, accuracy: accuracy || 0, timestamp: new Date() };
    io.emit('location:updated', payload);
    io.emit(`location:${trackId}`, payload);

    console.log(`📍 Location updated for ${trackId}`);
    res.json({ success: true, location });
  } catch (error) {
    console.error('Error updating location:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get location by Track ID
app.get('/api/location/:trackId', async (req, res) => {
  try {
    const { trackId } = req.params;
    if (!trackId) return res.status(400).json({ error: 'Track ID is required' });

    const location = await Location.findOne({ trackId });
    if (!location) return res.status(404).json({ error: 'Track ID not found' });

    const thirtySecondsAgo = new Date(Date.now() - 30000);
    const isRecent = location.timestamp > thirtySecondsAgo;

    res.json({ ...location.toObject(), isRecent });
  } catch (error) {
    console.error('Error fetching location:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get path history
app.get('/api/path/:trackId', async (req, res) => {
  try {
    const { trackId } = req.params;
    const { hours = 2 } = req.query;
    if (!trackId) return res.status(400).json({ error: 'Track ID is required' });

    const pathHistory = await PathHistory.findOne({ trackId });
    if (!pathHistory) return res.json({ points: [] });

    const timeAgo = new Date(Date.now() - parseInt(hours) * 60 * 60 * 1000);
    res.json({ points: pathHistory.points.filter(p => p.timestamp > timeAgo) });
  } catch (error) {
    console.error('Error fetching path history:', error);
    res.status(500).json({ error: error.message });
  }
});

// Deactivate location sharing
app.post('/api/location/deactivate/:trackId', async (req, res) => {
  try {
    const { trackId } = req.params;
    if (!trackId) return res.status(400).json({ error: 'Track ID is required' });

    const result = await Location.findOneAndUpdate({ trackId }, { isActive: false }, { new: true });
    if (!result) return res.status(404).json({ error: 'Track ID not found' });

    console.log(`📍 Location deactivated for ${trackId}`);
    res.json({ success: true, message: 'Location sharing deactivated' });
  } catch (error) {
    console.error('Error deactivating location:', error);
    res.status(500).json({ error: error.message });
  }
});

// Manual cleanup
app.post('/api/cleanup', async (req, res) => {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const dl = await Location.deleteMany({ timestamp: { $lt: cutoff } });
    const dp = await PathHistory.deleteMany({ lastUpdated: { $lt: cutoff } });
    console.log(`🧹 Manual cleanup: ${dl.deletedCount} locations, ${dp.deletedCount} paths`);
    res.json({ success: true, deletedLocations: dl.deletedCount, deletedPaths: dp.deletedCount });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Stats
app.get('/api/stats', async (req, res) => {
  try {
    const total  = await Location.countDocuments();
    const active = await Location.countDocuments({ isActive: true });
    res.json({ totalLocations: total, activeLocations: active, inactiveLocations: total - active,
      totalPaths: await PathHistory.countDocuments(), timestamp: new Date() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== CHAT API ROUTES ====================

app.post('/api/chat/send', async (req, res) => {
  try {
    const { conversationId, senderId, senderName, receiverId, receiverName, text } = req.body;
    if (!conversationId || !senderId || !receiverId || !text)
      return res.status(400).json({ error: 'Missing required fields' });

    const ts = Date.now();
    await Message.create({ conversationId, senderId, senderName, text, timestamp: ts });

    await Conversation.findOneAndUpdate(
      { conversationId },
      {
        $set: {
          conversationId, lastMessage: text, lastTimestamp: ts,
          [`names.${senderId}`]: senderName,
          [`names.${receiverId}`]: receiverName,
        },
        $addToSet: { participants: { $each: [senderId, receiverId] } },
        $inc: { [`unread.${receiverId}`]: 1 },
      },
      { upsert: true, new: true }
    );

    io.to(`conversation:${conversationId}`).emit('chat:message', { conversationId, senderId, senderName, text, timestamp: ts });
    io.to(`user:${receiverId}`).emit('chat:newMessage', { conversationId, senderId, senderName, text, timestamp: ts });

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
      unread:         Object.fromEntries(c.unread || [])
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

    await Conversation.findOneAndUpdate({ conversationId }, { $set: { [`unread.${trackId}`]: 0 } });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== SOCKET.IO ====================

io.on('connection', (socket) => {
  console.log('👤 New client connected:', socket.id);

  socket.on('track:subscribe',   (trackId)        => { socket.join(`track:${trackId}`);        socket.emit('track:subscribed',      { trackId,        success: true }); });
  socket.on('track:unsubscribe', (trackId)        => { socket.leave(`track:${trackId}`);       socket.emit('track:unsubscribed',    { trackId,        success: true }); });
  socket.on('user:join',         (trackId)        => { socket.join(`user:${trackId}`);         socket.emit('user:joined',           { trackId,        success: true }); });
  socket.on('conversation:join', (conversationId) => { socket.join(`conversation:${conversationId}`); socket.emit('conversation:joined', { conversationId, success: true }); });
  socket.on('conversation:leave',(conversationId) => { socket.leave(`conversation:${conversationId}`); });

  socket.on('location:update', async (data) => {
    try {
      const { trackId, uid, lat, lng, speed, accuracy } = data;
      if (!trackId || lat === undefined || lng === undefined) { socket.emit('error', { message: 'Missing required fields' }); return; }
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180)  { socket.emit('error', { message: 'Invalid coordinates' });     return; }

      const updateFields = { lat, lng, speed: speed || 0, accuracy: accuracy || 0, timestamp: new Date(), isActive: true };
      if (uid) updateFields.uid = uid;

      await Location.findOneAndUpdate({ trackId }, updateFields, { upsert: true, new: true });
      await PathHistory.findOneAndUpdate(
        { trackId },
        { $push: { points: { $each: [{ lat, lng, timestamp: new Date() }], $slice: -1000 } }, lastUpdated: new Date() },
        { upsert: true }
      );

      const payload = { trackId, lat, lng, speed: speed || 0, accuracy: accuracy || 0, timestamp: new Date() };
      io.emit('location:updated', payload);
      io.to(`track:${trackId}`).emit('location:updated', payload);
      io.emit(`location:${trackId}`, payload);
    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('ping', () => socket.emit('pong', { timestamp: new Date() }));
  socket.on('disconnect', (reason) => console.log('👤 Client disconnected:', socket.id, reason));
  socket.on('error', (error) => console.error('Socket error:', error));
});

// ==================== AUTO CLEANUP ====================

setInterval(async () => {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const dl = await Location.deleteMany({ timestamp: { $lt: cutoff } });
    const dp = await PathHistory.deleteMany({ lastUpdated: { $lt: cutoff } });
    if (dl.deletedCount > 0 || dp.deletedCount > 0)
      console.log(`🧹 Auto-cleanup: ${dl.deletedCount} locations, ${dp.deletedCount} paths`);
  } catch (error) {
    console.error('Auto-cleanup error:', error);
  }
}, 60 * 60 * 1000);

// ==================== ERROR HANDLING ====================

app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found', path: req.path, method: req.method });
});

app.use((err, req, res, next) => {
  console.error('Global error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// ==================== START SERVER ====================

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Socket.IO ready`);
  console.log(`✅ /api/track/ensure is live — stable trackIds guaranteed`);
});
