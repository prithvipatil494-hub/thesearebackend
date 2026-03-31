require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = socketIo(server, {
  cors: {
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE']
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Raise body size limit to 50 MB to accommodate base64 video payloads
app.use(express.json({ limit: '50mb' }));

const MONGODB_URI = process.env.MONGODB_URI || 'your_mongodb_connection_string_here';

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('✅ MongoDB Connected'))
.catch(err => console.error('❌ MongoDB Connection Error:', err));

// ==================== MONGOOSE SCHEMAS ====================

const locationSchema = new mongoose.Schema({
  trackId:   { type: String, required: true, unique: true, index: true },
  lat:       { type: Number, required: true },
  lng:       { type: Number, required: true },
  speed:     { type: Number, default: 0 },
  accuracy:  { type: Number, default: 0 },
  timestamp: { type: Date, default: Date.now },
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
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  this.points = this.points.filter(p => p.timestamp > cutoff);
  next();
});

// ─── Message schema — now includes type + imageBase64 ─────────────────────────
const messageSchema = new mongoose.Schema({
  conversationId: { type: String, index: true },
  senderId:       String,
  senderName:     String,
  text:           String,
  timestamp:      { type: Number, default: () => Date.now() },
  readBy:         { type: [String], default: [] },
  // Photo / video sharing fields
  type:           { type: String, default: 'text', enum: ['text', 'image', 'video'] },
  imageBase64:    { type: String, default: '' },  // base64 JPEG (image) or MP4 (video)
  videoDelivered: { type: Boolean, default: false }  // set true once video fetched by receiver
});
messageSchema.index({ conversationId: 1, timestamp: 1 });
messageSchema.index({ conversationId: 1, readBy: 1 });

const conversationSchema = new mongoose.Schema({
  conversationId: { type: String, unique: true },
  participants:   [String],
  names:          { type: Map, of: String },
  lastMessage:    String,
  lastTimestamp:  Number,
  unread:         { type: Map, of: Number, default: {} }
});

const userSchema = new mongoose.Schema({
  uid:          { type: String, required: true, unique: true, index: true },
  trackId:      { type: String, required: true, index: true },
  displayName:  { type: String, default: '' },
  email:        { type: String, default: '' },
  avatarBase64: { type: String, default: '' },
  friends:      { type: [String], default: [] },
  savedFriends: {
    type: [{
      trackId:      String,
      displayName:  String,
      email:        String,
      avatarBase64: String
    }],
    default: []
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const sessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true, index: true },
  uid:       { type: String, required: true, index: true },
  trackId:   { type: String, required: true },
  startTime: { type: String },
  endTime:   { type: String, default: null },
  points:    [{
    lat:       Number,
    lng:       Number,
    timestamp: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now }
});

const sosAlertSchema = new mongoose.Schema({
  senderTrackId: { type: String, required: true, index: true },
  displayName:   { type: String, default: '' },
  lat:           { type: Number, default: 0 },
  lng:           { type: Number, default: 0 },
  videoBase64:   { type: String, default: '' },
  timestamp:     { type: Date, default: Date.now },
  expiresAt:     { type: Date, default: () => new Date(Date.now() + 4 * 60 * 60 * 1000) }
});

const Location     = mongoose.model('Location',     locationSchema);
const PathHistory  = mongoose.model('PathHistory',  pathHistorySchema);
const Message      = mongoose.model('Message',      messageSchema);
const Conversation = mongoose.model('Conversation', conversationSchema);
const User         = mongoose.model('User',         userSchema);
const Session      = mongoose.model('Session',      sessionSchema);
const SosAlert     = mongoose.model('SosAlert',     sosAlertSchema);

// ==================== REST API ROUTES ====================

app.get('/', (req, res) => {
  res.json({ message: '✅ Location Tracker Backend API is running!', status: 'online', timestamp: new Date().toISOString() });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date(), database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected', uptime: process.uptime() });
});

// ==================== USER ROUTES ====================

app.get('/api/user/by-trackid/:trackId', async (req, res) => {
  try {
    const { trackId } = req.params;
    const user = await User.findOne({ trackId: trackId.trim().toUpperCase() }) || await User.findOne({ trackId });
    if (!user) return res.status(404).json({ error: 'No user found for this Track ID' });
    res.json({ uid: user.uid, trackId: user.trackId, displayName: user.displayName, email: user.email, avatarBase64: user.avatarBase64 || '' });
  } catch (error) {
    console.error('Error fetching user by trackId:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/user/:uid', async (req, res) => {
  try {
    const { uid } = req.params;
    const user = await User.findOne({ uid });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ uid: user.uid, trackId: user.trackId, displayName: user.displayName, email: user.email, avatarBase64: user.avatarBase64 || '', friends: user.friends, savedFriends: user.savedFriends || [] });
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/user/upsert', async (req, res) => {
  try {
    const { uid, trackId, displayName, email } = req.body;
    if (!uid || !trackId) return res.status(400).json({ error: 'uid and trackId are required' });
    const user = await User.findOneAndUpdate({ uid }, { uid, trackId, displayName: displayName || '', email: email || '', updatedAt: new Date() }, { upsert: true, new: true });
    await Location.findOneAndUpdate({ trackId }, { $setOnInsert: { trackId, lat: 0, lng: 0, isActive: false } }, { upsert: true });
    console.log(`👤 User upserted: ${uid} → ${trackId}`);
    res.json({ success: true, user });
  } catch (error) {
    console.error('Error upserting user:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/user/:uid/avatar', async (req, res) => {
  try {
    const { uid }          = req.params;
    const { avatarBase64 } = req.body;
    if (!avatarBase64) return res.status(400).json({ error: 'avatarBase64 required' });
    const user = await User.findOneAndUpdate({ uid }, { avatarBase64, updatedAt: new Date() }, { new: true });
    if (!user) return res.status(404).json({ error: 'User not found' });
    console.log(`🖼 Avatar updated for ${uid}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving avatar:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/user/:uid/friends', async (req, res) => {
  try {
    const { uid } = req.params;
    const { friends } = req.body;
    if (!Array.isArray(friends)) return res.status(400).json({ error: 'friends must be an array' });
    const user = await User.findOneAndUpdate({ uid }, { friends, updatedAt: new Date() }, { new: true });
    if (!user) return res.status(404).json({ error: 'User not found' });
    console.log(`👥 Friends updated for ${uid}: [${friends.join(', ')}]`);
    res.json({ success: true, friends: user.friends });
  } catch (error) {
    console.error('Error updating friends:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/user/:uid/saved-friends', async (req, res) => {
  try {
    const { uid } = req.params;
    const { savedFriends } = req.body;
    if (!Array.isArray(savedFriends)) return res.status(400).json({ error: 'savedFriends must be an array' });
    const user = await User.findOneAndUpdate({ uid }, { savedFriends, updatedAt: new Date() }, { new: true });
    if (!user) return res.status(404).json({ error: 'User not found' });
    console.log(`💾 SavedFriends updated for ${uid}: ${savedFriends.length} entries`);
    res.json({ success: true, savedFriends: user.savedFriends });
  } catch (error) {
    console.error('Error updating saved friends:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== TRACK ID ROUTES ====================

app.post('/api/track/generate', async (req, res) => {
  try {
    let trackId, exists = true;
    while (exists) {
      trackId = 'TRK-' + Math.random().toString(36).substr(2, 9).toUpperCase();
      exists  = await Location.findOne({ trackId });
    }
    console.log('📍 Generated Track ID:', trackId);
    res.json({ trackId });
  } catch (error) {
    console.error('Error generating track ID:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== LOCATION ROUTES ====================

const IS_RECENT_MS = 8_000;

app.post('/api/location/update', async (req, res) => {
  try {
    const { trackId, lat, lng, speed, accuracy } = req.body;
    if (!trackId || lat === undefined || lng === undefined) return res.status(400).json({ error: 'Missing required fields: trackId, lat, lng' });
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return res.status(400).json({ error: 'Invalid coordinates' });

    const now = new Date();
    await Location.findOneAndUpdate({ trackId }, { lat, lng, speed: speed || 0, accuracy: accuracy || 0, timestamp: now, isActive: true }, { upsert: true, new: true });
    PathHistory.findOneAndUpdate({ trackId }, { $push: { points: { $each: [{ lat, lng, timestamp: now }], $slice: -1000 } }, lastUpdated: now }, { upsert: true }).catch(() => {});

    const updateData = { trackId, lat, lng, speed: speed || 0, accuracy: accuracy || 0, timestamp: now, isRecent: true };
    io.to(`track:${trackId}`).emit('location:updated', updateData);
    io.emit('location:updated', updateData);
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating location:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/location/:trackId', async (req, res) => {
  try {
    const { trackId } = req.params;
    if (!trackId) return res.status(400).json({ error: 'Track ID is required' });
    const location = await Location.findOne({ trackId });
    if (!location) return res.json({ trackId, isRecent: false, notFound: true });
    const isRecent = location.timestamp > new Date(Date.now() - IS_RECENT_MS);
    res.json({ trackId: location.trackId, lat: location.lat, lng: location.lng, speed: location.speed, accuracy: location.accuracy, timestamp: location.timestamp, isActive: location.isActive, isRecent });
  } catch (error) {
    console.error('Error fetching location:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/path/:trackId', async (req, res) => {
  try {
    const { trackId } = req.params;
    const { hours = 2 } = req.query;
    const pathHistory = await PathHistory.findOne({ trackId });
    if (!pathHistory) return res.json({ points: [] });
    const timeAgo      = new Date(Date.now() - parseInt(hours) * 60 * 60 * 1000);
    const recentPoints = pathHistory.points.filter(p => p.timestamp > timeAgo);
    res.json({ points: recentPoints });
  } catch (error) {
    console.error('Error fetching path history:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/location/deactivate/:trackId', async (req, res) => {
  try {
    const { trackId } = req.params;
    const result = await Location.findOneAndUpdate({ trackId }, { isActive: false }, { new: true });
    if (!result) return res.status(404).json({ error: 'Track ID not found' });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deactivating location:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== SESSION ROUTES ====================

app.post('/api/session/start', async (req, res) => {
  try {
    const { sessionId, uid, trackId, startTime } = req.body;
    if (!sessionId || !uid || !trackId) return res.status(400).json({ error: 'sessionId, uid, and trackId are required' });
    const session = await Session.create({ sessionId, uid, trackId, startTime: startTime || new Date().toISOString(), points: [] });
    console.log(`⏺ Session started: ${sessionId} for ${trackId}`);
    res.json({ success: true, sessionId: session.sessionId });
  } catch (error) {
    if (error.code === 11000) return res.json({ success: true, sessionId: req.body.sessionId });
    console.error('Error starting session:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/session/:sessionId/point', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { lat, lng }  = req.body;
    if (lat === undefined || lng === undefined) return res.status(400).json({ error: 'lat and lng are required' });
    await Session.findOneAndUpdate({ sessionId }, { $push: { points: { $each: [{ lat, lng, timestamp: new Date() }], $slice: -5000 } } });
    res.json({ success: true });
  } catch (error) {
    console.error('Error adding session point:', error);
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/session/:sessionId/end', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { endTime }   = req.body;
    await Session.findOneAndUpdate({ sessionId }, { endTime: endTime || new Date().toISOString() });
    console.log(`⏹ Session ended: ${sessionId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error ending session:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/session/:uid/list', async (req, res) => {
  try {
    const { uid } = req.params;
    const sessions = await Session.find({ uid }).sort({ createdAt: -1 }).limit(50);
    res.json(sessions);
  } catch (error) {
    console.error('Error listing sessions:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== STATS / CLEANUP ====================

app.get('/api/stats', async (req, res) => {
  try {
    const [totalLocations, activeLocations, totalUsers, totalSessions] = await Promise.all([Location.countDocuments(), Location.countDocuments({ isActive: true }), User.countDocuments(), Session.countDocuments()]);
    res.json({ totalLocations, activeLocations, totalUsers, totalSessions, timestamp: new Date() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/cleanup', async (req, res) => {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [dl, dp] = await Promise.all([Location.deleteMany({ timestamp: { $lt: cutoff } }), PathHistory.deleteMany({ lastUpdated: { $lt: cutoff } })]);
    res.json({ success: true, deletedLocations: dl.deletedCount, deletedPaths: dp.deletedCount });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== CHAT ROUTES ====================

// POST /api/chat/send
// Accepts both text messages and image messages.
// For images: { type: "image", text: "__image__", imageBase64: "<base64 string>" }
app.post('/api/chat/send', async (req, res) => {
  try {
    const { conversationId, senderId, senderName, receiverId, receiverName, text, type, imageBase64 } = req.body;

    if (!conversationId || !senderId || !receiverId) {
      return res.status(400).json({ error: 'Missing required fields: conversationId, senderId, receiverId' });
    }

    const msgType = (type === 'image') ? 'image' : 'text';

    // Validate image payload
    if (msgType === 'image' && (!imageBase64 || typeof imageBase64 !== 'string')) {
      return res.status(400).json({ error: 'imageBase64 is required for image messages' });
    }

    // Guard: refuse excessively large payloads (> 8 MB base64 ≈ ~6 MB image)
    if (msgType === 'image' && imageBase64.length > 8_000_000) {
      return res.status(413).json({ error: 'Image too large. Max ~6 MB.' });
    }

    const ts = Date.now();
    const displayText = msgType === 'image' ? '__image__' : (text || '');

    const savedMessage = await Message.create({
      conversationId,
      senderId,
      senderName,
      text:        displayText,
      timestamp:   ts,
      readBy:      [senderId],
      type:        msgType,
      imageBase64: msgType === 'image' ? imageBase64 : ''
    });

    await Conversation.findOneAndUpdate(
      { conversationId },
      {
        $set: {
          conversationId,
          lastMessage:             displayText,
          lastTimestamp:           ts,
          [`names.${senderId}`]:   senderName,
          [`names.${receiverId}`]: receiverName,
        },
        $addToSet: { participants: { $each: [senderId, receiverId] } },
        $inc:      { [`unread.${receiverId}`]: 1 },
      },
      { upsert: true, new: true }
    );

    const payload = {
      _id:            savedMessage._id.toString(),
      conversationId,
      senderId,
      senderName,
      text:           displayText,
      timestamp:      ts,
      readBy:         [senderId],
      type:           msgType,
      imageBase64:    msgType === 'image' ? imageBase64 : ''
    };

    io.to(`conversation:${conversationId}`).emit('chat:message', payload);
    io.to(`user:${receiverId}`).emit('chat:newMessage', payload);
    io.to(`user:${senderId}`).emit('chat:message', payload);

    console.log(`💬 [${msgType}] Message sent in ${conversationId} by ${senderId}`);
    res.json({ ok: true, messageId: savedMessage._id.toString() });

  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/chat/conversations/:trackId', async (req, res) => {
  try {
    const { trackId } = req.params;
    const convos = await Conversation.find({ participants: trackId }).sort({ lastTimestamp: -1 });
    res.json(convos.map(c => ({
      conversationId: c.conversationId,
      participants:   c.participants,
      names:          Object.fromEntries(c.names || []),
      lastMessage:    c.lastMessage  || '',
      lastTimestamp:  c.lastTimestamp || 0,
      unread:         Object.fromEntries(c.unread || [])
    })));
  } catch (error) {
    console.error('Error fetching conversations:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/chat/messages/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { since } = req.query;  // optional: only return messages newer than this timestamp
    const query = { conversationId };
    if (since) {
      const sinceTs = parseInt(since, 10);
      if (!isNaN(sinceTs)) query.timestamp = { $gt: sinceTs };
    }
    const msgs = await Message.find(query).sort({ timestamp: 1 }).limit(200);
    res.json(msgs.map(m => ({
      _id:            m._id.toString(),
      conversationId: m.conversationId,
      senderId:       m.senderId,
      senderName:     m.senderName,
      text:           m.text,
      timestamp:      m.timestamp,
      readBy:         m.readBy || [],
      type:           m.type || 'text',
      imageBase64:    m.imageBase64 || ''
    })));
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/chat/read', async (req, res) => {
  try {
    const { conversationId, trackId } = req.body;
    if (!conversationId || !trackId) return res.status(400).json({ error: 'conversationId and trackId required' });
    await Conversation.findOneAndUpdate({ conversationId }, { $set: { [`unread.${trackId}`]: 0 } });
    await Message.updateMany({ conversationId, readBy: { $ne: trackId } }, { $addToSet: { readBy: trackId } });
    io.to(`conversation:${conversationId}`).emit('chat:read', { conversationId, readBy: trackId });
    io.to(`user:${trackId}`).emit('chat:read', { conversationId, readBy: trackId });
    res.json({ ok: true });
  } catch (error) {
    console.error('Error marking as read:', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/chat/message/:messageId', async (req, res) => {
  try {
    const { messageId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(messageId)) return res.status(400).json({ error: 'Invalid message ID' });
    const message = await Message.findById(messageId);
    if (!message) return res.json({ ok: true, alreadyDeleted: true });
    const { conversationId } = message;
    await Message.deleteOne({ _id: messageId });
    const latestMsg = await Message.findOne({ conversationId }).sort({ timestamp: -1 });
    await Conversation.findOneAndUpdate({ conversationId }, { lastMessage: latestMsg ? latestMsg.text : '', lastTimestamp: latestMsg ? latestMsg.timestamp : 0 });
    io.to(`conversation:${conversationId}`).emit('chat:messageDeleted', { messageId, conversationId });
    console.log(`🗑 Message deleted for everyone: ${messageId}`);
    res.json({ ok: true });
  } catch (error) {
    console.error('Error deleting message:', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/chat/messages/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params;
    await Message.deleteMany({ conversationId });
    await Conversation.findOneAndUpdate({ conversationId }, { lastMessage: '', lastTimestamp: 0 });
    io.to(`conversation:${conversationId}`).emit('chat:cleared', { conversationId });
    console.log(`🗑 Chat cleared: ${conversationId}`);
    res.json({ ok: true });
  } catch (error) {
    console.error('Error clearing chat:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== SOCKET.IO ====================

io.on('connection', (socket) => {
  console.log('👤 Socket connected:', socket.id);
  socket.on('track:subscribe', (trackId) => { socket.join(`track:${trackId}`); socket.emit('track:subscribed', { trackId, success: true }); });
  socket.on('track:unsubscribe', (trackId) => { socket.leave(`track:${trackId}`); });
  socket.on('user:join', (trackId) => { socket.join(`user:${trackId}`); socket.emit('user:joined', { trackId, success: true }); console.log(`👤 ${trackId} joined personal room`); });
  socket.on('conversation:join', (conversationId) => { socket.join(`conversation:${conversationId}`); socket.emit('conversation:joined', { conversationId, success: true }); });
  socket.on('conversation:leave', (conversationId) => { socket.leave(`conversation:${conversationId}`); });
  socket.on('location:update', async (data) => {
    try {
      const { trackId, lat, lng, speed, accuracy } = data;
      if (!trackId || lat === undefined || lng === undefined) return;
      const now = new Date();
      await Location.findOneAndUpdate({ trackId }, { lat, lng, speed: speed || 0, accuracy: accuracy || 0, timestamp: now, isActive: true }, { upsert: true, new: true });
      PathHistory.findOneAndUpdate({ trackId }, { $push: { points: { $each: [{ lat, lng, timestamp: now }], $slice: -1000 } }, lastUpdated: now }, { upsert: true }).catch(() => {});
      const updateData = { trackId, lat, lng, speed: speed || 0, accuracy: accuracy || 0, timestamp: now, isRecent: true };
      io.to(`track:${trackId}`).emit('location:updated', updateData);
      io.emit('location:updated', updateData);
    } catch (error) {
      console.error('Socket location update error:', error);
      socket.emit('error', { message: error.message });
    }
  });
  socket.on('ping', () => socket.emit('pong', { timestamp: new Date() }));
  socket.on('disconnect', (reason) => console.log('👤 Disconnected:', socket.id, reason));
  socket.on('error', (error) => console.error('Socket error:', error));
});

// POST /api/chat/video-delivered/:msgId — clear video payload after receiver saves it locally
app.post('/api/chat/video-delivered/:msgId', async (req, res) => {
  try {
    const { msgId } = req.params;
    await Message.findByIdAndUpdate(msgId, { imageBase64: '', videoDelivered: true });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== SOS ROUTES ====================

// POST /api/sos — broadcast SOS from a user to all their watchers
app.post('/api/sos', async (req, res) => {
  try {
    const { trackId, displayName, lat, lng } = req.body;
    if (!trackId) return res.status(400).json({ error: 'trackId required' });
    // Persist so contacts can poll it
    await SosAlert.findOneAndUpdate(
      { senderTrackId: trackId },
      { senderTrackId: trackId, displayName: displayName || trackId, lat: lat || 0, lng: lng || 0,
        videoBase64: '', timestamp: new Date(),
        expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000) },
      { upsert: true, new: true }
    );
    // Real-time push to any socket watchers
    io.to(`track:${trackId}`).emit('sos_alert', { trackId, displayName: displayName || trackId, lat, lng, timestamp: new Date() });
    console.log(`🚨 SOS from ${trackId}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/sos/video/:trackId — attach video to existing SOS alert
app.post('/api/sos/video/:trackId', async (req, res) => {
  try {
    const { trackId } = req.params;
    const { videoBase64 } = req.body;
    if (!videoBase64) return res.status(400).json({ error: 'videoBase64 required' });
    await SosAlert.findOneAndUpdate({ senderTrackId: trackId }, { videoBase64 });
    io.to(`track:${trackId}`).emit('sos_video', { trackId, videoBase64 });
    console.log(`🎥 SOS video uploaded by ${trackId}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/sos/pending/:myTrackId — return active SOS alerts from contacts tracking myTrackId
app.get('/api/sos/pending/:myTrackId', async (req, res) => {
  try {
    const { myTrackId } = req.params;
    // Find all users who have myTrackId in their friends list
    const watchers = await User.find({ friends: myTrackId }).select('trackId').lean();
    const watcherTrackIds = watchers.map(w => w.trackId);
    const now = new Date();
    const alerts = await SosAlert.find({
      senderTrackId: { $in: watcherTrackIds },
      expiresAt: { $gt: now }
    }).lean();
    res.json(alerts.map(a => ({
      trackId: a.senderTrackId,
      displayName: a.displayName,
      lat: a.lat,
      lng: a.lng,
      videoBase64: a.videoBase64,
      timestamp: a.timestamp
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== AUTO CLEANUP (hourly) ====================

setInterval(async () => {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [dl, dp] = await Promise.all([Location.deleteMany({ timestamp: { $lt: cutoff } }), PathHistory.deleteMany({ lastUpdated: { $lt: cutoff } })]);
    if (dl.deletedCount > 0 || dp.deletedCount > 0) console.log(`🧹 Auto-cleanup: ${dl.deletedCount} locations, ${dp.deletedCount} paths`);
  } catch (error) {
    console.error('Auto-cleanup error:', error);
  }
}, 60 * 60 * 1000);

// ==================== ERROR HANDLING ====================

app.use((req, res) => { res.status(404).json({ error: 'Endpoint not found', path: req.path, method: req.method }); });
app.use((err, req, res, next) => { console.error('Global error:', err); res.status(500).json({ error: 'Internal server error', message: err.message }); });

// ==================== START ====================

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Socket.IO ready`);
  console.log(`✅ All endpoints configured`);
});
