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
      'https://your-app-name.vercel.app', // Replace with your actual Vercel domain
      /\.vercel\.app$/ // Allow all Vercel preview deployments
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
    'https://your-app-name.vercel.app', // Replace with your actual Vercel domain
    /\.vercel\.app$/ // Allow all Vercel preview deployments
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

// Location Schema
const locationSchema = new mongoose.Schema({
  trackId: { type: String, required: true, unique: true, index: true },
  lat: { type: Number, required: true },
  lng: { type: Number, required: true },
  speed: { type: Number, default: 0 },
  accuracy: { type: Number, default: 0 },
  timestamp: { type: Date, default: Date.now },
  isActive: { type: Boolean, default: true }
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

// Automatically remove old path points (older than 24 hours)
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

const Location = mongoose.model('Location', locationSchema);
const PathHistory = mongoose.model('PathHistory', pathHistorySchema);
const Message = mongoose.model('Message', messageSchema);
const Conversation = mongoose.model('Conversation', conversationSchema);

// ==================== REST API ROUTES ====================

// Root route - Backend status
app.get('/', (req, res) => {
  res.json({ 
    message: '✅ Location Tracker Backend API is running!',
    status: 'online',
    timestamp: new Date().toISOString(),
    endpoints: {
      health: '/api/health',
      generateTrackId: 'POST /api/track/generate',
      updateLocation: 'POST /api/location/update',
      getLocation: 'GET /api/location/:trackId',
      getPath: 'GET /api/path/:trackId',
      deactivate: 'POST /api/location/deactivate/:trackId',
      sendMessage: 'POST /api/chat/send',
      getConversations: 'GET /api/chat/conversations/:trackId',
      getMessages: 'GET /api/chat/messages/:conversationId',
      markRead: 'POST /api/chat/read'
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

// Generate new Track ID
app.post('/api/track/generate', async (req, res) => {
  try {
    let trackId;
    let exists = true;
    
    // Generate unique track ID
    while (exists) {
      trackId = 'TRK-' + Math.random().toString(36).substr(2, 9).toUpperCase();
      exists = await Location.findOne({ trackId });
    }
    
    console.log('📍 Generated Track ID:', trackId);
    res.json({ trackId });
  } catch (error) {
    console.error('Error generating track ID:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update location (REST API backup)
app.post('/api/location/update', async (req, res) => {
  try {
    const { trackId, lat, lng, speed, accuracy } = req.body;
    
    if (!trackId || lat === undefined || lng === undefined) {
      return res.status(400).json({ error: 'Missing required fields: trackId, lat, lng' });
    }
    
    // Validate coordinates
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'Invalid coordinates' });
    }
    
    // Update or create location
    const location = await Location.findOneAndUpdate(
      { trackId },
      {
        lat,
        lng,
        speed: speed || 0,
        accuracy: accuracy || 0,
        timestamp: new Date(),
        isActive: true
      },
      { upsert: true, new: true }
    );
    
    // Update path history
    await PathHistory.findOneAndUpdate(
      { trackId },
      {
        $push: {
          points: {
            $each: [{ lat, lng, timestamp: new Date() }],
            $slice: -1000 // Keep only last 1000 points
          }
        },
        lastUpdated: new Date()
      },
      { upsert: true, new: true }
    );
    
    // Emit real-time update via Socket.IO
    io.emit('location:updated', {
      trackId,
      lat,
      lng,
      speed: speed || 0,
      accuracy: accuracy || 0,
      timestamp: new Date()
    });
    
    // Also emit to legacy format for backward compatibility
    io.emit(`location:${trackId}`, {
      trackId,
      lat,
      lng,
      speed: speed || 0,
      accuracy: accuracy || 0,
      timestamp: new Date()
    });
    
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
    
    if (!trackId) {
      return res.status(400).json({ error: 'Track ID is required' });
    }
    
    const location = await Location.findOne({ trackId });
    
    if (!location) {
      return res.status(404).json({ error: 'Track ID not found' });
    }
    
    // Check if location is recent (within last 30 seconds)
    const thirtySecondsAgo = new Date(Date.now() - 30000);
    const isRecent = location.timestamp > thirtySecondsAgo;
    
    res.json({
      ...location.toObject(),
      isRecent
    });
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
    
    if (!trackId) {
      return res.status(400).json({ error: 'Track ID is required' });
    }
    
    const pathHistory = await PathHistory.findOne({ trackId });
    
    if (!pathHistory) {
      return res.json({ points: [] });
    }
    
    // Filter points by time range
    const hoursNum = parseInt(hours);
    const timeAgo = new Date(Date.now() - hoursNum * 60 * 60 * 1000);
    const recentPoints = pathHistory.points.filter(point => point.timestamp > timeAgo);
    
    res.json({ points: recentPoints });
  } catch (error) {
    console.error('Error fetching path history:', error);
    res.status(500).json({ error: error.message });
  }
});

// Mark user as inactive (stop sharing location)
app.post('/api/location/deactivate/:trackId', async (req, res) => {
  try {
    const { trackId } = req.params;
    
    if (!trackId) {
      return res.status(400).json({ error: 'Track ID is required' });
    }
    
    const result = await Location.findOneAndUpdate(
      { trackId },
      { isActive: false },
      { new: true }
    );
    
    if (!result) {
      return res.status(404).json({ error: 'Track ID not found' });
    }
    
    console.log(`📍 Location deactivated for ${trackId}`);
    res.json({ success: true, message: 'Location sharing deactivated' });
  } catch (error) {
    console.error('Error deactivating location:', error);
    res.status(500).json({ error: error.message });
  }
});

// Clean up old inactive locations (manual trigger)
app.post('/api/cleanup', async (req, res) => {
  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    // Delete locations that haven't been updated in 24 hours
    const deletedLocations = await Location.deleteMany({
      timestamp: { $lt: twentyFourHoursAgo }
    });
    
    // Delete path histories that haven't been updated in 24 hours
    const deletedPaths = await PathHistory.deleteMany({
      lastUpdated: { $lt: twentyFourHoursAgo }
    });
    
    console.log(`🧹 Manual cleanup: Deleted ${deletedLocations.deletedCount} locations and ${deletedPaths.deletedCount} paths`);
    
    res.json({
      success: true,
      deletedLocations: deletedLocations.deletedCount,
      deletedPaths: deletedPaths.deletedCount
    });
  } catch (error) {
    console.error('Cleanup error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get statistics (optional - for debugging)
app.get('/api/stats', async (req, res) => {
  try {
    const totalLocations = await Location.countDocuments();
    const activeLocations = await Location.countDocuments({ isActive: true });
    const totalPaths = await PathHistory.countDocuments();
    
    res.json({
      totalLocations,
      activeLocations,
      inactiveLocations: totalLocations - activeLocations,
      totalPaths,
      timestamp: new Date()
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== CHAT API ROUTES ====================

// Send a message
app.post('/api/chat/send', async (req, res) => {
  try {
    const { conversationId, senderId, senderName, receiverId, receiverName, text } = req.body;

    if (!conversationId || !senderId || !receiverId || !text) {
      return res.status(400).json({ error: 'Missing required fields: conversationId, senderId, receiverId, text' });
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

    // Emit real-time message via Socket.IO to conversation room
    io.to(`conversation:${conversationId}`).emit('chat:message', {
      conversationId,
      senderId,
      senderName,
      text,
      timestamp: ts
    });

    // Also notify receiver directly if they're online
    io.to(`user:${receiverId}`).emit('chat:newMessage', {
      conversationId,
      senderId,
      senderName,
      text,
      timestamp: ts
    });

    console.log(`💬 Message sent in conversation ${conversationId} by ${senderId}`);
    res.json({ ok: true });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all conversations for a trackId
app.get('/api/chat/conversations/:trackId', async (req, res) => {
  try {
    const { trackId } = req.params;

    if (!trackId) {
      return res.status(400).json({ error: 'Track ID is required' });
    }

    const convos = await Conversation.find({ participants: trackId }).sort({ lastTimestamp: -1 });

    res.json(convos.map(c => ({
      conversationId: c.conversationId,
      participants: c.participants,
      names: Object.fromEntries(c.names || []),
      lastMessage: c.lastMessage,
      lastTimestamp: c.lastTimestamp,
      unread: Object.fromEntries(c.unread || [])
    })));
  } catch (error) {
    console.error('Error fetching conversations:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get messages for a conversation
app.get('/api/chat/messages/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params;

    if (!conversationId) {
      return res.status(400).json({ error: 'Conversation ID is required' });
    }

    const msgs = await Message.find({ conversationId })
      .sort({ timestamp: 1 })
      .limit(200);

    res.json(msgs);
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: error.message });
  }
});

// Mark conversation as read for a trackId
app.post('/api/chat/read', async (req, res) => {
  try {
    const { conversationId, trackId } = req.body;

    if (!conversationId || !trackId) {
      return res.status(400).json({ error: 'Missing required fields: conversationId, trackId' });
    }

    await Conversation.findOneAndUpdate(
      { conversationId },
      { $set: { [`unread.${trackId}`]: 0 } }
    );

    console.log(`✅ Marked conversation ${conversationId} as read for ${trackId}`);
    res.json({ ok: true });
  } catch (error) {
    console.error('Error marking as read:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== SOCKET.IO REAL-TIME ====================

io.on('connection', (socket) => {
  console.log('👤 New client connected:', socket.id);
  
  // Subscribe to track a specific user
  socket.on('track:subscribe', (trackId) => {
    console.log(`📍 Client ${socket.id} subscribed to track ${trackId}`);
    socket.join(`track:${trackId}`);
    socket.emit('track:subscribed', { trackId, success: true });
  });
  
  // Unsubscribe from tracking
  socket.on('track:unsubscribe', (trackId) => {
    console.log(`📍 Client ${socket.id} unsubscribed from track ${trackId}`);
    socket.leave(`track:${trackId}`);
    socket.emit('track:unsubscribed', { trackId, success: true });
  });

  // Join a user's personal room (for chat notifications)
  socket.on('user:join', (trackId) => {
    console.log(`👤 Client ${socket.id} joined user room: ${trackId}`);
    socket.join(`user:${trackId}`);
    socket.emit('user:joined', { trackId, success: true });
  });

  // Join a specific conversation room
  socket.on('conversation:join', (conversationId) => {
    console.log(`💬 Client ${socket.id} joined conversation: ${conversationId}`);
    socket.join(`conversation:${conversationId}`);
    socket.emit('conversation:joined', { conversationId, success: true });
  });

  // Leave a conversation room
  socket.on('conversation:leave', (conversationId) => {
    console.log(`💬 Client ${socket.id} left conversation: ${conversationId}`);
    socket.leave(`conversation:${conversationId}`);
  });
  
  // Real-time location update via Socket.IO
  socket.on('location:update', async (data) => {
    try {
      const { trackId, lat, lng, speed, accuracy } = data;
      
      if (!trackId || lat === undefined || lng === undefined) {
        socket.emit('error', { message: 'Missing required fields' });
        return;
      }
      
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        socket.emit('error', { message: 'Invalid coordinates' });
        return;
      }
      
      await Location.findOneAndUpdate(
        { trackId },
        {
          lat,
          lng,
          speed: speed || 0,
          accuracy: accuracy || 0,
          timestamp: new Date(),
          isActive: true
        },
        { upsert: true, new: true }
      );
      
      await PathHistory.findOneAndUpdate(
        { trackId },
        {
          $push: {
            points: {
              $each: [{ lat, lng, timestamp: new Date() }],
              $slice: -1000
            }
          },
          lastUpdated: new Date()
        },
        { upsert: true }
      );
      
      const updateData = {
        trackId,
        lat,
        lng,
        speed: speed || 0,
        accuracy: accuracy || 0,
        timestamp: new Date()
      };
      
      io.emit('location:updated', updateData);
      io.to(`track:${trackId}`).emit('location:updated', updateData);
      io.emit(`location:${trackId}`, updateData);
      
      console.log(`📍 Real-time location updated for ${trackId} via Socket.IO`);
      
    } catch (error) {
      console.error('Socket.IO location update error:', error);
      socket.emit('error', { message: error.message });
    }
  });
  
  // Handle ping for connection keep-alive
  socket.on('ping', () => {
    socket.emit('pong', { timestamp: new Date() });
  });
  
  socket.on('disconnect', (reason) => {
    console.log('👤 Client disconnected:', socket.id, 'Reason:', reason);
  });
  
  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });
});

// ==================== AUTOMATIC CLEANUP JOB ====================

setInterval(async () => {
  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    const deletedLocations = await Location.deleteMany({
      timestamp: { $lt: twentyFourHoursAgo }
    });
    
    const deletedPaths = await PathHistory.deleteMany({
      lastUpdated: { $lt: twentyFourHoursAgo }
    });
    
    if (deletedLocations.deletedCount > 0 || deletedPaths.deletedCount > 0) {
      console.log(`🧹 Auto-cleanup: Deleted ${deletedLocations.deletedCount} locations and ${deletedPaths.deletedCount} path histories`);
    }
  } catch (error) {
    console.error('Auto-cleanup error:', error);
  }
}, 60 * 60 * 1000); // Run every hour

// ==================== ERROR HANDLING ====================

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Endpoint not found',
    path: req.path,
    method: req.method,
    message: 'Please check the API documentation'
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Global error handler:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: err.message 
  });
});

// ==================== START SERVER ====================

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Socket.IO ready for real-time connections`);
  console.log(`🌐 CORS enabled for Vercel deployments`);
  console.log(`✅ All endpoints configured and ready`);
});
