// routes/api.js
// Express router for LPG system API endpoints
const express = require('express');
const router = express.Router();

// Import controller functions (to be created)
const systemController = require('../controllers/systemController');

// System status endpoint
router.get('/status', systemController.getStatus);

// Command endpoint
router.post('/command', systemController.postCommand);

// Age verification endpoint
router.post('/verify_age', systemController.verifyAge);

// Cooking/fire detection endpoint
router.post('/cooking_fire_status', systemController.cookingFireStatus);

// Food detection endpoint
router.post('/food_detected', systemController.foodDetected);

// Audio transcription endpoint (multer injected in controller)
router.post('/transcribe_audio', systemController.transcribeAudio);

module.exports = router;
