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

// Mongoose Schemas
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

const Location = mongoose.model('Location', locationSchema);
const PathHistory = mongoose.model('PathHistory', pathHistorySchema);

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
      deactivate: 'POST /api/location/deactivate/:trackId'
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

// ==================== SOCKET.IO REAL-TIME ====================

io.on('connection', (socket) => {
  console.log('👤 New client connected:', socket.id);
  
  // Subscribe to track a specific user
  socket.on('track:subscribe', (trackId) => {
    console.log(`📍 Client ${socket.id} subscribed to track ${trackId}`);
    socket.join(`track:${trackId}`);
    
    // Send acknowledgment
    socket.emit('track:subscribed', { trackId, success: true });
  });
  
  // Unsubscribe from tracking
  socket.on('track:unsubscribe', (trackId) => {
    console.log(`📍 Client ${socket.id} unsubscribed from track ${trackId}`);
    socket.leave(`track:${trackId}`);
    
    // Send acknowledgment
    socket.emit('track:unsubscribed', { trackId, success: true });
  });
  
  // Real-time location update via Socket.IO
  socket.on('location:update', async (data) => {
    try {
      const { trackId, lat, lng, speed, accuracy } = data;
      
      // Validate data
      if (!trackId || lat === undefined || lng === undefined) {
        socket.emit('error', { message: 'Missing required fields' });
        return;
      }
      
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        socket.emit('error', { message: 'Invalid coordinates' });
        return;
      }
      
      // Update database
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
      
      // Broadcast to all clients (for general updates)
      io.emit('location:updated', updateData);
      
      // Broadcast to specific room subscribers
      io.to(`track:${trackId}`).emit('location:updated', updateData);
      
      // Legacy support - emit with track ID in event name
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

// Automatic cleanup job (runs every hour)
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