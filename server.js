require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const NodeCache = require('node-cache');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const cloudinary = require('cloudinary').v2;
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
// const { createClient } = require('redis'); // DISABLED - using MongoDB instead

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '820558273332-3jmo1on8p0r33m76hoskl8v2v22gq1ng.apps.googleusercontent.com';
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

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

// Serve static files from public directory
app.use(express.static('public'));

// ─── Cloudinary Configuration ───────────────────────────────────────────────────
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Helper — upload base64 to Cloudinary, returns secure URL
async function uploadToCloudinary(base64String, folder = 'chat') {
    const result = await cloudinary.uploader.upload(
        `data:image/jpeg;base64,${base64String}`,
        {
            folder,
            resource_type: 'image',
            transformation: [
                { width: 1280, crop: 'limit' },   // cap at 1280px
                { quality: 'auto:good' },          // auto compress
                { fetch_format: 'auto' }           // serve webp/avif if supported
            ]
        }
    );
    return {
        url:       result.secure_url,
        publicId:  result.public_id,
        width:     result.width,
        height:    result.height
    };
}

// Helper — delete from Cloudinary by public_id
async function deleteFromCloudinary(publicId) {
    if (!publicId) return;
    try {
        await cloudinary.uploader.destroy(publicId);
    } catch (err) {
        console.error('Cloudinary delete error:', err.message);
    }
}

// ─── Redis setup (DISABLED - using MongoDB instead) ─────────────────────────────
// const redisUrl = process.env.REDIS_URL;

// ─── Redis DISABLED - using MongoDB instead ───────────────────────────────────
/*
// pub  = used for PUBLISH (writing events)
// sub  = used for SUBSCRIBE (reading events) — must be a separate client
// data = used for GET/SET/HSET (data reads and writes)
const redisPub  = createClient({ url: redisUrl });
const redisSub  = createClient({ url: redisUrl });
const redisData = createClient({ url: redisUrl });

async function connectRedis() {
  await Promise.all([redisPub.connect(), redisSub.connect(), redisData.connect()]);
  console.log('✅ Redis connected (pub/sub/data)');
}
connectRedis().catch(err => console.error('❌ Redis connection error:', err));

redisPub.on('error',  e => console.error('Redis pub error:',  e.message));
redisSub.on('error',  e => console.error('Redis sub error:',  e.message));
redisData.on('error', e => console.error('Redis data error:', e.message));

// Key helpers
const locKey     = trackId => `loc:${trackId}`;          // Latest location hash
const pathKey    = trackId => `path:${trackId}`;          // Recent path (Redis list)
const chanKey    = trackId => `track:${trackId}`;         // Pub/sub channel
const kalmanKey  = trackId => `kalman:${trackId}`;        // Kalman state hash
const TTL_LOC    = 60;     // seconds — location key TTL (was 30)
const TTL_PATH   = 86400;  // seconds — path key TTL (24h)
const TTL_KALMAN = 1800;   // seconds — Kalman state TTL (30min, was 5min)
*/
const MAX_PATH_PTS = 2000;

// ─── In-memory Kalman state (loses state on server restart) ─────────────────────
const kalmanStore = new Map(); // trackId -> { latEst, lngEst, latVar, lngVar, lastMs, lastHeading }

async function getKalmanState(trackId) {
  // Check in-memory store first
  const state = kalmanStore.get(trackId);
  if (state) return state;

  // Fallback: rehydrate from last MongoDB location
  try {
    const lastLoc = await Location.findOne({ trackId }).lean();
    if (lastLoc && lastLoc.accuracy) {
      const newState = {
        latEst: lastLoc.lat,
        lngEst: lastLoc.lng,
        latVar: lastLoc.accuracy * lastLoc.accuracy,
        lngVar: lastLoc.accuracy * lastLoc.accuracy,
        lastMs: new Date(lastLoc.timestamp).getTime(),
        lastHeading: lastLoc.heading || null
      };
      // Store in memory
      kalmanStore.set(trackId, newState);
      console.log(`🔄 Kalman rehydrated from MongoDB for ${trackId}`);
      return newState;
    }
  } catch (e) { console.error('Kalman MongoDB rehydration error:', e.message); }

  return null; // Truly fresh start
}

async function setKalmanState(trackId, state) {
  // Store in memory only (loses state on server restart)
  kalmanStore.set(trackId, state);
}

async function serverKalman(trackId, lat, lng, accuracyM, nowMs, speedMs = 0, heading = null) {
  const Q_BASE = speedMs < 0.3 ? 0.3 : speedMs < 2 ? 1.0 : speedMs < 8 ? 3.0 : 6.0;
  let state = await getKalmanState(trackId);

  if (!state) {
    state = { latEst: lat, lngEst: lng, latVar: accuracyM * accuracyM, lngVar: accuracyM * accuracyM, lastMs: nowMs, lastHeading: heading };
    await setKalmanState(trackId, state);
    return { lat, lng };
  }

  // Heading validation: reject 180° flips as GPS noise
  if (heading !== null && state.lastHeading !== null && state.lastHeading !== undefined) {
    const headingDelta = Math.abs(heading - state.lastHeading);
    const normalizedDelta = headingDelta > 180 ? 360 - headingDelta : headingDelta;
    if (normalizedDelta > 150 && speedMs > 0.5) {
      // Likely GPS noise — reduce Kalman gain by inflating measurement noise
      accuracyM = Math.max(accuracyM, 50);
    }
  }

  const dt  = Math.min((nowMs - state.lastMs) / 1000, 10);
  const q   = Q_BASE * Q_BASE * dt;
  state.latVar += q;
  state.lngVar += q;

  const R    = accuracyM * accuracyM;
  const kLat = state.latVar / (state.latVar + R);
  state.latEst = state.latEst + kLat * (lat - state.latEst);
  state.latVar = (1 - kLat) * state.latVar;

  const kLng = state.lngVar / (state.lngVar + R);
  state.lngEst = state.lngEst + kLng * (lng - state.lngEst);
  state.lngVar = (1 - kLng) * state.lngVar;

  state.lastMs = nowMs;
  state.lastHeading = heading;
  await setKalmanState(trackId, state);
  return { lat: state.latEst, lng: state.lngEst };
}

// ─── NodeCache for map matching and road snapping (keep these) ───────────────
const mapMatchCache  = new NodeCache({ stdTTL: 30,   checkperiod: 10 });
const roadSnapCache  = new NodeCache({ stdTTL: 300,  checkperiod: 60 });
const watcherMap     = new Map(); // trackId → Set<watcherTrackId>

// Call this when a user subscribes to watch someone
function addWatcher(ownerTrackId, watcherTrackId) {
  if (!watcherMap.has(ownerTrackId)) watcherMap.set(ownerTrackId, new Set());
  watcherMap.get(ownerTrackId).add(watcherTrackId);
}
function removeWatcher(ownerTrackId, watcherTrackId) {
  watcherMap.get(ownerTrackId)?.delete(watcherTrackId);
}

const MAPBOX_DIRECTIONS_TOKEN = process.env.MAPBOX_TOKEN;

// 


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
  trackId:         { type: String, required: true, unique: true, index: true },
  lat:             { type: Number, default: 0 },
  lng:             { type: Number, default: 0 },
  speed:           { type: Number, default: 0 },
  accuracy:        { type: Number, default: 0 },
  heading:         { type: Number, default: 0 },
  altitude:        { type: Number, default: 0 },
  altAccuracy:     { type: Number, default: 0 },
  speedAccuracy:   { type: Number, default: 0 },
  headingAccuracy: { type: Number, default: 0 },
  provider:        { type: String, default: 'gps' },
  snapped:         { type: Boolean, default: false },
  roadName:        { type: String,  default: '' },
  timestamp:       { type: Date, default: Date.now },
  isActive:        { type: Boolean, default: true },
  encryptedCoords: { type: String, default: '' }
});

const pathHistorySchema = new mongoose.Schema({
  trackId: { type: String, required: true, index: true },
  points: [{
    lat:       Number,
    lng:       Number,
    timestamp: Date,
    speed:     { type: Number, default: 0 },
    heading:   { type: Number, default: 0 }
  }],
  lastUpdated: { type: Date, default: Date.now }
});

pathHistorySchema.pre('save', function(next) {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  this.points = this.points.filter(p => p.timestamp > cutoff);
  next();
});

// ─── Message schema — now uses Cloudinary URLs ─────────────────────────────────
const messageSchema = new mongoose.Schema({
  conversationId: { type: String, index: true },
  senderId:       String,
  senderName:     String,
  text:           String,
  timestamp:      { type: Number, default: () => Date.now() },
  readBy:         { type: [String], default: [] },
  // Photo / video sharing fields
  type:           { type: String, default: 'text', enum: ['text', 'image', 'video'] },
  imageUrl:       { type: String, default: '' },   // Cloudinary URL
  imagePublicId:  { type: String, default: '' },   // Cloudinary public_id for deletion
  imageBase64:    { type: String, default: '' },   // Keep for migration, will be deprecated
  videoDelivered: { type: Boolean, default: false }
});
messageSchema.index({ conversationId: 1, timestamp: 1 });
messageSchema.index({ conversationId: 1, readBy: 1 });

// ─── Image batch schema — stores Cloudinary URLs for batch uploads ───────────────
const imageBatchSchema = new mongoose.Schema({
  batchId:        { type: String, unique: true, index: true },
  conversationId: { type: String, index: true },
  senderId:       String,
  senderName:     String,
  images: [{
    imageUrl:      String,   // Cloudinary URL
    imagePublicId: String,   // Cloudinary public_id for deletion
    timestamp:     Number
  }],
  timestamp: { type: Number, default: () => Date.now() }
});
const ImageBatch = mongoose.model('ImageBatch', imageBatchSchema);

const conversationSchema = new mongoose.Schema({
  conversationId: { type: String, unique: true },
  participants:   [String],
  names:          { type: Map, of: String },
  lastMessage:    String,
  lastTimestamp:  Number,
  unread:         { type: Map, of: Number, default: {} }
});

const userSchema = new mongoose.Schema({
  uid: { type: String, required: true, unique: true, index: true },
  trackId: { type: String, required: true, index: true },
  displayName: { type: String, default: '' },
  email: { type: String, required: true, unique: true, index: true },
  passwordHash: { type: String, default: '' }, // Optional for Google auth users
  avatarBase64: { type: String, default: '' },
  friends: { type: [String], default: [] },
  savedFriends: {
    type: [{
      trackId: String,
      displayName: String,
      email: String,
      avatarBase64: String
    }],
    default: []
  },
  blockedUsers: { type: [String], default: [] },  // Users this user has blocked
  blockedBy: { type: [String], default: [] },  // Users who have blocked this user
  privacyMode: { type: String, default: 'EVERYONE', enum: ['EVERYONE', 'CONTACTS_ONLY', 'SELECTED'] },
  approvedIds: { type: [String], default: [] },  // Explicit allow-list for SELECTED mode
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

// Warm-up endpoint — responds immediately but pre-warms MongoDB in background
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
  // Warm MongoDB in background without blocking the response
  setImmediate(() => {
    User.findOne({}).lean().catch(() => {});
    Location.findOne({}).lean().catch(() => {});
  });
});

// External monitoring endpoint for UptimeRobot
app.get('/api/warmup', (req, res) => {
  // Respond instantly
  res.json({ ok: true, ts: Date.now() });
  // Pre-warm DB connections in background
  setImmediate(async () => {
    try {
      await Promise.all([
        User.findOne({}).lean(),
        Location.findOne({}).lean()
      ]);
    } catch (_) {}
  });
});

// ==================== AUTHENTICATION MIDDLEWARE ====================

async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    console.log('❌ No token provided in request');
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    console.log('✅ Token decoded successfully for uid:', decoded.uid);
    req.user = decoded;
    next();
  } catch (error) {
    console.error('❌ Token verification error:', error.message);
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

// ==================== AUTH ROUTES ====================

app.post('/api/auth/google', async (req, res) => {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({ error: 'Google ID token is required' });
    }

    // Verify Google ID token
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();
    const googleUid = payload.sub;
    const googleEmail = payload.email;

    if (!googleEmail) {
      return res.status(400).json({ error: 'Invalid Google token: no email' });
    }

    // Check if user exists in our database (by uid or email as fallback)
    let user = await User.findOne({ uid: googleUid })
            || await User.findOne({ email: googleEmail.toLowerCase() });

    if (!user) {
      // Generate unique trackId
      let trackId, exists = true;
      while (exists) {
        trackId = 'TRK-' + Math.random().toString(36).substr(2, 9).toUpperCase();
        exists = await Location.findOne({ trackId });
      }

      // Create user
      user = await User.create({
        uid: googleUid,
        trackId,
        email: googleEmail.toLowerCase(),
        displayName: payload.name || '',
        avatarBase64: payload.picture || '',
        friends: [],
        savedFriends: [],
        blockedUsers: [],
        blockedBy: [],
        privacyMode: 'EVERYONE',
        approvedIds: [],
        createdAt: new Date(),
        updatedAt: new Date()
      });

      // Create location entry
      await Location.create({
        trackId,
        lat: 0,
        lng: 0,
        isActive: false
      });

      console.log(`📝 User auto-registered on Google login: ${googleEmail} → ${trackId}`);
    } else if (user.uid !== googleUid) {
      // Migrate old record to new Google uid
      user = await User.findOneAndUpdate(
        { email: googleEmail.toLowerCase() },
        { uid: googleUid, updatedAt: new Date() },
        { new: true }
      );
    }

    // Generate JWT token
    const token = jwt.sign(
      { uid: user.uid, email: user.email, trackId: user.trackId },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log(`🔐 User logged in via Google: ${googleEmail}`);
    res.json({
      success: true,
      token,
      user: {
        uid: user.uid,
        trackId: user.trackId,
        email: user.email,
        displayName: user.displayName,
        avatarBase64: user.avatarBase64
      }
    });
  } catch (error) {
    console.error('Error with Google authentication:', error);
    res.status(500).json({ error: 'Google authentication failed' });
  }
});

app.post('/api/auth/verify-token', authenticateToken, async (req, res) => {
  try {
    console.log('🔍 Token verification request for uid:', req.user?.uid);
    const user = await User.findOne({ uid: req.user.uid });
    if (!user) {
      console.log('❌ User not found for uid:', req.user?.uid);
      return res.status(404).json({ error: 'User not found' });
    }

    console.log('✅ Token verification successful for user:', user.email);
    res.json({
      success: true,
      user: {
        uid: user.uid,
        trackId: user.trackId,
        email: user.email,
        displayName: user.displayName,
        avatarBase64: user.avatarBase64
      }
    });
  } catch (error) {
    console.error('❌ Error verifying token:', error);
    res.status(500).json({ error: error.message });
  }
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

app.get('/api/user/:uid', authenticateToken, async (req, res) => {
  try {
    const { uid } = req.params;
    // Only allow users to fetch their own data
    if (uid !== req.user.uid) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const user = await User.findOne({ uid });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ uid: user.uid, trackId: user.trackId, displayName: user.displayName, email: user.email, avatarBase64: user.avatarBase64 || '', friends: user.friends, savedFriends: user.savedFriends || [] });
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/user/upsert', authenticateToken, async (req, res) => {
  try {
    const { uid, trackId, displayName, email } = req.body;
    if (!uid || !trackId) return res.status(400).json({ error: 'uid and trackId are required' });
    // Only allow users to upsert their own data
    if (uid !== req.user.uid) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const user = await User.findOneAndUpdate({ uid }, { uid, trackId, displayName: displayName || '', email: email || '', updatedAt: new Date() }, { upsert: true, new: true });
    await Location.findOneAndUpdate({ trackId }, { $setOnInsert: { trackId, lat: 0, lng: 0, isActive: false } }, { upsert: true });
    console.log(`👤 User upserted: ${uid} → ${trackId}`);
    res.json({ success: true, user });
  } catch (error) {
    console.error('Error upserting user:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/user/:uid/avatar', authenticateToken, async (req, res) => {
  try {
    const { uid }          = req.params;
    const { avatarBase64 } = req.body;
    if (!avatarBase64) return res.status(400).json({ error: 'avatarBase64 required' });
    // Only allow users to update their own avatar
    if (uid !== req.user.uid) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const user = await User.findOneAndUpdate({ uid }, { avatarBase64, updatedAt: new Date() }, { new: true });
    if (!user) return res.status(404).json({ error: 'User not found' });
    console.log(`🖼 Avatar updated for ${uid}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving avatar:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/user/:uid/friends', authenticateToken, async (req, res) => {
  try {
    const { uid } = req.params;
    const { friends } = req.body;
    if (!Array.isArray(friends)) return res.status(400).json({ error: 'friends must be an array' });
    // Only allow users to update their own friends
    if (uid !== req.user.uid) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const user = await User.findOneAndUpdate({ uid }, { friends, updatedAt: new Date() }, { new: true });
    if (!user) return res.status(404).json({ error: 'User not found' });
    console.log(`👥 Friends updated for ${uid}: [${friends.join(', ')}]`);
    res.json({ success: true, friends: user.friends });
  } catch (error) {
    console.error('Error updating friends:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/user/:uid/saved-friends', authenticateToken, async (req, res) => {
  try {
    const { uid } = req.params;
    const { savedFriends } = req.body;
    if (!Array.isArray(savedFriends)) return res.status(400).json({ error: 'savedFriends must be an array' });
    // Only allow users to update their own saved friends
    if (uid !== req.user.uid) {
      return res.status(403).json({ error: 'Access denied' });
    }
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

// ─── Map Matching ─────────────────────────────────────────────────────────────

async function snapToRoad(lat, lng, heading = 0, radius = 25) {
  const cacheKey = `snap:${lat.toFixed(5)}:${lng.toFixed(5)}`;
  const cached   = roadSnapCache.get(cacheKey);
  if (cached) return cached;

  try {
    const url = `https://api.mapbox.com/matching/v5/mapbox/driving/` +
      `${lng},${lat}` +
      `?geometries=geojson` +
      `&radiuses=${radius}` +
      `&steps=false` +
      `&overview=full` +
      `&access_token=${MAPBOX_DIRECTIONS_TOKEN}`;

    const resp = await axios.get(url, { timeout: 2000 });
    const data = resp.data;

    if (data.code !== 'Ok' || !data.matchings?.length) {
      return { lat, lng, snapped: false, confidence: 0 };
    }

    const match   = data.matchings[0];
    const coords  = match.geometry.coordinates[0];
    const result  = {
      lat:        coords[1],
      lng:        coords[0],
      snapped:    true,
      confidence: match.confidence || 0,
      roadName:   data.tracepoints?.[0]?.name || ''
    };

    roadSnapCache.set(cacheKey, result);
    return result;
  } catch (err) {
    return { lat, lng, snapped: false, confidence: 0 };
  }
}

async function snapTraceToRoad(points) {
  if (!points || points.length === 0) return points;
  if (points.length === 1) {
    const snapped = await snapToRoad(points[0].lat, points[0].lng);
    return [{ ...points[0], ...snapped }];
  }

  const chunk   = points.slice(-25);
  const cacheKey = `trace:${chunk.map(p => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join('|')}`;
  const cached   = mapMatchCache.get(cacheKey);
  if (cached) return cached;

  try {
    const coords    = chunk.map(p => `${p.lng},${p.lat}`).join(';');
    const radii     = chunk.map(() => 25).join(';');
    const timestamps = chunk.map(p =>
      Math.floor(new Date(p.timestamp || Date.now()).getTime() / 1000)
    ).join(';');

    const url = `https://api.mapbox.com/matching/v5/mapbox/driving/` +
      `${coords}` +
      `?geometries=geojson` +
      `&radiuses=${radii}` +
      `&timestamps=${timestamps}` +
      `&steps=false` +
      `&overview=full` +
      `&tidy=true` +
      `&access_token=${MAPBOX_DIRECTIONS_TOKEN}`;

    const resp = await axios.get(url, { timeout: 3000 });
    const data = resp.data;

    if (data.code !== 'Ok' || !data.matchings?.length) {
      return points;
    }

    const matching    = data.matchings[0];
    const tracepoints = data.tracepoints || [];
    const matchedCoords = matching.geometry.coordinates;

    const result = chunk.map((pt, i) => {
      const tp = tracepoints[i];
      if (!tp) return pt;
      const mc = matchedCoords[tp.matchings_index] ||
                 matchedCoords[Math.min(i, matchedCoords.length - 1)];
      if (!mc) return pt;
      return {
        ...pt,
        lat:        mc[1],
        lng:        mc[0],
        snapped:    true,
        confidence: matching.confidence || 0,
        roadName:   tp.name || ''
      };
    });

    mapMatchCache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.error('Map matching error:', err.message);
    return points;
  }
}

function shouldSnapToRoad(accuracy, speed) {
  if (accuracy > 50)  return false;
  if (speed > 55)     return false;
  if (speed < 0.3)    return false;  // Don't snap if not actually moving
  return true;
}

// ==================== LOCATION ROUTES ====================

// ─── Dead Reckoning Predictor ─────────────────────────────────────────────────
// Extrapolate position forward using last known speed + heading
function deadReckon(location, nowMs, lastHeading = null) {
  const lastMs = new Date(location.timestamp).getTime();
  const dtSec  = (nowMs - lastMs) / 1000;

  // Only extrapolate up to 8 seconds — beyond that, data is too stale
  if (dtSec <= 0 || dtSec > 8 || !location.speed || location.speed < 0.5) {
    return { lat: location.lat, lng: location.lng, extrapolated: false };
  }

  // Reject extrapolation if heading changed > 45° suddenly (GPS noise)
  if (lastHeading !== null && lastHeading !== undefined) {
    const headingDelta = Math.abs((location.heading || 0) - lastHeading);
    const normalizedDelta = headingDelta > 180 ? 360 - headingDelta : headingDelta;
    if (normalizedDelta > 45) {
      return { lat: location.lat, lng: location.lng, extrapolated: false };
    }
  }

  const heading = location.heading || 0;
  const speedMs = location.speed; // m/s

  // Distance travelled since last fix
  const distM = speedMs * dtSec;

  // Convert bearing + distance to lat/lng delta
  const R     = 6_371_000;
  const dLat  = (distM * Math.cos(heading * Math.PI / 180)) / R;
  const dLng  = (distM * Math.sin(heading * Math.PI / 180)) /
                (R * Math.cos(location.lat * Math.PI / 180));

  return {
    lat:          location.lat + (dLat * 180 / Math.PI),
    lng:          location.lng + (dLng * 180 / Math.PI),
    extrapolated: true,
    extrapolatedMs: dtSec * 1000
  };
}

const IS_RECENT_MS = 10_000;

// ─── MongoDB batch write queue (30s flush) ───────────────────────────────────
const mongoQueue = new Map(); // trackId → [{ locationData, pathPoint }]
function enqueueMongoWrite(trackId, locationData, pathPoint) {
  if (!mongoQueue.has(trackId)) mongoQueue.set(trackId, []);
  mongoQueue.get(trackId).push({ locationData, pathPoint });
}

setInterval(async () => {
  if (mongoQueue.size === 0) return;
  const batch = new Map(mongoQueue);
  mongoQueue.clear();

  for (const [trackId, items] of batch) {
    try {
      // Only write the latest location (intermediate ones are stale)
      const latest = items[items.length - 1].locationData;

      await Location.findOneAndUpdate(
        { trackId },
        {
          lat:             latest.lat,
          lng:             latest.lng,
          speed:           latest.speed,
          accuracy:        latest.accuracy,
          heading:         latest.heading,
          altitude:        latest.altitude,
          altAccuracy:     latest.altAccuracy,
          speedAccuracy:   latest.speedAccuracy,
          headingAccuracy: latest.headingAccuracy,
          provider:        latest.provider,
          encryptedCoords: latest.encryptedCoords,
          snapped:         latest.snapped,
          roadName:        latest.roadName,
          timestamp:       new Date(latest.timestamp),
          isActive:        true
        },
        { upsert: true }
      );

      // Collect all path points from this batch
      const pathPoints = items.map(i => i.pathPoint).filter(Boolean);
      if (pathPoints.length > 0) {
        await PathHistory.findOneAndUpdate(
          { trackId },
          {
            $push: { points: { $each: pathPoints, $slice: -MAX_PATH_PTS } },
            lastUpdated: new Date()
          },
          { upsert: true }
        );
      }
    } catch (e) {
      console.error(`Mongo batch write error for ${trackId}:`, e.message);
    }
  }
}, 30_000);

// ─── Location Engine: DISABLED - now using immediate Socket.IO broadcast ─────────
// Kalman filtering happens on server (for MongoDB) and Android (for display)
// No server-side interpolation needed
/*
// Interpolation helper: extrapolate position given lat/lng, distance (m), heading (deg)
function reckon(lat, lng, distM, heading) {
  const R = 6_371_000; // Earth radius in meters
  const dLat = (distM * Math.cos(heading * Math.PI / 180)) / R;
  const dLng = (distM * Math.sin(heading * Math.PI / 180)) / (R * Math.cos(lat * Math.PI / 180));
  return {
    lat: lat + (dLat * 180 / Math.PI),
    lng: lng + (dLng * 180 / Math.PI)
  };
}

class LocationEngine {
  constructor(redis, io) {
    this.redis = redis;
    this.io = io;
    this.states = new Map(); // trackId -> { real, velocity, heading, lastRealTime, confidence }
    this.streamKey = trackId => `stream:${trackId}`;

    // 5Hz interpolation tick (200ms intervals) - matches Android polling frequency
    this.tickInterval = setInterval(() => this.tick(), 200);
  }

  // Called when real GPS update arrives
  async onGpsUpdate(trackId, point) {
    const nowMs = Date.now();

    // Update interpolation state
    this.states.set(trackId, {
      real: { lat: point.lat, lng: point.lng },
      velocity: point.speed || 0, // m/s
      heading: point.heading || 0,
      lastRealTime: nowMs,
      confidence: 1.0
    });

    // Broadcast real point immediately to Android via Socket.IO
    this.broadcast(trackId, { ...point, isReal: true });
  }

  // 5Hz tick: interpolate positions between real GPS updates
  tick() {
    const nowMs = Date.now();

    for (const [trackId, state] of this.states) {
      const dt = (nowMs - state.lastRealTime) / 1000; // seconds since real GPS

      // Stop interpolating after 3 seconds of no GPS
      if (dt > 3) {
        state.confidence = 0;
        continue;
      }

      // Skip if not moving (less than 0.5m)
      if (state.velocity < 0.5) continue;

      // Fade confidence: 1.0 → 0.0 over 3 seconds
      state.confidence = Math.max(0, 1 - dt / 3);

      // Extrapolate position using dead reckoning
      const distM = state.velocity * dt;
      const predicted = reckon(state.real.lat, state.real.lng, distM, state.heading);

      // Broadcast interpolated point
      this.broadcast(trackId, {
        lat: predicted.lat,
        lng: predicted.lng,
        speed: state.velocity,
        heading: state.heading,
        isInterpolated: true,
        confidence: state.confidence,
        timestamp: nowMs
      });
    }
  }

  broadcast(trackId, point) {
    this.io.to(`track:${trackId}`).emit('location:updated', point);
  }

  // Clean up state when user stops tracking
  cleanup(trackId) {
    this.states.delete(trackId);
  }
}

// Initialize LocationEngine
const locationEngine = new LocationEngine(redisData, io);
*/

// ─── Core location write — replaces enqueueLocationUpdate + flushBatch ────────
async function writeLocation(trackId, point) {
  const now    = new Date();
  const nowMs  = now.getTime();

  // 0. Position jitter detection — reject unrealistic jumps
  if (!point.hasEncrypted && point.lat && point.lng) {
    const lastLoc = await readLocation(trackId);
    if (lastLoc && lastLoc.lat && lastLoc.lng) {
      const jumpDistance = haversineM(lastLoc.lat, lastLoc.lng, point.lat, point.lng);
      const timeDelta = (nowMs - lastLoc.timestamp) / 1000;
      const maxPossible = (lastLoc.speed * 1.5 + 20) * Math.max(timeDelta, 1); // 50% speed buffer + 20m GPS error

      if (jumpDistance > maxPossible && jumpDistance > 100) {
        console.warn(`⚠️ Position jump rejected: ${jumpDistance.toFixed(1)}m in ${timeDelta.toFixed(1)}s (max ${maxPossible.toFixed(1)}m) for ${trackId}`);
        // Use last known position instead of the jump
        point = { ...point, lat: lastLoc.lat, lng: lastLoc.lng };
      }
    }
  }

  // 1. Kalman smooth (async, uses in-memory state)
  let processedLat = point.lat;
  let processedLng = point.lng;
  if (!point.hasEncrypted && point.lat && point.lng) {
    const accM    = Math.max(point.accuracy || 20, 1);
    const smoothed = await serverKalman(trackId, point.lat, point.lng, accM, nowMs, point.speed || 0, point.heading || null);
    processedLat  = smoothed.lat;
    processedLng  = smoothed.lng;
  }

  // 2. Road snap (async, only if worth it)
  let snappedLat = processedLat;
  let snappedLng = processedLng;
  let snapped    = false;
  let roadName   = '';

  if (!point.hasEncrypted && shouldSnapToRoad(point.accuracy, point.speed)) {
    const snapResult = await snapToRoad(processedLat, processedLng, point.heading || 0);
    if (snapResult.snapped && (snapResult.confidence > 0.2 || (point.accuracy || 999) < 20)) {
      snappedLat = snapResult.lat;
      snappedLng = snapResult.lng;
      roadName   = snapResult.roadName || '';
      snapped    = true;
    }
  }

  const locationData = {
    trackId,
    lat:             point.hasEncrypted ? 0 : snappedLat,
    lng:             point.hasEncrypted ? 0 : snappedLng,
    speed:           point.speed           || 0,
    accuracy:        point.accuracy        || 0,
    heading:         point.heading         || 0,
    altitude:        point.altitude        || 0,
    altAccuracy:     point.altAccuracy     || 0,
    speedAccuracy:   point.speedAccuracy   || 0,
    headingAccuracy: point.headingAccuracy || 0,
    provider:        point.provider        || 'gps',
    encryptedCoords: point.encryptedCoords || '',
    snapped,
    roadName,
    timestamp:       nowMs,
    isActive:        true
  };

  // 3. Store path point in MongoDB PathHistory (async, don't await)
  if (!point.hasEncrypted) {
    PathHistory.findOneAndUpdate(
      { trackId },
      {
        $push: {
          points: {
            $each: [{ lat: snappedLat, lng: snappedLng, speed: point.speed || 0, heading: point.heading || 0, timestamp: nowMs }],
            $slice: -MAX_PATH_PTS
          }
        },
        $set: { lastUpdated: now }
      },
      { upsert: true }
    ).catch(() => {});
  }

  // 5. Enqueue for batched MongoDB write (30s queue, never blocks response)
  enqueueMongoWrite(trackId, locationData, point.hasEncrypted ? null : { lat: snappedLat, lng: snappedLng, timestamp: now, speed: point.speed || 0, heading: point.heading || 0 });

  // 6. Broadcast Kalman-filtered data immediately via Socket.IO (no interpolation)
  if (!point.hasEncrypted) {
    const broadcastData = {
      trackId,
      lat: snappedLat,
      lng: snappedLng,
      speed: point.speed || 0,
      heading: point.heading || 0,
      accuracy: point.accuracy || 0,
      timestamp: nowMs,
      isRecent: true
    };
    io.to(`track:${trackId}`).emit('location:updated', broadcastData);

    // Also broadcast to watchers
    const watchers = watcherMap.get(trackId);
    if (watchers && watchers.size > 0) {
      watchers.forEach(watcherTrackId => {
        io.to(`user:${watcherTrackId}`).emit('friend:location', {
          ...broadcastData,
          lat: point.encryptedCoords ? undefined : broadcastData.lat,
          lng: point.encryptedCoords ? undefined : broadcastData.lng
        });
      });
    }
  }

  return locationData;
}

// ─── Redis subscriber — DISABLED - now broadcasting directly in writeLocation ────
/*
async function setupRedisSubscriber() {
  await redisSub.pSubscribe('track:*', (message, channel) => {
    try {
      const data    = JSON.parse(message);
      const trackId = channel.replace('track:', '');

      io.to(`track:${trackId}`).emit('location:updated', data);

      const watchers = watcherMap.get(trackId);
      if (watchers && watchers.size > 0) {
        watchers.forEach(watcherTrackId => {
          io.to(`user:${watcherTrackId}`).emit('friend:location', {
            ...data,
            trackId,          // explicit trackId for Android client
            lat: data.encryptedCoords ? undefined : data.lat,
            lng: data.encryptedCoords ? undefined : data.lng
          });
        });
      }
    } catch (e) {
      console.error('Redis subscriber parse error:', e.message);
    }
  });
  console.log('✅ Redis subscriber ready — pattern: track:*');
}
setupRedisSubscriber().catch(console.error);
*/

// ─── MongoDB location read ──────────────────────────────────────────────────────
async function readLocation(trackId) {
  try {
    const loc = await Location.findOne({ trackId }).lean();
    if (!loc) return null;
    return {
      trackId:         loc.trackId,
      lat:             loc.lat                         || 0,
      lng:             loc.lng                         || 0,
      speed:           loc.speed                       || 0,
      accuracy:        loc.accuracy                    || 0,
      heading:         loc.heading                     || 0,
      altitude:        loc.altitude                    || 0,
      altAccuracy:     loc.altAccuracy                 || 0,
      speedAccuracy:   loc.speedAccuracy               || 0,
      headingAccuracy: loc.headingAccuracy             || 0,
      provider:        loc.provider                    || 'gps',
      encryptedCoords: loc.encryptedCoords             || '',
      snapped:         loc.snapped                     || false,
      roadName:        loc.roadName                    || '',
      timestamp:       new Date(loc.timestamp).getTime() || 0,
      isActive:        loc.isActive                    || false
    };
  } catch { return null; }
}

app.post('/api/location/update', authenticateToken, async (req, res) => {
  try {
    const { trackId, lat, lng, speed, accuracy, heading, altitude,
            altAccuracy, speedAccuracy, headingAccuracy, provider, encryptedCoords } = req.body;

    if (!trackId) return res.status(400).json({ error: 'Missing trackId' });
    if (trackId !== req.user.trackId) return res.status(403).json({ error: 'Access denied' });

    const hasEncrypted = !!(encryptedCoords && encryptedCoords.length > 0);
    if (!hasEncrypted) {
      if (lat === undefined || lng === undefined)
        return res.status(400).json({ error: 'Missing lat/lng or encryptedCoords' });
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180)
        return res.status(400).json({ error: 'Invalid coordinates' });
    }

    await writeLocation(trackId, {
      lat: lat || 0, lng: lng || 0, speed: speed || 0,
      accuracy: accuracy || 0, heading: heading || 0,
      altitude: altitude || 0, altAccuracy: altAccuracy || 0,
      speedAccuracy: speedAccuracy || 0, headingAccuracy: headingAccuracy || 0,
      provider: provider || 'gps',
      encryptedCoords: encryptedCoords || '',
      hasEncrypted,
      timestamp: new Date()
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error in location update:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/location/:trackId - Test endpoint for GPS simulation (no auth required)
app.post('/api/location/:trackId', async (req, res) => {
  try {
    const { trackId } = req.params;
    const { lat, lng, speed, accuracy, heading, altitude, timestamp } = req.body;

    if (!trackId) return res.status(400).json({ error: 'Track ID required' });
    if (lat === undefined || lng === undefined) return res.status(400).json({ error: 'lat and lng required' });

    // Update or create location
    await Location.findOneAndUpdate(
      { trackId },
      {
        lat: lat || 0,
        lng: lng || 0,
        speed: speed || 0,
        accuracy: accuracy || 0,
        heading: heading || 0,
        altitude: altitude || 0,
        timestamp: timestamp ? new Date(timestamp) : new Date(),
        isActive: true
      },
      { upsert: true, new: true }
    );

    // Add to path history
    await PathHistory.findOneAndUpdate(
      { trackId },
      {
        $push: {
          points: {
            $each: [{
              lat: lat || 0,
              lng: lng || 0,
              timestamp: timestamp ? new Date(timestamp) : new Date(),
              speed: speed || 0,
              heading: heading || 0
            }],
            $slice: -MAX_PATH_PTS
          }
        },
        lastUpdated: new Date()
      },
      { upsert: true }
    );

    // Emit via Socket.IO for real-time updates
    io.emit(`location:${trackId}`, {
      trackId,
      lat: lat || 0,
      lng: lng || 0,
      speed: speed || 0,
      accuracy: accuracy || 0,
      heading: heading || 0,
      timestamp: new Date()
    });

    console.log(`📍 [TEST] Location updated for ${trackId}: ${lat.toFixed(6)}, ${lng.toFixed(6)}`);
    res.json({ success: true, trackId, lat, lng });
  } catch (error) {
    console.error('Error in test location update:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/location/:trackId', async (req, res) => {
  try {
    const { trackId }     = req.params;
    const { requesterId } = req.query;
    if (!trackId) return res.status(400).json({ error: 'Track ID required' });

    async function checkPrivacy(ownerTrackId) {
      if (!requesterId || requesterId === ownerTrackId) return null;
      const owner = await User.findOne(
        { trackId: ownerTrackId },
        'privacyMode approvedIds friends blockedUsers'
      ).lean();
      if (!owner) return null;
      if ((owner.blockedUsers || []).includes(requesterId))
        return { error: 'blocked' };
      if (owner.privacyMode === 'CONTACTS_ONLY' &&
          !(owner.friends || []).includes(requesterId))
        return { error: 'privacy' };
      if (owner.privacyMode === 'SELECTED' &&
          !(owner.approvedIds || []).includes(requesterId))
        return { error: 'privacy' };
      return null;
    }

    const IS_RECENT_MS = 10_000;
    const nowMs = Date.now();

    // 1. Read from MongoDB (direct query)
    let location = await readLocation(trackId);

    if (!location) {
      // 2. Direct MongoDB query as fallback
      const dbLoc = await Location.findOne({ trackId }).lean();
      if (!dbLoc) return res.json({ trackId, isRecent: false, notFound: true });
      location = {
        trackId:         dbLoc.trackId,
        lat:             dbLoc.lat,
        lng:             dbLoc.lng,
        speed:           dbLoc.speed || 0,
        accuracy:        dbLoc.accuracy || 0,
        heading:         dbLoc.heading || 0,
        altitude:        dbLoc.altitude || 0,
        snapped:         dbLoc.snapped || false,
        roadName:        dbLoc.roadName || '',
        timestamp:       new Date(dbLoc.timestamp).getTime(),
        isActive:        dbLoc.isActive,
        encryptedCoords: dbLoc.encryptedCoords || ''
      };
    }

    const privacyErr = await checkPrivacy(trackId);
    if (privacyErr) return res.status(403).json(privacyErr);

    const isRecent = (nowMs - location.timestamp) < IS_RECENT_MS;
    let outLat = location.lat, outLng = location.lng, extrapolated = false;

    if (!location.encryptedCoords && isRecent && location.speed > 0.3) {
      const dr = deadReckon({ ...location, timestamp: new Date(location.timestamp) }, nowMs);
      outLat = dr.lat; outLng = dr.lng; extrapolated = dr.extrapolated;
    }

    res.json({ ...location, lat: outLat, lng: outLng, isRecent, extrapolated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/locations/bulk?ids=TRK-A,TRK-B&requesterId=TRK-C — bulk fetch for all tracked friends
app.get('/api/locations/bulk', async (req, res) => {
  try {
    const { ids, requesterId } = req.query;
    if (!ids) return res.status(400).json({ error: 'ids required' });

    const trackIds = ids.split(',').map(s => s.trim()).filter(Boolean).slice(0, 8);
    const nowMs    = Date.now();
    const IS_RECENT_MS = 10_000;

    // Batch read from MongoDB with Promise.all
    const locationResults = await Promise.all(trackIds.map(id => readLocation(id)));

    // For any read failure, fall back to direct Mongo query
    const missingIds = trackIds.filter((id, i) => !locationResults[i]);
    const dbLocs = missingIds.length > 0
      ? await Location.find({ trackId: { $in: missingIds } }).lean()
      : [];

    const dbMap = new Map(dbLocs.map(l => [l.trackId, l]));

    const locations = trackIds.map((id, i) => {
      if (locationResults[i]) return locationResults[i];
      const db = dbMap.get(id);
      if (!db) return null;
      return {
        trackId: db.trackId, lat: db.lat, lng: db.lng,
        speed: db.speed || 0, accuracy: db.accuracy || 0,
        heading: db.heading || 0, altitude: db.altitude || 0,
        snapped: db.snapped || false, roadName: db.roadName || '',
        timestamp: new Date(db.timestamp).getTime(),
        encryptedCoords: db.encryptedCoords || ''
      };
    });

    const formatted = await Promise.all(locations.map(async (loc, i) => {
      const trackId = trackIds[i];
      if (!loc) return { trackId, notFound: true };

      if (requesterId && requesterId !== trackId) {
        const owner = await User.findOne({ trackId }, 'privacyMode approvedIds friends blockedUsers').lean();
        if (owner) {
          if ((owner.blockedUsers || []).includes(requesterId)) return { trackId, blocked: true };
          if (owner.privacyMode === 'CONTACTS_ONLY' && !(owner.friends || []).includes(requesterId)) return { trackId, privacy: true };
          if (owner.privacyMode === 'SELECTED'       && !(owner.approvedIds || []).includes(requesterId)) return { trackId, privacy: true };
        }
      }

      const isRecent = (nowMs - loc.timestamp) < IS_RECENT_MS;
      let outLat = loc.lat, outLng = loc.lng, extrapolated = false;
      if (!loc.encryptedCoords && isRecent && loc.speed > 0.3) {
        const dr = deadReckon({ ...loc, timestamp: new Date(loc.timestamp) }, nowMs);
        outLat = dr.lat; outLng = dr.lng; extrapolated = dr.extrapolated;
      }
      return { ...loc, lat: outLat, lng: outLng, isRecent, extrapolated };
    }));

    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/location/batch — Android sends array of points, server processes as one batch
app.post('/api/location/batch', authenticateToken, async (req, res) => {
  try {
    const { trackId, points } = req.body;
    if (!trackId || !Array.isArray(points) || points.length === 0)
      return res.status(400).json({ error: 'trackId and points[] required' });
    if (trackId !== req.user.trackId) return res.status(403).json({ error: 'Access denied' });
    if (points.length > 20) return res.status(400).json({ error: 'Max 20 points per batch' });

    // Write best point (lowest accuracy) to MongoDB for live location
    const best = points.reduce((a, b) => (b.accuracy || 999) < (a.accuracy || 999) ? b : a);
    const hasEncrypted = !!(best.encryptedCoords && best.encryptedCoords.length > 0);

    await writeLocation(trackId, { ...best, hasEncrypted });

    // Push ALL non-encrypted points to MongoDB PathHistory
    const nonEncrypted = points.filter(p => !p.encryptedCoords || p.encryptedCoords.length === 0);
    if (nonEncrypted.length > 0) {
      PathHistory.findOneAndUpdate(
        { trackId },
        {
          $push: {
            points: {
              $each: nonEncrypted.map(p => ({
                lat: p.lat || 0, lng: p.lng || 0,
                speed: p.speed || 0, heading: p.heading || 0,
                timestamp: p.timestamp || Date.now()
              })),
              $slice: -MAX_PATH_PTS
            }
          },
          $set: { lastUpdated: new Date() }
        },
        { upsert: true }
      ).catch(() => {});
    }

    res.json({ success: true, processed: points.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cache/stats', async (req, res) => {
  try {
    // MongoDB stats instead of Redis
    const stats = await mongoose.connection.db.stats();
    res.json({ mongodb: stats, timestamp: new Date() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug/location-source/:trackId', async (req, res) => {
  try {
    const { trackId } = req.params;
    const loc = await readLocation(trackId);
    const mongoLoc = await Location.findOne({ trackId }).lean();
    const kalmanState = await getKalmanState(trackId);

    if (!mongoLoc) return res.status(404).json({ error: 'Location not found' });

    res.json({
      trackId,
      memory: loc ? {
        ageMs: Date.now() - loc.timestamp,
        lat: loc.lat, lng: loc.lng,
        speed: loc.speed, accuracy: loc.accuracy,
        snapped: loc.snapped
      } : null,
      mongodb: mongoLoc ? {
        ageMs: Date.now() - new Date(mongoLoc.timestamp).getTime(),
        lat: mongoLoc.lat, lng: mongoLoc.lng,
        speed: mongoLoc.speed, accuracy: mongoLoc.accuracy,
        snapped: mongoLoc.snapped
      } : null,
      kalman: kalmanState ? {
        latEst: kalmanState.latEst,
        lngEst: kalmanState.lngEst,
        latVar: kalmanState.latVar,
        lngVar: kalmanState.lngVar,
        lastMs: kalmanState.lastMs,
        lastHeading: kalmanState.lastHeading
      } : null,
      source: 'mongodb'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function bearing(from, to) {
  const dLng  = (to.lng - from.lng) * Math.PI / 180;
  const lat1  = from.lat * Math.PI / 180;
  const lat2  = to.lat  * Math.PI / 180;
  const y     = Math.sin(dLng) * Math.cos(lat2);
  const x     = Math.cos(lat1) * Math.sin(lat2) -
                Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

function haversineM(lat1, lng1, lat2, lng2) {
  const R    = 6_371_000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a    = Math.sin(dLat/2)**2 +
               Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) *
               Math.sin(dLng/2)**2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

app.get('/api/path/:trackId', async (req, res) => {
  try {
    const { trackId } = req.params;
    const { hours = 2 } = req.query;

    // Read from MongoDB PathHistory
    const pathHistory = await PathHistory.findOne({ trackId });
    if (!pathHistory) return res.json({ points: [] });
    const timeAgo      = new Date(Date.now() - parseInt(hours) * 60 * 60 * 1000);
    const recentPoints = pathHistory.points.filter(p => new Date(p.timestamp) > timeAgo);
    res.json({ points: recentPoints });
  } catch (error) {
    console.error('Error fetching path history:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/path/:trackId/smoothed — returns Kalman-smoothed path with inferred headings
app.get('/api/path/:trackId/smoothed', async (req, res) => {
  try {
    const { trackId } = req.params;
    const { hours = 1 } = req.query;

    const pathHistory = await PathHistory.findOne({ trackId });
    if (!pathHistory || pathHistory.points.length < 2)
      return res.json({ points: [] });

    const timeAgo = new Date(Date.now() - parseInt(hours) * 3_600_000);
    const raw     = pathHistory.points.filter(p => p.timestamp > timeAgo);
    if (raw.length < 2) return res.json({ points: raw });

    // Infer heading between consecutive points
    const smoothed = raw.map((pt, i) => {
      if (i === 0) return { ...pt, heading: raw[1] ? bearing(pt, raw[1]) : 0 };
      const prev    = raw[i - 1];
      const head    = bearing(prev, pt);
      const distM   = haversineM(prev.lat, prev.lng, pt.lat, pt.lng);
      const dtSec   = (new Date(pt.timestamp) - new Date(prev.timestamp)) / 1000;
      const speedMs = dtSec > 0 ? distM / dtSec : 0;
      return { lat: pt.lat, lng: pt.lng, timestamp: pt.timestamp, heading: head, speed: speedMs };
    });

    res.json({ points: smoothed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/location/deactivate/:trackId', async (req, res) => {
  try {
    const { trackId } = req.params;
    const result = await Location.findOneAndUpdate({ trackId }, { isActive: false }, { new: true });
    if (!result) return res.status(404).json({ error: 'Track ID not found' });
    // locationEngine.cleanup(trackId); // DISABLED - LocationEngine no longer used
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

// ==================== USER BLOCKING ROUTES ====================

// POST /api/users/block
app.post('/api/users/block', async (req, res) => {
  try {
    const { myTrackId, targetTrackId } = req.body;
    if (!myTrackId || !targetTrackId) 
      return res.status(400).json({ error: 'myTrackId and targetTrackId are required' });

    // Add targetTrackId to blocker's blocked list
    await User.findOneAndUpdate(
      { trackId: myTrackId },
      { $addToSet: { blockedUsers: targetTrackId } }
    );
    // Add myTrackId to target's blockedBy list (reverse lookup)
    await User.findOneAndUpdate(
      { trackId: targetTrackId },
      { $addToSet: { blockedBy: myTrackId } }
    );

    // Notify target via socket so their app reacts instantly
    io.to(`user:${targetTrackId}`).emit('user:blocked', { blockedBy: myTrackId });

    console.log(`🚫 ${myTrackId} blocked ${targetTrackId}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Error blocking user:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/users/unblock
app.post('/api/users/unblock', async (req, res) => {
  try {
    const { myTrackId, targetTrackId } = req.body;
    if (!myTrackId || !targetTrackId)
      return res.status(400).json({ error: 'myTrackId and targetTrackId are required' });

    await User.findOneAndUpdate(
      { trackId: myTrackId },
      { $pull: { blockedUsers: targetTrackId } }
    );
    await User.findOneAndUpdate(
      { trackId: targetTrackId },
      { $pull: { blockedBy: myTrackId } }
    );

    io.to(`user:${targetTrackId}`).emit('user:unblocked', { unblockedBy: myTrackId });

    console.log(`✅ ${myTrackId} unblocked ${targetTrackId}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Error unblocking user:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/users/blocked/:trackId — returns full display info for each blocked user
app.get('/api/users/blocked/:trackId', async (req, res) => {
  try {
    const { trackId } = req.params;
    const user = await User.findOne({ trackId });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const blockedTrackIds = user.blockedUsers || [];
    if (blockedTrackIds.length === 0) return res.json({ blockedUsers: [] });

    // Fetch display info for each blocked user
    const blockedUsers = await User.find(
      { trackId: { $in: blockedTrackIds } },
      'trackId displayName email avatarBase64'
    ).lean();

    res.json({
      blockedUsers: blockedUsers.map(u => ({
        trackId:      u.trackId,
        displayName:  u.displayName || u.trackId,
        email:        u.email       || '',
        avatarBase64: u.avatarBase64 || ''
      }))
    });
  } catch (err) {
    console.error('Error fetching blocked users:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── 3. NEW: Privacy settings routes ──────────────────────────────────────────

// GET /api/users/privacy/:trackId
app.get('/api/users/privacy/:trackId', async (req, res) => {
  try {
    const { trackId } = req.params;
    const user = await User.findOne({ trackId }, 'privacyMode approvedIds').lean();
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      privacyMode: user.privacyMode || 'EVERYONE',
      approvedIds: user.approvedIds || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/users/privacy
app.post('/api/users/privacy', async (req, res) => {
  try {
    const { myTrackId, privacyMode, approvedIds } = req.body;
    if (!myTrackId) return res.status(400).json({ error: 'myTrackId required' });

    const validModes = ['EVERYONE', 'CONTACTS_ONLY', 'SELECTED'];
    const mode = validModes.includes(privacyMode) ? privacyMode : 'EVERYONE';

    await User.findOneAndUpdate(
      { trackId: myTrackId },
      {
        privacyMode: mode,
        approvedIds: Array.isArray(approvedIds) ? approvedIds : [],
        updatedAt: new Date()
      }
    );
    console.log(`🔒 Privacy updated for ${myTrackId}: ${mode}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== CHAT ROUTES ====================

// POST /api/chat/send
// Accepts both text messages and image messages.
// For images: { type: "image", text: "__image__", imageBase64: "<base64 string>" }
app.post('/api/chat/send', async (req, res) => {
  try {
    const { conversationId, senderId, senderName, receiverId, receiverName, text, type, imageBase64 } = req.body;

    console.log(`📨 Received message: conversationId=${conversationId}, senderId=${senderId}, receiverId=${receiverId}, type=${type}`);

    if (!conversationId || !senderId || !receiverId) {
      console.error('❌ Missing required fields');
      return res.status(400).json({ error: 'Missing required fields: conversationId, senderId, receiverId' });
    }

    // Check if either user has blocked the other
    const [senderUser, receiverUser] = await Promise.all([
      User.findOne({ trackId: senderId }, 'blockedUsers blockedBy').lean(),
      User.findOne({ trackId: receiverId }, 'blockedUsers blockedBy').lean()
    ]);
    const senderBlocked   = senderUser?.blockedUsers?.includes(receiverId) || false;
    const receiverBlocked = receiverUser?.blockedUsers?.includes(senderId)  || false;

    console.log(`🔍 Block check: senderBlocked=${senderBlocked}, receiverBlocked=${receiverBlocked}`);

    if (senderBlocked || receiverBlocked) {
      console.log('🚫 Message blocked due to user blocking');
      return res.status(403).json({ error: 'Message blocked', blocked: true });
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
    
    let imageUrl = '', imagePublicId = '';
    if (msgType === 'image') {
      // Upload to Cloudinary (client sends unencrypted base64 for images)
      const uploaded = await uploadToCloudinary(imageBase64, `chat/${conversationId}`);
      imageUrl = uploaded.url;
      imagePublicId = uploaded.publicId;
    }

    const savedMessage = await Message.create({
      conversationId,
      senderId,
      senderName,
      text:        displayText,
      timestamp:   ts,
      readBy:      [senderId],
      type:        msgType,
      imageUrl,
      imagePublicId
    });

    console.log(`💾 Message saved to DB: _id=${savedMessage._id}, conversationId=${conversationId}`);

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
      imageUrl:       imageUrl,
      imageBase64:    ''
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

// POST /api/chat/send-batch
// Sends multiple images as one encrypted batch for better performance
app.post('/api/chat/send-batch', async (req, res) => {
  try {
    const { conversationId, senderId, senderName, receiverId, receiverName, images } = req.body;

    if (!conversationId || !senderId || !receiverId || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: 'Missing required fields or images array' });
    }

    if (images.length > 10) {
      return res.status(400).json({ error: 'Max 10 images per batch' });
    }

    const [senderUser, receiverUser] = await Promise.all([
      User.findOne({ trackId: senderId }, 'blockedUsers').lean(),
      User.findOne({ trackId: receiverId }, 'blockedUsers').lean()
    ]);
    if (senderUser?.blockedUsers?.includes(receiverId) || receiverUser?.blockedUsers?.includes(senderId)) {
      return res.status(403).json({ error: 'Message blocked', blocked: true });
    }

    // Upload all images to Cloudinary in parallel
    const uploadedImages = await Promise.all(
      images.map(async (img, idx) => {
        const decoded = img.encryptedBase64; // Client sends unencrypted base64
        const uploaded = await uploadToCloudinary(decoded, `chat/${conversationId}`);
        return {
          imageUrl: uploaded.url,
          imagePublicId: uploaded.publicId,
          timestamp: Date.now() + idx
        };
      })
    );

    const batchId = `batch-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const ts = Date.now();

    await ImageBatch.create({
      batchId,
      conversationId,
      senderId,
      senderName,
      images: uploadedImages,
      timestamp: ts
    });

    const savedMessage = await Message.create({
      conversationId,
      senderId,
      senderName,
      text: `__batch:${batchId}__`,
      timestamp: ts,
      readBy: [senderId],
      type: 'image',
      imageUrl: '',
      imagePublicId: ''
    });

    await Conversation.findOneAndUpdate(
      { conversationId },
      {
        $set: {
          conversationId,
          lastMessage: `${images.length} photos`,
          lastTimestamp: ts,
          [`names.${senderId}`]: senderName,
          [`names.${receiverId}`]: receiverName,
        },
        $addToSet: { participants: { $each: [senderId, receiverId] } },
        $inc: { [`unread.${receiverId}`]: 1 },
      },
      { upsert: true, new: true }
    );

    const payload = {
      _id: savedMessage._id.toString(),
      conversationId,
      senderId,
      senderName,
      text: `__batch:${batchId}__`,
      timestamp: ts,
      readBy: [senderId],
      type: 'image',
      imageUrl: '',
      imageBase64: ''
    };

    io.to(`conversation:${conversationId}`).emit('chat:message', payload);
    io.to(`user:${receiverId}`).emit('chat:newMessage', payload);
    io.to(`user:${senderId}`).emit('chat:message', payload);

    console.log(`📦 Batch uploaded to Cloudinary: ${batchId}`);
    res.json({ ok: true, messageId: savedMessage._id.toString(), batchId });

  } catch (error) {
    console.error('Error sending batch:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/chat/batch/:batchId
// Retrieves a batch of images from Cloudinary
app.get('/api/chat/batch/:batchId', async (req, res) => {
  try {
    const { batchId } = req.params;
    const batch = await ImageBatch.findOne({ batchId }).lean();
    if (!batch) return res.status(404).json({ error: 'Batch not found' });

    res.json({
      batchId:        batch.batchId,
      conversationId: batch.conversationId,
      senderId:       batch.senderId,
      images:         batch.images.map(img => ({
        imageUrl:  img.imageUrl,
        timestamp: img.timestamp
      }))
    });
    // Don't delete — Cloudinary handles storage
  } catch (error) {
    console.error('Error fetching batch:', error);
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
    console.log(`📥 Fetching messages for conversation: ${conversationId}`);
    const { since } = req.query;  // optional: only return messages newer than this timestamp
    const query = { conversationId };
    if (since) {
      const sinceTs = parseInt(since, 10);
      if (!isNaN(sinceTs)) query.timestamp = { $gt: sinceTs };
    }
    const msgs = await Message.find(query).sort({ timestamp: 1 }).limit(500);
    console.log(`📊 Found ${msgs.length} messages in database for ${conversationId}`);
    res.json(msgs.map(m => ({
      _id:            m._id.toString(),
      conversationId: m.conversationId,
      senderId:       m.senderId,
      senderName:     m.senderName,
      text:           m.text,
      timestamp:      m.timestamp,
      readBy:         m.readBy || [],
      type:           m.type || 'text',
      imageUrl:       m.imageUrl || '',
      imageBase64:    ''
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

    // Emit Socket.IO event FIRST (instant double tick)
    io.to(`conversation:${conversationId}`).emit('chat:read', { conversationId, readBy: trackId });
    io.to(`user:${trackId}`).emit('chat:read', { conversationId, readBy: trackId });

    // MongoDB writes happen in background (non-blocking)
    setImmediate(async () => {
      try {
        await Conversation.findOneAndUpdate({ conversationId }, { $set: { [`unread.${trackId}`]: 0 } });
        await Message.updateMany({ conversationId, readBy: { $ne: trackId } }, { $addToSet: { readBy: trackId } });
      } catch (err) {
        console.error('Background read update error:', err);
      }
    });

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
    const { conversationId, text, imagePublicId } = message;

    // Delete from MongoDB FIRST (fast)
    await Message.deleteOne({ _id: messageId });

    // Update conversation (fast)
    const latestMsg = await Message.findOne({ conversationId }).sort({ timestamp: -1 });
    await Conversation.findOneAndUpdate(
      { conversationId },
      { lastMessage: latestMsg ? latestMsg.text : '', lastTimestamp: latestMsg ? latestMsg.timestamp : 0 }
    );

    // Emit Socket.IO event (instant)
    io.to(`conversation:${conversationId}`).emit('chat:messageDeleted', { messageId, conversationId });

    // Cloudinary deletions happen in background (slow, non-blocking)
    setImmediate(async () => {
      try {
        if (imagePublicId) await deleteFromCloudinary(imagePublicId);

        if (text?.startsWith('__batch:')) {
          const batchId = text.replace('__batch:', '').replace('__', '');
          const batch = await ImageBatch.findOne({ batchId }).lean();
          if (batch) {
            await Promise.all(
              batch.images.map(img => deleteFromCloudinary(img.imagePublicId))
            );
            await ImageBatch.deleteOne({ batchId });
          }
        }
        console.log(`🗑 Cloudinary cleanup complete for: ${messageId}`);
      } catch (err) {
        console.error('Cloudinary cleanup error:', err);
      }
    });

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
    console.log(`🗑️ DELETE request received for conversation: ${conversationId}`);

    // Delete all Cloudinary images in this conversation
    const messages = await Message.find({ conversationId }).lean();
    console.log(`📊 Found ${messages.length} messages to delete in ${conversationId}`);
    await Promise.all(
      messages
        .filter(m => m.imagePublicId)
        .map(m => deleteFromCloudinary(m.imagePublicId))
    );

    // Delete all batch images from Cloudinary
    const batches = await ImageBatch.find({ conversationId }).lean();
    await Promise.all(
      batches.flatMap(b => b.images.map(img => deleteFromCloudinary(img.imagePublicId)))
    );
    await ImageBatch.deleteMany({ conversationId });
    
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
  socket.on('track:subscribe', (trackId) => {
    socket.join(`track:${trackId}`);
    if (!socket.subscribedTracks) socket.subscribedTracks = new Set();
    socket.subscribedTracks.add(trackId);
    socket.emit('track:subscribed', { trackId, success: true });
  });
  socket.on('track:unsubscribe', (trackId) => { socket.leave(`track:${trackId}`); });
  socket.on('user:join', (trackId) => { socket.join(`user:${trackId}`); socket.emit('user:joined', { trackId, success: true }); console.log(`👤 ${trackId} joined personal room`); });
  socket.on('watch:friend', ({ myTrackId, friendTrackId }) => {
    addWatcher(friendTrackId, myTrackId);
    socket.join(`user:${myTrackId}`);
    console.log(`👁 ${myTrackId} watching ${friendTrackId}`);
  });
  socket.on('unwatch:friend', ({ myTrackId, friendTrackId }) => {
    removeWatcher(friendTrackId, myTrackId);
  });
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
      io.to(`track:${trackId}`).emit('location:updated', updateData);  // room-based only
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
    const cutoff = new Date(Date.now() - 24 * 3_600_000);
    // Kalman state is now in-memory (loses state on server restart)
    const [dl, dp] = await Promise.all([
      Location.deleteMany({ timestamp: { $lt: cutoff } }),
      PathHistory.deleteMany({ lastUpdated: { $lt: cutoff } })
    ]);
    if (dl.deletedCount > 0 || dp.deletedCount > 0)
      console.log(`🧹 Cleanup: ${dl.deletedCount} locations, ${dp.deletedCount} paths`);
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}, 60 * 60 * 1000);

// ==================== KEEP-ALIVE (Render cold start prevention) ====================

// Ping self every 4 minutes to prevent Render free tier from spinning down
// Render sleeps after 15 min of inactivity; ping every 4min is safe margi
setInterval(() => {
  const http = require('http');
  http.get(`http://localhost:${PORT}/api/warmup`, () => {}).on('error', () => {});
}, 4 * 60 * 1000);

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
