// controllers/systemController.js
// Business logic for LPG system endpoints

// --- System Variables (imported from a shared state module in a full refactor) ---
let systemState = "SLEEP";
let verificationStatus = "PENDING";
let userAge = "UNKNOWN";
let gasLevel = 0;
let valveState = false;
let blynkConnected = false;
let currentCookingFireStatus = "IDLE";
let foodBeingPrepared = "Detecting...";
const GAS_THRESHOLD = 600;
const COMMAND_PIN = "V10";
const STATUS_PIN = "V15";
const VALVE_PIN = "V1";

// --- Service Imports ---
const blynkService = require('../services/blynkService');
const geminiService = require('../services/geminiService');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

// --- WebSocket Update Helper (to be improved in a full refactor) ---
function emitSystemUpdate() {
  // In a full refactor, this would notify all connected WebSocket clients
  // For now, this is a placeholder
  // Example: io.emit('system_update', {...})
}

// --- Controllers ---
exports.getStatus = async (req, res, next) => {
  try {
    res.json({
      systemState,
      verificationStatus,
      userAge,
      gasLevel,
      valveState,
      blynkConnected,
      currentCookingFireStatus,
      foodBeingPrepared
    });
  } catch (err) {
    next(err);
  }
};

exports.postCommand = async (req, res, next) => {
  try {
    const { command } = req.body;
    let responseMessage = "Command not recognized.";
    let oldSystemState = systemState;
    const isSafetyAlert = systemState.startsWith('SAFETY_ALERT');
    const isChildPresent = userAge === 'CHILD';
    if (isSafetyAlert && command !== 'emergency stop') {
      return res.json({ status: 'error', message: `Cannot execute command. System is in a safety alert state: ${systemState}.`, systemState, valveState });
    }
    if (isChildPresent && command !== 'emergency stop' && command !== 'sleep' && command !== 'activate system') {
      return res.json({ status: 'error', message: `Access denied. A child is detected. Cannot execute command: ${command}.`, systemState, valveState });
    }
    switch (command.toLowerCase()) {
      case "wake":
        if (systemState === "SLEEP") {
          systemState = "ACTIVE";
          responseMessage = "Hello, I'm Kate. How can I assist you today?";
        } else {
          responseMessage = `System is already ${systemState}.`;
        }
        break;
      case "sleep":
      case "shut down":
        systemState = "SLEEP";
        valveState = false;
        responseMessage = "System entering sleep mode. Goodbye.";
        break;
      case "start cooking":
        if (systemState === "ACTIVE" || systemState.includes("COOKING")) {
          if (currentCookingFireStatus === "COOKING_SAFE" || currentCookingFireStatus === "IDLE") {
            systemState = "COOKING_ACTIVE";
            valveState = true;
            responseMessage = "Cooking mode activated. Gas valve opened.";
          } else {
            responseMessage = "Cannot start cooking due to unsafe conditions (e.g., fire outbreak).";
          }
        } else {
          responseMessage = `System is ${systemState}. Please activate the system first.`;
        }
        break;
      case "boil water":
        if (systemState === "ACTIVE" || systemState.includes("COOKING")) {
          if (currentCookingFireStatus === "COOKING_SAFE" || currentCookingFireStatus === "IDLE") {
            systemState = "COOKING_BOILING";
            valveState = true;
            responseMessage = "Boiling water mode activated. Gas valve opened.";
          } else {
            responseMessage = "Cannot boil water due to unsafe conditions (e.g., fire outbreak).";
          }
        } else {
          responseMessage = `System is ${systemState}. Please activate the system first.`;
        }
        break;
      case "stop cooking":
      case "turn off":
        systemState = "ACTIVE";
        valveState = false;
        responseMessage = "Cooking stopped. Gas valve closed.";
        break;
      case "emergency stop":
        systemState = "SAFETY_ALERT_EMERGENCY";
        valveState = false;
        responseMessage = "Emergency stop activated!";
        break;
      case "activate system":
        if (systemState === "SLEEP") {
          systemState = "ACTIVE";
          responseMessage = "System activated. How can I assist you?";
        } else {
          responseMessage = `System is already ${systemState}.`;
        }
        break;
      default:
        responseMessage = "Command not recognized.";
        break;
    }
    if (systemState !== oldSystemState || responseMessage !== "Command not recognized.") {
      emitSystemUpdate();
    }
    res.json({ status: "success", message: responseMessage, systemState, valveState });
  } catch (err) {
    next(err);
  }
};

exports.verifyAge = async (req, res, next) => {
  try {
    const { status, age } = req.body;
    let oldVerificationStatus = verificationStatus;
    let oldUserAge = userAge;
    verificationStatus = status;
    userAge = age;
    if (verificationStatus !== oldVerificationStatus || userAge !== oldUserAge) {
      emitSystemUpdate();
    }
    res.json({ status: "age_verification_received", verificationStatus, userAge });
  } catch (err) {
    next(err);
  }
};

exports.cookingFireStatus = async (req, res, next) => {
  try {
    const { cookingStatus } = req.body;
    let oldCookingFireStatus = currentCookingFireStatus;
    currentCookingFireStatus = cookingStatus;
    if (cookingStatus !== oldCookingFireStatus) {
      emitSystemUpdate();
    }
    res.json({ status: "cooking_fire_status_received" });
  } catch (err) {
    next(err);
  }
};

exports.foodDetected = async (req, res, next) => {
  try {
    const { detectedFood } = req.body;
    let oldFoodBeingPrepared = foodBeingPrepared;
    foodBeingPrepared = detectedFood;
    if (foodBeingPrepared !== oldFoodBeingPrepared && 
      (systemState === 'COOKING_ACTIVE' || systemState === 'COOKING_BOILING' || currentCookingFireStatus === 'COOKING_SAFE')) {
      emitSystemUpdate();
    }
    res.json({ status: "food_detection_received" });
  } catch (err) {
    next(err);
  }
};

exports.transcribeAudio = [
  upload.single('audio'),
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ status: 'error', message: 'No audio file provided.' });
      }
      const prompt = "Transcribe the following audio content into a single sentence. Assume the audio contains a user speaking a command for a smart home system. Do not add any conversational filler. Just the transcribed text. If the audio is silent or unclear, respond with 'No speech detected'.";
      const chatHistory = [{ role: "user", parts: [{ text: prompt }] }];
      const geminiResult = await geminiService.transcribeAudio(chatHistory);
      let transcribedText = 'No speech detected';
      if (geminiResult.candidates && geminiResult.candidates.length > 0 &&
        geminiResult.candidates[0].content && geminiResult.candidates[0].content.parts &&
        geminiResult.candidates[0].content.parts.length > 0) {
        transcribedText = geminiResult.candidates[0].content.parts[0].text.trim();
      } else {
        transcribedText = "Could not transcribe (API issue)";
      }
      res.json({ status: 'success', message: 'Audio received and simulated transcription.', transcript: transcribedText });
    } catch (err) {
      next(err);
    }
  }
];
