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

// ─── Caches ───────────────────────────────────────────────────────────────────
const locationCache  = new NodeCache({ stdTTL: 4,    checkperiod: 1  });
const mapMatchCache  = new NodeCache({ stdTTL: 30,   checkperiod: 10 });
const roadSnapCache  = new NodeCache({ stdTTL: 300,  checkperiod: 60 });
const batchQueue     = new Map();
const batchTimers    = new Map();
const BATCH_FLUSH_MS = 800;

const MAPBOX_DIRECTIONS_TOKEN = process.env.MAPBOX_TOKEN;

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
  email: { type: String, default: '' },
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
  return true;
}

// ─── Batching ─────────────────────────────────────────────────────────────────

function enqueueLocationUpdate(trackId, pointData) {
  if (!batchQueue.has(trackId)) {
    batchQueue.set(trackId, []);
  }

  const queue = batchQueue.get(trackId);
  queue.push(pointData);

  if (queue.length >= 5) {
    clearTimeout(batchTimers.get(trackId));
    batchTimers.delete(trackId);
    flushBatch(trackId);
    return;
  }

  if (!batchTimers.has(trackId)) {
    const timer = setTimeout(() => {
      flushBatch(trackId);
    }, BATCH_FLUSH_MS);
    batchTimers.set(trackId, timer);
  }
}

async function flushBatch(trackId) {
  batchTimers.delete(trackId);
  const points = batchQueue.get(trackId) || [];
  batchQueue.set(trackId, []);

  if (points.length === 0) return;

  try {
    const best = points.reduce((prev, curr) => {
      const prevScore = prev.accuracy || 999;
      const currScore = curr.accuracy || 999;
      return currScore < prevScore ? curr : prev;
    });

    const now = new Date();

    let snappedLat = best.lat;
    let snappedLng = best.lng;
    let roadName   = '';
    let snapped    = false;

    if (!best.hasEncrypted && shouldSnapToRoad(best.accuracy, best.speed)) {
      if (points.length >= 3) {
        const traced = await snapTraceToRoad(
          points.map(p => ({
            lat:       p.lat,
            lng:       p.lng,
            timestamp: p.timestamp || now
          }))
        );
        const lastSnapped = traced[traced.length - 1];
        if (lastSnapped?.snapped) {
          snappedLat = lastSnapped.lat;
          snappedLng = lastSnapped.lng;
          roadName   = lastSnapped.roadName || '';
          snapped    = true;
        }
      } else {
        const snapResult = await snapToRoad(best.lat, best.lng, best.heading || 0);
        if (snapResult.snapped && snapResult.confidence > 0.6) {
          snappedLat = snapResult.lat;
          snappedLng = snapResult.lng;
          roadName   = snapResult.roadName || '';
          snapped    = true;
        }
      }
    }

    const updateFields = {
      lat:             best.hasEncrypted ? 0 : snappedLat,
      lng:             best.hasEncrypted ? 0 : snappedLng,
      speed:           best.speed           || 0,
      accuracy:        best.accuracy        || 0,
      heading:         best.heading         || 0,
      altitude:        best.altitude        || 0,
      altAccuracy:     best.altAccuracy     || 0,
      speedAccuracy:   best.speedAccuracy   || 0,
      headingAccuracy: best.headingAccuracy || 0,
      provider:        best.provider        || 'gps',
      timestamp:       now,
      isActive:        true,
      encryptedCoords: best.encryptedCoords || '',
      snapped,
      roadName
    };

    await Location.findOneAndUpdate(
      { trackId },
      updateFields,
      { upsert: true, new: true }
    );

    const pathPoints = points.map(p => ({
      lat:       p.hasEncrypted ? 0 : p.lat,
      lng:       p.hasEncrypted ? 0 : p.lng,
      timestamp: p.timestamp || now,
      speed:     p.speed     || 0,
      heading:   p.heading   || 0
    }));

    PathHistory.findOneAndUpdate(
      { trackId },
      {
        $push: {
          points: {
            $each:  pathPoints,
            $slice: -2000
          }
        },
        lastUpdated: now
      },
      { upsert: true }
    ).catch(() => {});

    locationCache.set(`loc:${trackId}`, {
      ...updateFields,
      trackId,
      isRecent: true,
      snapped,
      roadName
    });

    const updateData = {
      trackId,
      speed:           best.speed    || 0,
      accuracy:        best.accuracy || 0,
      heading:         best.heading  || 0,
      altitude:        best.altitude || 0,
      timestamp:       now,
      isRecent:        true,
      snapped,
      roadName,
      encryptedCoords: best.encryptedCoords || ''
    };
    io.to(`track:${trackId}`).emit('location:updated', updateData);

  } catch (err) {
    console.error(`Batch flush error for ${trackId}:`, err.message);
  }
}

// ==================== LOCATION ROUTES ====================

// ─── Dead Reckoning Predictor ─────────────────────────────────────────────────
// Extrapolate position forward using last known speed + heading
function deadReckon(location, nowMs) {
  const lastMs = new Date(location.timestamp).getTime();
  const dtSec  = (nowMs - lastMs) / 1000;

  // Only extrapolate up to 3 seconds — beyond that, data is too stale
  if (dtSec <= 0 || dtSec > 3 || !location.speed || location.speed < 0.5) {
    return { lat: location.lat, lng: location.lng, extrapolated: false };
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

const IS_RECENT_MS = 2_000;

// ─── Server-side Kalman state store (in-memory, resets on restart) ────────────
const kalmanStore = new Map(); // trackId → { latEst, lngEst, latVar, lngVar, lastMs }

function serverKalman(trackId, lat, lng, accuracyM, nowMs, speedMs = 0) {
  const Q_BASE = speedMs < 0.3 ? 0.3 : speedMs < 2 ? 1.0 : speedMs < 8 ? 3.0 : 6.0;
  let state = kalmanStore.get(trackId);

  if (!state) {
    state = {
      latEst: lat, lngEst: lng,
      latVar: accuracyM * accuracyM,
      lngVar: accuracyM * accuracyM,
      lastMs: nowMs
    };
    kalmanStore.set(trackId, state);
    return { lat, lng };
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
  kalmanStore.set(trackId, state);
  return { lat: state.latEst, lng: state.lngEst };
}

app.post('/api/location/update', async (req, res) => {
  try {
    const {
      trackId, lat, lng, speed, accuracy,
      heading, altitude, altAccuracy,
      speedAccuracy, headingAccuracy, provider,
      encryptedCoords
    } = req.body;

    if (!trackId) return res.status(400).json({ error: 'Missing trackId' });

    const hasEncrypted = !!(encryptedCoords && encryptedCoords.length > 0);

    if (!hasEncrypted) {
      if (lat === undefined || lng === undefined)
        return res.status(400).json({ error: 'Missing lat/lng or encryptedCoords' });
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180)
        return res.status(400).json({ error: 'Invalid coordinates' });
    }

    let processedLat = lat || 0;
    let processedLng = lng || 0;

    if (!hasEncrypted) {
      const nowMs   = Date.now();
      const accM    = Math.max(accuracy || 20, 1);
      const smoothed = serverKalman(trackId, lat, lng, accM, nowMs, speed || 0);
      processedLat  = smoothed.lat;
      processedLng  = smoothed.lng;
    }

    enqueueLocationUpdate(trackId, {
      lat:             processedLat,
      lng:             processedLng,
      speed:           speed           || 0,
      accuracy:        accuracy        || 0,
      heading:         heading         || 0,
      altitude:        altitude        || 0,
      altAccuracy:     altAccuracy     || 0,
      speedAccuracy:   speedAccuracy   || 0,
      headingAccuracy: headingAccuracy || 0,
      provider:        provider        || 'gps',
      encryptedCoords: encryptedCoords || '',
      hasEncrypted,
      timestamp:       new Date()
    });

    res.json({ success: true, queued: true });

  } catch (error) {
    console.error('Error queuing location update:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/location/:trackId', async (req, res) => {
  try {
    const { trackId }     = req.params;
    const { requesterId } = req.query;
    if (!trackId) return res.status(400).json({ error: 'Track ID required' });

    const cacheKey    = `loc:${trackId}`;
    const cachedLoc   = locationCache.get(cacheKey);

    async function checkPrivacy(ownerTrackId) {
      if (!requesterId || requesterId === ownerTrackId) return null;
      const owner = await User.findOne(
        { trackId: ownerTrackId },
        'privacyMode approvedIds friends blockedUsers'
      ).lean();
      if (!owner) return null;
      if ((owner.blockedUsers || []).includes(requesterId))
        return { error: 'blocked', notFound: true };
      if (owner.privacyMode === 'CONTACTS_ONLY' &&
          !(owner.friends || []).includes(requesterId))
        return { error: 'privacy', notFound: true };
      if (owner.privacyMode === 'SELECTED' &&
          !(owner.approvedIds || []).includes(requesterId))
        return { error: 'privacy', notFound: true };
      return null;
    }

    if (cachedLoc) {
      const privacyErr = await checkPrivacy(trackId);
      if (privacyErr) return res.status(403).json(privacyErr);

      const nowMs    = Date.now();
      const isRecent = cachedLoc.timestamp > new Date(nowMs - 2_000);

      let outLat = cachedLoc.lat, outLng = cachedLoc.lng, extrapolated = false;
      if (!cachedLoc.encryptedCoords && isRecent && (cachedLoc.speed || 0) > 0.3) {
        const dr = deadReckon(cachedLoc, nowMs);
        outLat       = dr.lat;
        outLng       = dr.lng;
        extrapolated = dr.extrapolated;
      }

      return res.json({
        ...cachedLoc,
        lat:         outLat,
        lng:         outLng,
        isRecent,
        extrapolated,
        fromCache:   true
      });
    }

    const location = await Location.findOne({ trackId });
    if (!location) return res.json({ trackId, isRecent: false, notFound: true });

    const privacyErr = await checkPrivacy(trackId);
    if (privacyErr) return res.status(403).json(privacyErr);

    const nowMs    = Date.now();
    const isRecent = location.timestamp > new Date(nowMs - 2_000);

    let outLat = location.lat, outLng = location.lng, extrapolated = false;
    if (!location.encryptedCoords && isRecent && location.speed > 0.3) {
      const dr = deadReckon(location, nowMs);
      outLat       = dr.lat;
      outLng       = dr.lng;
      extrapolated = dr.extrapolated;
    }

    const response = {
      trackId:         location.trackId,
      lat:             outLat,
      lng:             outLng,
      speed:           location.speed,
      accuracy:        location.accuracy,
      heading:         location.heading  || 0,
      altitude:        location.altitude || 0,
      snapped:         location.snapped  || false,
      roadName:        location.roadName || '',
      timestamp:       location.timestamp,
      isActive:        location.isActive,
      isRecent,
      extrapolated,
      encryptedCoords: location.encryptedCoords || ''
    };

    locationCache.set(cacheKey, response);
    res.json(response);

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
    const results  = [];
    const cacheMissIds = [];

    for (const trackId of trackIds) {
      const cached = locationCache.get(`loc:${trackId}`);
      if (cached) {
        results.push({ trackId, cached, fromCache: true });
      } else {
        cacheMissIds.push(trackId);
      }
    }

    if (cacheMissIds.length > 0) {
      const dbLocs = await Location.find(
        { trackId: { $in: cacheMissIds } }
      ).lean();
      for (const loc of dbLocs) {
        locationCache.set(`loc:${loc.trackId}`, loc);
        results.push({ trackId: loc.trackId, cached: loc, fromCache: false });
      }
    }

    const formatted = await Promise.all(results.map(async ({ trackId, cached: loc }) => {
      if (requesterId && requesterId !== trackId) {
        const owner = await User.findOne(
          { trackId },
          'privacyMode approvedIds friends blockedUsers'
        ).lean();
        if (owner) {
          if ((owner.blockedUsers || []).includes(requesterId))
            return { trackId, blocked: true };
          if (owner.privacyMode === 'CONTACTS_ONLY' &&
              !(owner.friends || []).includes(requesterId))
            return { trackId, privacy: true };
          if (owner.privacyMode === 'SELECTED' &&
              !(owner.approvedIds || []).includes(requesterId))
            return { trackId, privacy: true };
        }
      }

      const isRecent = new Date(loc.timestamp) > new Date(nowMs - 2_000);
      let outLat = loc.lat, outLng = loc.lng, extrapolated = false;

      if (!loc.encryptedCoords && isRecent && (loc.speed || 0) > 0.3) {
        const dr = deadReckon(loc, nowMs);
        outLat       = dr.lat;
        outLng       = dr.lng;
        extrapolated = dr.extrapolated;
      }

      return {
        trackId,
        lat:             outLat,
        lng:             outLng,
        speed:           loc.speed    || 0,
        accuracy:        loc.accuracy || 0,
        heading:         loc.heading  || 0,
        altitude:        loc.altitude || 0,
        snapped:         loc.snapped  || false,
        roadName:        loc.roadName || '',
        timestamp:       loc.timestamp,
        isRecent,
        extrapolated,
        encryptedCoords: loc.encryptedCoords || ''
      };
    }));

    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/location/batch — Android sends array of points, server processes as one batch
app.post('/api/location/batch', async (req, res) => {
  try {
    const { trackId, points } = req.body;
    if (!trackId || !Array.isArray(points) || points.length === 0)
      return res.status(400).json({ error: 'trackId and points[] required' });
    if (points.length > 20)
      return res.status(400).json({ error: 'Max 20 points per batch' });

    const nowMs = Date.now();

    for (const pt of points) {
      const hasEncrypted = !!(pt.encryptedCoords && pt.encryptedCoords.length > 0);
      let processedLat   = pt.lat || 0;
      let processedLng   = pt.lng || 0;

      if (!hasEncrypted && pt.lat && pt.lng) {
        const accM    = Math.max(pt.accuracy || 20, 1);
        const smoothed = serverKalman(trackId, pt.lat, pt.lng, accM, nowMs, pt.speed || 0);
        processedLat  = smoothed.lat;
        processedLng  = smoothed.lng;
      }

      enqueueLocationUpdate(trackId, {
        lat:             processedLat,
        lng:             processedLng,
        speed:           pt.speed           || 0,
        accuracy:        pt.accuracy        || 0,
        heading:         pt.heading         || 0,
        altitude:        pt.altitude        || 0,
        altAccuracy:     pt.altAccuracy     || 0,
        speedAccuracy:   pt.speedAccuracy   || 0,
        headingAccuracy: pt.headingAccuracy || 0,
        provider:        pt.provider        || 'gps',
        encryptedCoords: pt.encryptedCoords || '',
        hasEncrypted,
        timestamp:       new Date(pt.timestamp || nowMs)
      });
    }

    res.json({ success: true, queued: points.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cache/stats', (req, res) => {
  res.json({
    locationCache:  locationCache.getStats(),
    mapMatchCache:  mapMatchCache.getStats(),
    roadSnapCache:  roadSnapCache.getStats(),
    batchQueueSize: [...batchQueue.values()].reduce((a, b) => a + b.length, 0),
    kalmanStoreSize: kalmanStore.size
  });
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

    if (!conversationId || !senderId || !receiverId) {
      return res.status(400).json({ error: 'Missing required fields: conversationId, senderId, receiverId' });
    }

    // Check if either user has blocked the other
    const [senderUser, receiverUser] = await Promise.all([
      User.findOne({ trackId: senderId }, 'blockedUsers blockedBy').lean(),
      User.findOne({ trackId: receiverId }, 'blockedUsers blockedBy').lean()
    ]);
    const senderBlocked   = senderUser?.blockedUsers?.includes(receiverId) || false;
    const receiverBlocked = receiverUser?.blockedUsers?.includes(senderId)  || false;

    if (senderBlocked || receiverBlocked) {
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
      // Upload to Cloudinary
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
        const decoded = img.encryptedBase64; // Client already encrypts
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
    const { conversationId, text, imagePublicId } = message;
    
    // Delete from Cloudinary if single image
    if (imagePublicId) await deleteFromCloudinary(imagePublicId);

    // Delete batch images from Cloudinary if batch message
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
    
    // Delete all Cloudinary images in this conversation
    const messages = await Message.find({ conversationId }).lean();
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
    const cutoff    = new Date(Date.now() - 24 * 3_600_000);
    const staleIds  = await Location.find(
      { timestamp: { $lt: new Date(Date.now() - 30_000) } },
      'trackId'
    ).lean();
    staleIds.forEach(l => kalmanStore.delete(l.trackId));

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
