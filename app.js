// app.js - Integrated LPG System Backend (Express.js with Socket.IO)

// --- Imports ---
require('dotenv').config(); // Load environment variables from .env
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const http = require('http'); // Required for Socket.IO
const { Server } = require('socket.io'); // Socket.IO server
const axios = require('axios'); // For making HTTP requests to Blynk
const multer = require('multer'); // For handling file uploads (audio blobs)
const PORT = process.env.PORT || 3000;

// --- Configuration ---
// Load secrets/configuration from environment variables
const BLYNK_AUTH = process.env.BLYNK_AUTH;
const BLYNK_SERVER_ADDRESS = process.env.BLYNK_SERVER_ADDRESS;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const COMMAND_PIN = "V2";
const STATUS_PIN = "V1";
const VALVE_PIN = "V0";

const GAS_THRESHOLD = 600; // ppm for gas leak detection

// --- System State (server-side representation) ---
let systemState = "SLEEP"; // e.g., SLEEP, ACTIVE, COOKING_ACTIVE, COOKING_BOILING, SAFETY_ALERT_GAS, SAFETY_ALERT_FIRE, SAFETY_ALERT_USER, SAFETY_ALERT_EMERGENCY
let verificationStatus = "PENDING"; // e.g., PENDING, VERIFIED
let userAge = "UNKNOWN"; // e.g., UNKNOWN, ADULT, CHILD
let gasLevel = 0;
let valveState = false; // false = closed, true = open
let blynkConnected = false;
let currentCookingFireStatus = "IDLE"; // To track 'IDLE', 'COOKING_SAFE', 'FIRE_OUTBREAK'
let foodBeingPrepared = "Detecting..."; // To store the detected food


// --- Initialize Express App and Socket.IO Server ---
const app = express();
const server = http.createServer(app); // Create HTTP server for Express and Socket.IO
const io = new Server(server, {
    cors: {
        origin: process.env.NODE_ENV === 'production' ? ["https://your-production-domain.com"] : "*",
        methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 1e7 // Increase buffer size for potential audio files (10MB)
});
const PORT = process.env.PORT || 3000;

// --- EJS View Engine Setup ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// --- Middleware ---
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: function (res, filePath) {
        if (filePath.endsWith('.bin')) {
            res.setHeader('Content-Type', 'application/octet-stream');
        }
    }
}));

// Modular API routes
app.use('/api', require('./routes/api'));

// Centralized error handler
app.use(require('./middleware/errorHandler'));

// Configure Multer for file uploads (audio)
// Store files in memory as they are temporary for transcription
const upload = multer({ storage: multer.memoryStorage() });


// --- Socket.IO Connection Handling ---
io.on('connection', (socket) => {
    console.log('A client connected via WebSocket:', socket.id);
    // Send current state to newly connected client
    socket.emit('system_update', {
        systemState,
        verificationStatus,
        userAge,
        gasLevel,
        valveState,
        blynkConnected,
        currentCookingFireStatus,
        foodBeingPrepared
    });

    socket.on('trigger-voice', (data) => {
        const { code } = data;
        console.log(`Received trigger-voice event. Sending code: ${code} to ESP32.`);
        triggerHardwareVoice(code);
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// Function to emit current system state to all connected clients
/**
 * Sends a command code to the ESP32 hardware via the Blynk HTTP API to trigger a voice response.
 * @param {number | string} commandCode - The numeric code for the desired voice response.
 */
async function triggerHardwareVoice(commandCode) {
    const token = process.env.BLYNK_VOICE_TOKEN;
    const baseUrl = process.env.BLYNK_VOICE_URL;

    if (!token || !baseUrl) {
        console.error("Blynk voice token or URL is not defined in .env file.");
        return;
    }

    const url = `${baseUrl}/update?token=${token}&v0=${commandCode}`;

    try {
        console.log(`Sending voice command ${commandCode} to hardware...`);
        const response = await axios.get(url);
        if (response.status === 200) {
            console.log(`Successfully sent voice command ${commandCode}.`);
        } else {
            console.warn(`Blynk API returned a non-200 status: ${response.status}`);
        }
    } catch (error) {
        console.error(`Error sending voice command to hardware: ${error.message}`);
    }
}

// Function to emit current system state to all connected clients
function emitSystemUpdate() {
    io.emit('system_update', {
        systemState,
        verificationStatus,
        userAge,
        gasLevel,
        valveState,
        blynkConnected,
        currentCookingFireStatus,
        foodBeingPrepared
    });
}

// --- Blynk Communication Functions ---

// Helper function for fetch with timeout
async function fetchWithTimeout(url, options, timeout = 5000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(id);
        return response;
    } catch (error) {
        clearTimeout(id);
        if (error.name === 'AbortError') {
            throw new Error(`Request timed out after ${timeout}ms`);
        }
        throw error;
    }
}


async function connectBlynk() {
    try {
        const url = `${BLYNK_SERVER_ADDRESS}/external/api/isHardwareConnected?token=${BLYNK_AUTH}`;
        // Using fetchWithTimeout for connection check
        const response = await fetchWithTimeout(url, {}, 5000); // 5 second timeout
        const data = await response.text();
        blynkConnected = (data === 'true'); // Blynk returns "true" or "false" as string
        console.log(`Blynk connection: ${blynkConnected ? 'Success' : 'Failed - Device offline or invalid token.'}`);
    } catch (error) {
        console.error(`Blynk connection error: ${error.message}. Please check BLYNK_AUTH token and device status.`);
        blynkConnected = false;
    } finally {
        emitSystemUpdate(); // Update clients about Blynk connection status
    }
}

async function blynkSend(pin, value) {
    if (!blynkConnected) {
        console.warn(`Blynk not connected, cannot send data to ${pin}.`);
        return false;
    }
    try {
        const url = `${BLYNK_SERVER_ADDRESS}/external/api/update?token=${BLYNK_AUTH}&${pin}=${value}`;
        // Using fetchWithTimeout for update request
        const response = await fetchWithTimeout(url, {}, 3000); // 3 second timeout
        if (!response.ok) { // Check response.ok for successful HTTP status (200-299)
            console.error(`Blynk update failed for ${pin}=${value}: Status ${response.status}`);
            return false;
        }
        return true;
    } catch (error) {
        console.error(`Blynk send error to ${pin}: ${error.message}`);
        blynkConnected = false; // Assume connection lost on send error
        emitSystemUpdate(); // Update clients if Blynk connection failed
        return false;
    }
}

async function blynkRead(pin) {
    if (!blynkConnected) {
        console.warn(`Blynk not connected, cannot read data from ${pin}.`);
        return "";
    }
    try {
        const url = `${BLYNK_SERVER_ADDRESS}/external/api/get?token=${BLYNK_AUTH}&${pin}`;
        // Using fetchWithTimeout for get request
        const response = await fetchWithTimeout(url, {}, 3000); // 3 second timeout
        if (!response.ok) { // Check response.ok for successful HTTP status (200-299)
            console.error(`Blynk get failed for ${pin}: Status ${response.status}`);
            return "";
        }
        return (await response.text()).trim();
    } catch (error) {
        console.error(`Blynk read error from ${pin}: ${error.message}`);
        blynkConnected = false; // Assume connection lost on read error
        emitSystemUpdate(); // Update clients if Blynk connection failed
        return "";
    }
}

async function setValveState(state) {
    valveState = state;
    const success = await blynkSend(VALVE_PIN, state ? 1 : 0);
    if (success) {
        console.log(`Valve state: ${state ? 'OPEN' : 'CLOSED'}`);
    } else {
        console.error(`Failed to set valve state to ${state ? 'OPEN' : 'CLOSED'}`);
    }
    emitSystemUpdate(); // Emit state change via WebSocket
}

// --- Safety Monitoring (Server-side, for gas levels) ---
async function safetyMonitoring() {
    console.log("Safety monitoring started (server-side)");
    setInterval(async () => {
        try {
            const rawGasLevel = await blynkRead("V0"); // Assuming V0 is the gas sensor pin
            const newGasLevel = parseInt(rawGasLevel) || 0;
            if (newGasLevel !== gasLevel) { // Only update if value changed
                gasLevel = newGasLevel;
                emitSystemUpdate(); // Emit gas level change
            }

            if (gasLevel > GAS_THRESHOLD) {
                handleSafetyAlert("GAS_LEAK");
            }

        } catch (error) {
            // Error already logged in blynkRead, just continue
        }
    }, 1000); // Check every 1 second
}

async function handleSafetyAlert(alertType) {
    await setValveState(false); // Close valve for all safety alerts

    let alertMessage = "";
    let blynkCommand = "";
    let shouldEmit = false;

    switch (alertType) {
        case "GAS_LEAK":
            if (systemState !== "SAFETY_ALERT_GAS") {
                systemState = "SAFETY_ALERT_GAS";
                alertMessage = "Gas leak detected! Valve closed.";
                blynkCommand = "SAFETY_GAS_LEAK";
                shouldEmit = true;
            }
            break;
        case "FIRE_DETECTED": // This now means 'FIRE_OUTBREAK' from the vision model
            if (systemState !== "SAFETY_ALERT_FIRE") {
                systemState = "SAFETY_ALERT_FIRE";
                alertMessage = "Fire detected! Valve closed.";
                blynkCommand = "SAFETY_FIRE";
                shouldEmit = true;
            }
            break;
        case "INVALID_USER":
            if (systemState !== "SAFETY_ALERT_USER") {
                systemState = "SAFETY_ALERT_USER";
                alertMessage = "Unauthorized user detected! Valve closed.";
                blynkCommand = "SAFETY_INVALID_USER";
                shouldEmit = true;
            }
            break;
        case "EMERGENCY_STOP":
            if (systemState !== "SAFETY_ALERT_EMERGENCY") {
                systemState = "SAFETY_ALERT_EMERGENCY";
                alertMessage = "Emergency stop activated!";
                blynkCommand = "EMERGENCY_STOP";
                shouldEmit = true;
            }
            break;
        default:
            alertMessage = "Unknown safety alert.";
            break;
    }

    if (shouldEmit) {
        console.log(`System: ${alertMessage}`);
        await blynkSend(COMMAND_PIN, blynkCommand);
        emitSystemUpdate();
        // Reset after 30 seconds if conditions normalize (Gas level check only here)
        setTimeout(checkSafetyReset, 30000);
    }
}

async function checkSafetyReset() {
    // Reset if gas is clear AND no fire outbreak is detected AND no invalid user
    if (gasLevel < GAS_THRESHOLD &&
        currentCookingFireStatus !== "FIRE_OUTBREAK" &&
        userAge !== "CHILD" && // Ensure no child is detected
        systemState.includes("SAFETY_ALERT")) // Only try to reset if in an alert state
        {
            systemState = "ACTIVE";
            console.log("System: Safety conditions normalized. System ready.");
            emitSystemUpdate();
        }
}


// --- API Routes ---

// Root route to render the EJS dashboard
app.get('/', (req, res) => {
    // Pass initial state for the AI button to the EJS template
    res.render('index', { isAIActive: true }); 
});

// Get current system status (might still be used for initial load or by other APIs)
app.get('/api/status', (req, res) => {
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
});

// Update system state from a client (e.g., after voice command)
app.post('/api/command', async (req, res) => {
    const { command } = req.body;
    console.log(`Received command: ${command}`);

    let responseMessage = "Command not recognized.";
    let oldSystemState = systemState;

    // Check for safety alerts and user age before processing commands
    const isSafetyAlert = systemState.startsWith('SAFETY_ALERT');
    const isChildPresent = userAge === 'CHILD';

    if (isSafetyAlert && command !== 'emergency stop') {
        return res.json({ status: 'error', message: `Cannot execute command. System is in a safety alert state: ${systemState}.`, systemState, valveState });
    }

    if (isChildPresent && command !== 'emergency stop' && command !== 'sleep' && command !== 'activate system') {
        return res.json({ status: 'error', message: `Access denied. A child is detected. Cannot execute command: ${command}.`, systemState, valveState });
    }

    switch (command.toLowerCase()) {
        case "wake": // This might be redundant if "activate system" is used
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
            await setValveState(false);
            responseMessage = "System entering sleep mode. Goodbye.";
            break;
        case "start cooking":
            if (systemState === "ACTIVE" || systemState.includes("COOKING")) {
                if (currentCookingFireStatus === "COOKING_SAFE" || currentCookingFireStatus === "IDLE") {
                    systemState = "COOKING_ACTIVE";
                    await setValveState(true);
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
                    await setValveState(true);
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
            systemState = "ACTIVE"; // Return to active state
            await setValveState(false);
            responseMessage = "Cooking stopped. Gas valve closed.";
            break;
        case "emergency stop":
            await handleSafetyAlert("EMERGENCY_STOP");
            responseMessage = "Emergency stop activated!";
            break;
        case "activate system": // Command to explicitly activate from sleep
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

    // Only emit update if a meaningful state change or action occurred
    if (systemState !== oldSystemState || responseMessage !== "Command not recognized.") {
        emitSystemUpdate();
    }
    res.json({ status: "success", message: responseMessage, systemState, valveState });
});

// Endpoint for frontend/microservice to send age verification results
app.post('/api/verify_age', (req, res) => {
    const { status, age } = req.body;
    let oldVerificationStatus = verificationStatus;
    let oldUserAge = userAge;

    verificationStatus = status;
    userAge = age;

    if (verificationStatus !== oldVerificationStatus || userAge !== oldUserAge) {
        if (verificationStatus === "VERIFIED" && userAge === "ADULT") {
            console.log("System: Adult verified. Access granted.");
            blynkSend(STATUS_PIN, "ADULT_VERIFIED");
        } else if (verificationStatus === "VERIFIED" && userAge === "CHILD") {
            console.log("System: Child detected. Access denied. Valve closed.");
            blynkSend(STATUS_PIN, "CHILD_DETECTED");
            if (systemState !== "SAFETY_ALERT_USER") { // Avoid re-triggering if already in alert
                handleSafetyAlert("INVALID_USER");
            }
        } else if (verificationStatus === "PENDING") {
            console.log("System: Age verification pending.");
        }
        emitSystemUpdate();
    }
    res.json({ status: "age_verification_received", verificationStatus, userAge });
});

// Endpoint for frontend to send cooking/fire detection results
app.post('/api/cooking_fire_status', (req, res) => {
    const { cookingStatus } = req.body; // Expecting 'IDLE', 'COOKING_SAFE', 'FIRE_OUTBREAK'
    let oldCookingFireStatus = currentCookingFireStatus;
    currentCookingFireStatus = cookingStatus;

    if (cookingStatus === "FIRE_OUTBREAK") {
        if (systemState !== "SAFETY_ALERT_FIRE") { // Only trigger if not already in this state
            handleSafetyAlert("FIRE_DETECTED"); // Trigger fire alert
        }
    } else if (oldCookingFireStatus === "FIRE_OUTBREAK" && cookingStatus !== "FIRE_OUTBREAK") {
        // If fire was detected, but now it's safe/idle, attempt reset
        console.log("Client reports fire cleared. Attempting safety reset.");
        checkSafetyReset();
    }

    if (cookingStatus !== oldCookingFireStatus) {
        emitSystemUpdate(); // Only emit if the status itself changed
    }

    res.json({ status: "cooking_fire_status_received" });
});

// Endpoint for food identification results
app.post('/api/food_detected', (req, res) => {
    const { detectedFood } = req.body;
    let oldFoodBeingPrepared = foodBeingPrepared;
    foodBeingPrepared = detectedFood;

    // Only update and emit if food detection changed AND system is in a cooking state
    if (foodBeingPrepared !== oldFoodBeingPrepared && 
        (systemState === 'COOKING_ACTIVE' || systemState === 'COOKING_BOILING' || currentCookingFireStatus === 'COOKING_SAFE')) {
        emitSystemUpdate();
    }
    res.json({ status: "food_detection_received" });
});

// NEW: Endpoint to receive audio for transcription
app.post('/api/transcribe_audio', upload.single('audio'), async (req, res) => {
    if (!req.file) {
        console.warn("No audio file received for transcription.");
        return res.status(400).json({ status: 'error', message: 'No audio file provided.' });
    }

    console.log(`Received audio file: ${req.file.originalname}, size: ${req.file.size} bytes, mimetype: ${req.file.mimetype}`);

    // --- Placeholder for actual Speech-to-Text (STT) service ---
    // In a real application, you would send req.file.buffer (the audio data)
    // to a cloud STT API like Google Cloud Speech-to-Text.
    // For this demonstration, we'll simulate transcription using the Gemini API
    // based on a generic prompt that asks it to act as an STT.

    const prompt = "Transcribe the following audio content into a single sentence. Assume the audio contains a user speaking a command for a smart home system. Do not add any conversational filler. Just the transcribed text. If the audio is silent or unclear, respond with 'No speech detected'.";
    
    // Placeholder for actual audio data. In a real scenario, base64Audio would be derived from req.file.buffer
    // For LLM, we don't send raw audio directly through 'text generation' API, so we'll simulate based on prompt idea.
    const chatHistory = [];
    chatHistory.push({ role: "user", parts: [{ text: prompt }] });
    
    const payload = {
        contents: chatHistory
    };

    const apiKey = process.env.GEMINI_API_KEY; // Canvas will provide this at runtime
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

    let transcribedText = 'No speech detected'; // Default in case of API failure

    try {
        const geminiResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const geminiResult = await geminiResponse.json();

        if (geminiResult.candidates && geminiResult.candidates.length > 0 &&
            geminiResult.candidates[0].content && geminiResult.candidates[0].content.parts &&
            geminiResult.candidates[0].content.parts.length > 0) {
            transcribedText = geminiResult.candidates[0].content.parts[0].text.trim();
            console.log("Simulated Transcription (Gemini API):", transcribedText);
        } else {
            console.warn("Gemini API did not return a valid transcription:", geminiResult);
            transcribedText = "Could not transcribe (API issue)";
        }
    } catch (llmError) {
        console.error("Error calling Gemini API for transcription simulation:", llmError);
        transcribedText = "Transcription service unavailable";
    }

    // Send the transcribed text back to the frontend
    res.json({ status: 'success', message: 'Audio received and simulated transcription.', transcript: transcribedText });
});


// --- Start Server ---
server.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Access the system at http://localhost:${PORT}`);
    await connectBlynk();
    safetyMonitoring();
});


app.listen(PORT, () => console.log(`Running on ${PORT}`));