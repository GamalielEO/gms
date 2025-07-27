// main.js

// --- Dependency Checks ---
// Check if TensorFlow.js is loaded globally
if (typeof tf === 'undefined') {
    const errorMsg = 'CRITICAL ERROR: TensorFlow.js (tf) is not loaded. The application cannot start. Please check the <script> tag in your index.ejs file.';
    // Display the error in the system messages UI if possible
    const messagesDiv = document.getElementById('messages');
    if (messagesDiv) {
        const p = document.createElement('p');
        p.textContent = errorMsg;
        p.style.color = 'red';
        p.style.fontWeight = 'bold';
        messagesDiv.prepend(p);
    }
    // Log to console and stop execution
    console.error(errorMsg);
    throw new Error(errorMsg);
}

// --- Configuration ---
const BACKEND_URL = 'http://localhost:3000'; // Your Express.js backend URL
const WAKE_WORD = "Kate"; // Define the wake word (kept lowercase for consistent comparison)
const COMMAND_WINDOW_DURATION = 5000; // 5 seconds in milliseconds

// Maps system commands to the numeric codes for ESP32 voice responses
const COMMAND_TO_VOICE_CODE = {
    'START_COOKING': 4,    // "gas is supplied ignite gas"
    'STOP_COOKING': 25,   // "shutdown command initiated."
    'BOIL_WATER': 1,      // "boil water acknowledged"
    'EMERGENCY_STOP': 25, // "shutdown command initiated."
    'ACTIVATE_SYSTEM': 12, // "i’m here what would you like me to do."
    'DEACTIVATE_SYSTEM': 21, // "okay great i will be on standby if you need me."
};

// --- TensorFlow.js Model Paths ---
// IMPORTANT: Ensure these paths match where you place your Teachable Machine exported files
// or manually converted TensorFlow.js models.
const AGE_MODEL_PATH = 'https://teachablemachine.withgoogle.com/models/bRwfxXTTq/model.json';
const FIRE_COOKING_MODEL_PATH = 'https://teachablemachine.withgoogle.com/models/KcDYbUpFl/model.json';
const FOOD_MODEL_PATH = 'https://teachablemachine.withgoogle.com/models/JPJl846O2/model.json';

// --- Global Variables (will be assigned DOM elements within initSystem) ---
let video;
let overlayCanvas;
let ctx;
let systemStatusElem;
let verificationStatusElem;
let detectedAgeElem;
let gasLevelElem;
let valveStateElem;
let voiceStatusElem;
let lastCommandElem;
let voiceControlBtn;
let aiControlBtn; // AI toggle button
let messagesDiv;
let foodPreparedElem;
let cookingStatusElem;

// Manual Control Buttons
let startCookingBtn;
let stopCookingBtn;
let boilWaterBtn;
let emergencyStopBtn;
let voiceCommandSelect;
let sendVoiceCommandBtn;

// --- Global Variables (for models, speech, and system state) ---
let ageModel;
let fireCookingModel;
let foodModel;

let ageModelMetadata;
let fireCookingModelMetadata;
let foodModelMetadata;
let isAIActive = true; // AI is active by default

let speechRecognition;
let speechSynth = window.speechSynthesis;
let systemData = {}; // Stores the latest system state from the backend
let lastPersonDetectionState = false; // To track person presence for voice auto-activation

let lastSpokenSystemState = "";
let lastSpokenValveState = "";
let lastSpokenVerificationStatus = "";
let lastSpokenCookingStatus = "";

let socket;

let lastAIDetectionTime = 0;
const AI_DETECTION_INTERVAL = 1000;

// Voice control state machine variables
let voiceListeningMode = 'OFF'; // 'OFF', 'WAKE_WORD_MODE', 'COMMAND_MODE'
let commandWindowTimeout; // Timer for the 5-second command window
let isVoiceRecognitionActive = false; // Flag for actual Web Speech API state (onstart/onend)

// Promise chain to ensure sequential start/stop operations
let recognitionTransitionPromiseChain = Promise.resolve();
let resolveRecognitionStopPromise = null; // Resolver for when a recognition.stop() finishes

// Stores the mode to resume to after speaking
let pendingResumeVoiceListeningMode = 'OFF';

// Cooldown delay to allow speech recognition engine to fully reset after stopping
const RECOGNITION_COOLDOWN_DELAY = 300; // Increased delay to 300ms for more stability

// --- Modular Imports ---
import { appendMessage } from './ui.js';
import { initSpeechRecognition } from './speech.js'; // Assuming speech.js contains the Web Speech API setup
import { loadModels } from './model.js'; // Assuming model.js contains the TensorFlow.js model loading

// --- Utility Functions ---

/**
 * Uses the Web Speech API to speak a given text.
 * This function also handles pausing speech recognition while speaking
 * and resuming it afterward.
 * @param {string} text - The text to be spoken by the system.
 */
async function speak(text) {
    if (speechSynth.speaking) {
        speechSynth.cancel();
    }

    // Capture the current recognition state *before* pausing
    const wasRecognitionActiveBeforeSpeak = isVoiceRecognitionActive;
    const modeToResume = voiceListeningMode;

    // If recognition is active and not already OFF, stop it and wait for it to fully end
    // Only stop if we actually have a mode to resume to, not if it's already OFF
    if (wasRecognitionActiveBeforeSpeak && modeToResume !== 'OFF') {
        appendMessage("Pausing speech recognition while speaking...", 'info');
        pendingResumeVoiceListeningMode = modeToResume; // Save current mode to resume later
        // Request the voice control system to stop, which will manage the onend and promise resolution
        await stopVoiceControl(true); // Pass true to indicate an internal pause, don't speak "Voice control stopped"
        appendMessage("Speech recognition paused and confirmed stopped.", 'info');
    } else {
        pendingResumeVoiceListeningMode = 'OFF'; // No need to resume if not active or already OFF
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.pitch = 1;
    utterance.rate = 1;

    utterance.onend = () => {
        appendMessage(`System finished speaking: "${text}"`, 'info');
        // Resume speech recognition if it was active before speaking
        if (pendingResumeVoiceListeningMode !== 'OFF') {
            appendMessage(`Resuming speech recognition in ${pendingResumeVoiceListeningMode} mode...`, 'info');
            // Use a short delay to ensure synthesis resources are freed before recognition starts
            // This is critical for speech recognition to start reliably.
            setTimeout(() => {
                startVoiceControl(pendingResumeVoiceListeningMode); // Resume in the mode it was in
                pendingResumeVoiceListeningMode = 'OFF'; // Reset
            }, RECOGNITION_COOLDOWN_DELAY);
        }
    };

    utterance.onerror = (event) => {
        console.error("Speech synthesis error:", event);
        appendMessage(`Speech synthesis error: ${event.error}`, 'error');
        // Even if error, attempt to resume if it was supposed to
        if (pendingResumeVoiceListeningMode !== 'OFF') {
            appendMessage(`Attempting to resume speech recognition after synthesis error in ${pendingResumeVoiceListeningMode} mode...`, 'warn');
            setTimeout(() => {
                startVoiceControl(pendingResumeVoiceListeningMode);
                pendingResumeVoiceListeningMode = 'OFF';
            }, RECOGNITION_COOLDOWN_DELAY);
        }
    };

    speechSynth.speak(utterance);
    appendMessage(`System spoke: "${text}"`);
}

// --- Camera Initialization ---

/**
 * Initializes the camera and streams the video to the <video> element.
 * Sets up overlay canvas dimensions once video metadata is loaded.
 * @returns {Promise<boolean>} True if camera is successfully initialized, false otherwise.
 */
async function initCamera() {
    appendMessage("Initializing camera...");
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        video.srcObject = stream;

        return new Promise((resolve) => {
            video.onloadedmetadata = () => {
                overlayCanvas.width = video.videoWidth;
                overlayCanvas.height = video.videoHeight;
                appendMessage("Camera initialized successfully.", 'success');
                resolve(true);
            };
            video.onerror = (e) => {
                appendMessage(`Video element error: ${e.message || 'Unknown error'}`, 'error');
                console.error("Video element error:", e);
                resolve(false);
            };
        });
    } catch (error) {
        let errorMessage = `Error accessing camera: ${error.name}. `;
        if (error.name === 'NotAllowedError') {
            errorMessage += 'Please grant camera permissions in your browser settings.';
        } else if (error.name === 'NotFoundError') {
            errorMessage += 'No camera found. Please ensure a camera is connected.';
        } else {
            errorMessage += `Details: ${error.message}`;
        }
        appendMessage(errorMessage, 'error');
        console.error("Camera access error:", error);
        return false;
    }
}

// --- Voice Control Functions ---

/**
 * Starts speech recognition in a specific mode.
 * This function handles stopping any existing session and setting up the new one,
 * ensuring clean transitions by waiting for the previous session to fully stop.
 * @param {'OFF' | 'WAKE_WORD_MODE' | 'COMMAND_MODE'} mode - The desired listening mode.
 */
async function startVoiceControl(mode) {
    if (!speechRecognition) {
        appendMessage("Speech recognition not initialized.", 'error');
        return;
    }

    // Ensure only one startVoiceControl process runs at a time.
    // Chain promises to prevent overlapping start/stop calls.
    recognitionTransitionPromiseChain = recognitionTransitionPromiseChain.then(async () => {
        // If current actual state is different from desired mode, or if API is active unexpectedly
        if (isVoiceRecognitionActive) { // If recognition is truly active
            if (voiceListeningMode === mode) { // If already in the target mode, do nothing
                appendMessage(`Voice control already active in ${mode} mode. No action needed.`, 'info');
                return Promise.resolve();
            } else { // If active but in a different mode, stop it first
                appendMessage(`Initiating stop of current session (${voiceListeningMode}) before starting ${mode} mode.`, 'info');
                speechRecognition.stop(); // This will trigger onend
                // Create a new promise that resolves when onend fires for THIS specific stop() call
                return new Promise(resolve => {
                    resolveRecognitionStopPromise = resolve;
                });
            }
        } else if (voiceListeningMode === mode && mode === 'OFF') {
            // If already OFF and target is OFF, no action needed.
            appendMessage("Voice control already OFF. No action needed.", 'info');
            return Promise.resolve();
        }
        return Promise.resolve(); // If nothing active, resolve immediately to proceed
    }).then(async () => {
        // This block executes *after* any necessary stop() and its onend has completed.
        // Introduce a small cooldown delay after the stop (or if already idle) before starting.
        await new Promise(resolve => setTimeout(resolve, RECOGNITION_COOLDOWN_DELAY));

        voiceListeningMode = mode; // Set the intended mode

        // Update UI based on the new mode
        if (mode === 'WAKE_WORD_MODE') {
            speechRecognition.continuous = true; // Continuous for wake word
            voiceStatusElem.textContent = "Voice Active: Listening for 'Kate'...";
            voiceStatusElem.classList.remove('text-yellow-400', 'text-green-400', 'text-red-400');
            voiceStatusElem.classList.add('text-blue-400');
            voiceControlBtn.textContent = "Listening for 'Kate'...";
            voiceControlBtn.disabled = true;
            appendMessage("Entering Wake Word Mode.", 'info');
        } else if (mode === 'COMMAND_MODE') {
            speechRecognition.continuous = false; // Not continuous for commands (single utterance)
            voiceStatusElem.textContent = "Voice Active: Listening for Command...";
            voiceStatusElem.classList.remove('text-yellow-400', 'text-blue-400', 'text-red-400');
            voiceStatusElem.classList.add('text-green-400');
            voiceControlBtn.textContent = "Listening for Command...";
            voiceControlBtn.disabled = true; // Keep disabled while command window is active
            appendMessage("Entering Command Mode. 5-second window open.", 'info');
        } else if (mode === 'OFF') { // Explicitly handle 'OFF' mode for UI
            speechRecognition.continuous = false; // Ensure continuous is false if turning off
            voiceStatusElem.textContent = "Voice Idle";
            voiceStatusElem.classList.remove('text-blue-400', 'text-red-400', 'text-green-400');
            voiceStatusElem.classList.add('text-yellow-400');
            voiceControlBtn.textContent = `Start Listening (Say "${WAKE_WORD}")`;
            voiceControlBtn.disabled = false;
            appendMessage("Voice control set to OFF state.", 'info');
            return; // No need to start recognition if mode is OFF
        }
        speechRecognition.interimResults = false; // Always false for final results only

        try {
            // Only start if the target mode is NOT OFF
            if (mode !== 'OFF') {
                speechRecognition.start();
            }
        } catch (e) {
            console.error(`Error starting recognition in ${mode} mode:`, e);
            appendMessage(`Failed to start voice control in ${mode} mode: ${e.message}`, 'error');
            // If start fails, force reset to OFF and enable button
            voiceListeningMode = 'OFF';
            voiceControlBtn.disabled = false;
            voiceStatusElem.textContent = "Voice Idle (Error)";
            voiceStatusElem.classList.remove('text-blue-400', 'text-green-400');
            voiceStatusElem.classList.add('text-red-400');
            isVoiceRecognitionActive = false; // Ensure flag is reset
        }
    });

    // Return the promise chain so callers can await the entire transition if needed
    return recognitionTransitionPromiseChain;
}

/**
 * Stops all speech recognition activity.
 * Sets the voice control mode to 'OFF'.
 * @param {boolean} [silent=false] - If true, suppresses the "Voice control stopped" speech.
 */
async function stopVoiceControl(silent = false) {
    if (!speechRecognition) return;
    clearTimeout(commandWindowTimeout); // Clear any pending command window timeout

    // Ensure the internal state reflects stopping immediately
    const previousMode = voiceListeningMode;
    voiceListeningMode = 'OFF';
    pendingResumeVoiceListeningMode = 'OFF'; // Ensure no pending resume

    // Use the promise chain to ensure this stop request is processed sequentially
    recognitionTransitionPromiseChain = recognitionTransitionPromiseChain.then(async () => {
        if (isVoiceRecognitionActive) { // Only call stop if it's actually active
            appendMessage("Initiating stop of voice recognition.", 'info');
            speechRecognition.stop(); // This will trigger onend
            // Wait for the onend handler to set isVoiceRecognitionActive to false and resolve the promise chain
            return new Promise(resolve => {
                resolveRecognitionStopPromise = resolve;
            });
        } else {
            // If not active, ensure UI is consistent with OFF state
            voiceStatusElem.textContent = "Voice Idle";
            voiceStatusElem.classList.remove('text-blue-400', 'text-red-400', 'text-green-400');
            voiceStatusElem.classList.add('text-yellow-400');
            voiceControlBtn.textContent = `Start Listening (Say "${WAKE_WORD}")`;
            voiceControlBtn.disabled = false;
            appendMessage("Voice control already idle or manually stopped.", 'info');
            return Promise.resolve(); // Immediately resolve if nothing to stop
        }
    }).then(() => {
        // This block executes after recognition has fully stopped (or was already idle)
        if (!silent && previousMode !== 'OFF') { // Only speak if not silent and it was actually running before
            speak("Voice control has been stopped.");
        }
    });

    return recognitionTransitionPromiseChain; // Return the promise for callers to await
}

// --- AI Detection Functions ---

/**
 * Performs object detection (age, cooking/fire, food) on the current video frame.
 */
async function detectObjectsInFrame() {
    if (!video || !ageModel || !fireCookingModel || !foodModel) {
        console.warn("Models not ready for detection.");
        return;
    }

    let currentPersonDetectionState = false;

    // --- Age/Person Detection ---
    try {
                // Preprocess the video frame for the model
        const tensor = tf.browser.fromPixels(video);
        const resized = tf.image.resizeBilinear(tensor, [224, 224]);
        const expanded = resized.expandDims(0);
        const normalized = expanded.toFloat().div(tf.scalar(127.5)).sub(tf.scalar(1));

        const agePredictions = await ageModel.predict(normalized).data();

        // Clean up tensors
        tensor.dispose();
        resized.dispose();
        expanded.dispose();
        normalized.dispose();
        console.log("Age Predictions:", agePredictions);
        const sortedAgePreds = agePredictions.sort((a, b) => b.probability - a.probability);
        const topAgePrediction = sortedAgePreds[0];

        if (topAgePrediction && topAgePrediction.probability > 0.7) { // Confidence threshold
            currentPersonDetectionState = true;
            const detectedClass = topAgePrediction.className;
            let ageStatus = "UNKNOWN";

            if (detectedClass.toLowerCase() === "adult") {
                ageStatus = "ADULT";
                detectedAgeElem.textContent = "Adult";
            } else if (detectedClass.toLowerCase() === "child") {
                ageStatus = "CHILD";
                detectedAgeElem.textContent = "Child";
            } else {
                detectedAgeElem.textContent = "Unknown";
            }

            if (systemData.userAge !== ageStatus || systemData.verificationStatus === "PENDING") {
                appendMessage(`Detected age: ${ageStatus} (Confidence: ${(topAgePrediction.probability * 100).toFixed(2)}%)`);
                await sendAgeVerificationToBackend("VERIFIED", ageStatus);
            }
        } else {
            if (systemData.userAge !== "UNKNOWN" || systemData.verificationStatus !== "PENDING") {
                detectedAgeElem.textContent = "Unknown";
                await sendAgeVerificationToBackend("PENDING", "UNKNOWN");
            }
        }
    } catch (error) {
        console.error("Error during age detection:", error);
        appendMessage("Age detection error.", 'error');
    }

    // --- Fire/Cooking Detection ---
    let newCookingFireStatus = systemData.currentCookingFireStatus || 'IDLE';
    try {
        // Preprocess the video frame for the model
        const tensor = tf.browser.fromPixels(video);
        const resized = tf.image.resizeBilinear(tensor, [224, 224]);
        const expanded = resized.expandDims(0);
        const normalized = expanded.toFloat().div(tf.scalar(127.5)).sub(tf.scalar(1));

        const fireCookingPredictions = await fireCookingModel.predict(normalized).data();

        // Clean up tensors
        tensor.dispose();
        resized.dispose();
        expanded.dispose();
        normalized.dispose();
        console.log("Fire/Cooking Predictions:", fireCookingPredictions);

        const sortedFireCookingPreds = fireCookingPredictions.sort((a, b) => b.probability - a.probability);
        let newFireCookingStatus = "";

        if (sortedFireCookingPreds.length > 0) {
          const topFireCookingPrediction = sortedFireCookingPreds[0];

          if (topFireCookingPrediction && topFireCookingPrediction.probability > 0.7) {
            newFireCookingStatus = topFireCookingPrediction.className;
            // If 'Fire Outbreak, no stove' is detected, send 'stop cooking' command
            if (newFireCookingStatus.toLowerCase().includes('fire outbreak')) {
              appendMessage("Fire outbreak detected! Stopping cooking for safety.", 'error');
              sendCommand('stop cooking');
            } else {
              sendCookingFireStatusToBackend(newFireCookingStatus);
            }
          }
        }
    } catch (error) {
        console.error("Error during fire/cooking detection:", error);
        appendMessage("Fire/Cooking detection error.", 'error');
    }

    // --- Food Identification ---
    let newFoodDetected = 'Detecting...';
    if (newCookingFireStatus === "COOKING_SAFE") {
        try {
                        // Preprocess the video frame for the model
            const tensor = tf.browser.fromPixels(video);
            const resized = tf.image.resizeBilinear(tensor, [224, 224]);
            const expanded = resized.expandDims(0);
            const normalized = expanded.toFloat().div(tf.scalar(127.5)).sub(tf.scalar(1));

            const foodPredictions = await foodModel.predict(normalized).data();

            // Clean up tensors
            tensor.dispose();
            resized.dispose();
            expanded.dispose();
            normalized.dispose();
            console.log("Food Predictions:", foodPredictions);
            const sortedFoodPreds = foodPredictions.sort((a, b) => b.probability - a.probability);
            const topFoodPrediction = sortedFoodPreds[0];

            if (topFoodPrediction && topFoodPrediction.probability > 0.7) {
                newFoodDetected = topFoodPrediction.className;
            } else {
                newFoodDetected = "Unidentifiable Food";
            }
        } catch (error) {
            console.error("Error during food detection:", error);
            newFoodDetected = "Error Detecting Food";
            appendMessage("Food detection error.", 'error');
        }
    } else {
        newFoodDetected = "Not Cooking";
    }

    if (newFoodDetected !== systemData.foodBeingPrepared) {
        await sendFoodDetectionToBackend(newFoodDetected);
    }

    // --- Voice Control Logic based on Person Detection ---
    // If system is in SLEEP and a person is newly detected, automatically initiate wake word listening
    // Only if voice is OFF to prevent interrupting an active session
    if (currentPersonDetectionState && !lastPersonDetectionState && systemData.systemState === "SLEEP" && voiceListeningMode === 'OFF') {
        appendMessage("Person detected. Automatically starting wake word listening.", 'info');
        // Await speak to ensure it completes before attempting to start recognition
        await speak(`Say "${WAKE_WORD}" to activate me.`);
        // The speak() call handles resuming voice control after it finishes speaking via pendingResumeVoiceListeningMode
    } else if (!currentPersonDetectionState && lastPersonDetectionState && systemData.systemState === "SLEEP" && voiceListeningMode === 'WAKE_WORD_MODE') {
        // If no person detected and we were in wake word mode, stop listening.
        // This prevents continuous listening when no one is around in sleep mode.
        await stopVoiceControl(); // This will transition voiceListeningMode to OFF and update UI
        appendMessage("No person detected. Stopping continuous listening for wake word.", 'info');
    }
    lastPersonDetectionState = currentPersonDetectionState;
}

/**
 * Starts the continuous prediction loop for vision models.
 * Draws video frame to canvas and runs AI detection at intervals.
 */
function startPredictionLoop() {
    // Pause the loop if AI is deactivated
    if (!isAIActive) {
        requestAnimationFrame(startPredictionLoop);
        return;
    }

    if (!video || !ageModel || !fireCookingModel || !foodModel || !ctx) {
        console.warn("Models, video, or canvas not ready for prediction loop. Retrying...");
        requestAnimationFrame(startPredictionLoop);
        return;
    }

    ctx.drawImage(video, 0, 0, overlayCanvas.width, overlayCanvas.height);

    const currentTime = performance.now();
    if (currentTime - lastAIDetectionTime >= AI_DETECTION_INTERVAL) {
        lastAIDetectionTime = currentTime;
        detectObjectsInFrame();
    }

    requestAnimationFrame(startPredictionLoop);
}

// --- Backend Communication Functions ---

async function sendCommand(command) {
    // Special handling for 'start cooking' command to check fire status
    if (command.toLowerCase() === 'start cooking') {
        if (!fireCookingModel || !video) {
            appendMessage("Cannot start cooking: AI models or video not ready.", 'error');
            speak("Cannot start cooking. System not ready.");
            return { status: 'error', message: 'AI models or video not ready.' };
        }
        
        try {
            // Get current prediction from fireCookingModel
            const fireCookingPredictions = await fireCookingModel.predict(video);
            const sortedPreds = fireCookingPredictions.sort((a, b) => b.probability - a.probability);
            
            if (sortedPreds.length > 0) {
                const topPrediction = sortedPreds[0];
                if (topPrediction.probability > 0.7) {
                    const className = topPrediction.className.toLowerCase();
                    if (!className.includes('cooking flame (safe)') && !className.includes('no flame / idle')) {
                        appendMessage(`Cannot start cooking: Unsafe condition detected - ${topPrediction.className}`, 'error');
                        speak(`Cannot start cooking. Unsafe condition detected: ${topPrediction.className}`);
                        // Send stop cooking command as a safety measure
                        try {
                            const stopResponse = await fetch(`${BACKEND_URL}/api/command`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ command: 'stop cooking' })
                            });
                            const stopData = await stopResponse.json();
                            if (stopData.status === 'success') {
                                appendMessage('Safety measure: Sent stop cooking command.', 'warn');
                            }
                        } catch (err) {
                            console.error('Error sending safety stop command:', err);
                        }
                        return { status: 'error', message: 'Unsafe cooking condition detected.' };
                    }
                }
            }
        } catch (error) {
            console.error('Error checking fire status before cooking:', error);
            appendMessage('Cannot start cooking: Unable to verify fire safety status.', 'error');
            speak('Cannot start cooking. Unable to verify safety status.');
            return { status: 'error', message: 'Unable to verify fire safety status.' };
        }
    }
    
    try {
        const response = await fetch(`${BACKEND_URL}/api/command`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command })
        });
        const data = await response.json();
        if (data.status === "success") {
            appendMessage(`Command "${command}" sent. Backend response: ${data.message}`, 'success');

            // Trigger the corresponding hardware voice command if one exists
            const voiceCode = COMMAND_TO_VOICE_CODE[command.toUpperCase()];
            if (voiceCode && socket) {
                appendMessage(`Triggering hardware voice command: ${voiceCode}`, 'info');
                socket.emit('trigger-voice', { code: voiceCode });
            }

        } else {
            appendMessage(`Failed to send command "${command}": ${data.error || 'Unknown error'}`, 'error');
        }
        return data; // Return data so calling function can decide how to proceed
    } catch (error) {
        console.error('Error sending command to backend:', error);
        appendMessage('Failed to send command to backend.', 'error');
        return { status: 'error', message: 'Network error or backend unreachable.' };
    }
}

async function sendAgeVerificationToBackend(status, age) {
    try {
        const response = await fetch(`${BACKEND_URL}/api/verify_age`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status, age })
        });
        const data = await response.json();
    } catch (error) {
        console.error('Error sending age verification to backend:', error);
        appendMessage('Failed to update age verification status on backend.', 'error');
    }
}

async function sendCookingFireStatusToBackend(status) {
    try {
        const response = await fetch(`${BACKEND_URL}/api/cooking_fire_status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookingStatus: status })
        });
        const data = await response.json();
    } catch (error) {
        console.error('Error sending cooking/fire status to backend:', error);
        appendMessage('Failed to update cooking/fire status on backend.', 'error');
    }
}

async function sendFoodDetectionToBackend(food) {
    try {
        const response = await fetch(`${BACKEND_URL}/api/food_detected`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ detectedFood: food })
        });
        const data = await response.json();
    } catch (error) {
        console.error('Error sending food detection to backend:', error);
        appendMessage('Failed to update food detection status on backend.', 'error');
    }
}

// --- Socket.IO Initialization ---
function initSocketIO() {
    socket = io(BACKEND_URL);

    socket.on('connect', () => {
        appendMessage('Connected to backend via WebSocket.', 'success');
        // Initial "System online." message is handled by initBlynk on backend
    });

    socket.on('system_update', (data) => {
        const oldSystemData = { ...systemData }; // Capture old state for comparison
        systemData = data; // Update local system state with backend's single source of truth

        // Update UI elements
        systemStatusElem.textContent = systemData.systemState;
        verificationStatusElem.textContent = systemData.verificationStatus;
        detectedAgeElem.textContent = systemData.userAge;
        gasLevelElem.textContent = `${systemData.gasLevel} ppm`;
        valveStateElem.textContent = systemData.valveState ? 'Open' : 'Closed';
        cookingStatusElem.textContent = systemData.currentCookingFireStatus;
        foodPreparedElem.textContent = systemData.foodBeingPrepared;

        // Voice responses based on state changes (prevent redundant speaking)
        if (systemData.systemState !== oldSystemData.systemState) {
            switch (systemData.systemState) {
                case "ACTIVE":
                    if (oldSystemData.systemState === "SLEEP") {
                        speak("System activated. How can I assist you?");
                    }
                    else if (oldSystemData.systemState.includes("SAFETY_ALERT")) speak("Safety conditions normalized. System is now active.");
                    else speak("System is active."); // Generic active confirmation
                    break;
                case "SLEEP":
                    speak("System entering sleep mode. Goodbye.");
                    // When system enters sleep, explicitly stop voice control on frontend
                    if (voiceListeningMode !== 'OFF') {
                        stopVoiceControl(); // This will also update UI for OFF mode
                    }
                    break;
                case "COOKING_ACTIVE":
                    // If system wasn't already in cooking state
                    if (oldSystemData.systemState !== "COOKING_ACTIVE" && oldSystemData.systemState !== "COOKING_BOILING") {
                        speak("Cooking mode active.");
                    }
                    break;
                case "COOKING_BOILING":
                    if (oldSystemData.systemState !== "COOKING_BOILING" && oldSystemData.systemState !== "COOKING_ACTIVE") {
                        speak("Boiling water mode active.");
                    }
                    break;
                case "SAFETY_ALERT_GAS":
                    if (oldSystemData.systemState !== "SAFETY_ALERT_GAS") speak("Warning! Gas leak detected. Valve closed.");
                    break;
                case "SAFETY_ALERT_FIRE":
                    if (oldSystemData.systemState !== "SAFETY_ALERT_FIRE") speak("Critical! Fire detected. Valve closed. Emergency measures engaged.");
                    break;
                case "SAFETY_ALERT_USER":
                    if (oldSystemData.systemState !== "SAFETY_ALERT_USER") speak("Unauthorized user detected. Access denied. Valve closed.");
                    break;
                case "SAFETY_ALERT_EMERGENCY":
                    if (oldSystemData.systemState !== "SAFETY_ALERT_EMERGENCY") speak("Emergency stop activated. All systems offline.");
                    break;
                // Add more cases for other states if needed
            }
            lastSpokenSystemState = systemData.systemState; // Update last spoken state
        }

        // Voice responses for valve state changes (only if not due to a safety alert causing a systemState change)
        if (systemData.valveState !== oldSystemData.valveState && !systemData.systemState.startsWith("SAFETY_ALERT") && !oldSystemData.systemState.startsWith("SAFETY_ALERT")) {
            if (systemData.valveState) {
                speak("Gas valve is now open.");
            } else {
                speak("Gas valve is now closed.");
            }
            lastSpokenValveState = systemData.valveState;
        }

        // Voice responses for verification status changes
        if (systemData.verificationStatus !== oldSystemData.verificationStatus) {
            if (systemData.verificationStatus === "VERIFIED") {
                if (systemData.userAge === "ADULT" && oldSystemData.userAge !== "ADULT") {
                    speak("User verified as adult. Access granted.");
                } else if (systemData.userAge === "CHILD" && oldSystemData.userAge !== "CHILD") {
                    speak("Child detected. Access denied. Please ensure an adult is present.");
                }
            } else if (systemData.verificationStatus === "PENDING" && oldSystemData.verificationStatus !== "PENDING") {
                // No speak for pending, as per requirement
            }
            lastSpokenVerificationStatus = systemData.verificationStatus;
        }

        // Voice responses for cooking/fire status (excluding FIRE_OUTBREAK which is critical and handled above)
        if (systemData.currentCookingFireStatus !== oldSystemData.currentCookingFireStatus && systemData.currentCookingFireStatus !== "FIRE_OUTBREAK") {
            switch (systemData.currentCookingFireStatus) {
                case "COOKING_SAFE":
                    if (oldSystemData.currentCookingFireStatus !== "COOKING_SAFE") {
                        // speak("Safe cooking flame detected."); // Optional: if you want voice for this
                    }
                    break;
                case "IDLE":
                    if (oldSystemData.currentCookingFireStatus !== "IDLE") {
                        // speak("Stove is now idle."); // Optional: if you want voice for this
                    }
                    break;
            }
            lastSpokenCookingStatus = systemData.currentCookingFireStatus;
        }

        // Update UI class styling
        systemStatusElem.classList.remove('text-green-400', 'text-yellow-400', 'text-red-400', 'text-blue-400');
        if (systemData.systemState === "ACTIVE" || systemData.systemState.includes("COOKING")) {
            systemStatusElem.classList.add('text-green-400');
        } else if (systemData.systemState === "SLEEP") {
            systemStatusElem.classList.add('text-blue-400');
        } else if (systemData.systemState.includes("SAFETY_ALERT")) {
            systemStatusElem.classList.add('text-red-400');
        } else {
            systemStatusElem.classList.add('text-yellow-400');
        }

        if (systemData.currentCookingFireStatus === "FIRE_OUTBREAK") {
            cookingStatusElem.classList.add('text-red-400', 'font-bold');
            cookingStatusElem.classList.remove('text-green-400', 'text-gray-400');
        } else if (systemData.currentCookingFireStatus === "COOKING_SAFE") {
            cookingStatusElem.classList.add('text-green-400');
            cookingStatusElem.classList.remove('text-red-400', 'text-gray-400', 'font-bold');
        } else {
            cookingStatusElem.classList.add('text-gray-400');
            cookingStatusElem.classList.remove('text-green-400', 'text-red-400', 'font-bold');
        }

        valveStateElem.classList.remove('text-green-400', 'text-red-400');
        if (systemData.valveState) {
            valveStateElem.classList.add('text-green-400');
        } else {
            valveStateElem.classList.add('text-red-400');
        }

        verificationStatusElem.classList.remove('text-green-400', 'text-yellow-400', 'text-red-400');
        if (systemData.verificationStatus === "VERIFIED") {
            if (systemData.userAge === "ADULT") {
                verificationStatusElem.classList.add('text-green-400');
            } else if (systemData.userAge === "CHILD") {
                verificationStatusElem.classList.add('text-red-400');
            } else {
                verificationStatusElem.classList.add('text-yellow-400');
            }
        } else {
            verificationStatusElem.classList.add('text-yellow-400');
        }
    });

    socket.on('disconnect', () => {
        appendMessage('Disconnected from backend.', 'warn');
    });

    socket.on('error', (error) => {
        appendMessage(`Socket error: ${error}`, 'error');
        console.error('Socket error:', error);
    });
}

// --- Voice Command Processing ---

/**
 * Processes recognized voice commands and executes appropriate actions.
 * @param {string} transcript - The recognized speech text
 */
async function processVoiceCommand(transcript) {
    const command = transcript.toLowerCase().trim();
    lastCommandElem.textContent = transcript;
    appendMessage(`Processing voice command: "${transcript}"`);

    // Check for wake word first
    if (command.includes(WAKE_WORD.toLowerCase())) {
        appendMessage(`Wake word "${WAKE_WORD}" detected!`, 'success');

        // Clear any existing command window timeout
        clearTimeout(commandWindowTimeout);

        // Transition to command mode via startVoiceControl, and await its completion
        await speak("Listening for your command."); // Speak first
        await startVoiceControl('COMMAND_MODE'); // Then transition recognition

        // Set the command window timeout after entering command mode
        commandWindowTimeout = setTimeout(async () => {
            if (voiceListeningMode === 'COMMAND_MODE') {
                appendMessage("Command window timeout. Returning to wake word mode.", 'info');
                await speak("Command timeout. I'm listening for the wake word again.");
                startVoiceControl('WAKE_WORD_MODE');
            }
        }, COMMAND_WINDOW_DURATION);

        return; // Don't process as a regular command
    }

    // Process actual commands (only if in COMMAND_MODE)
    if (voiceListeningMode !== 'COMMAND_MODE') {
        appendMessage(`Ignoring command "${transcript}" as not in COMMAND_MODE.`, 'info');
        return; // Ignore commands if not in command mode or if wake word wasn't heard
    }

    // Clear command window timeout since we received a command
    clearTimeout(commandWindowTimeout);

    let commandProcessed = false;

    // System control commands
    if (command.includes('activate') || command.includes('turn on') || command.includes('wake up')) {
        await sendCommand('ACTIVATE_SYSTEM');
        commandProcessed = true;
    }
    else if (command.includes('sleep') || command.includes('deactivate') || command.includes('turn off')) {
        await sendCommand('DEACTIVATE_SYSTEM');
        commandProcessed = true;
    }
    else if (command.includes('start cooking') || command.includes('begin cooking')) {
        await sendCommand('START_COOKING');
        commandProcessed = true;
    }
    else if (command.includes('stop cooking') || command.includes('end cooking')) {
        await sendCommand('STOP_COOKING');
        commandProcessed = true;
    }
    else if (command.includes('boil water') || command.includes('start boiling')) {
        await sendCommand('BOIL_WATER');
        commandProcessed = true;
    }
    else if (command.includes('emergency stop') || command.includes('emergency') || command.includes('stop everything')) {
        await sendCommand('EMERGENCY_STOP');
        commandProcessed = true;
    }
    else if (command.includes('open valve') || command.includes('open gas')) {
        await sendCommand('OPEN_VALVE');
        commandProcessed = true;
    }
    else if (command.includes('close valve') || command.includes('close gas')) {
        await sendCommand('CLOSE_VALVE');
        commandProcessed = true;
    }
    else if (command.includes('status') || command.includes('what is') || command.includes('tell me')) {
        // Status inquiry
        let statusMessage = `System is ${systemData.systemState}. `;
        statusMessage += `Gas valve is ${systemData.valveState ? 'open' : 'closed'}. `;
        statusMessage += `Gas level is ${systemData.gasLevel} ppm. `;
        if (systemData.userAge !== "UNKNOWN") {
            statusMessage += `User verified as ${systemData.userAge}. `;
        }
        if (systemData.currentCookingFireStatus !== "IDLE") {
            statusMessage += `Cooking status: ${systemData.currentCookingFireStatus}. `;
        }
        if (systemData.foodBeingPrepared && systemData.foodBeingPrepared !== "Not Cooking") {
            statusMessage += `Food detected: ${systemData.foodBeingPrepared}.`;
        }
        await speak(statusMessage);
        commandProcessed = true;
    }

    if (!commandProcessed) {
        appendMessage(`Unknown command: "${transcript}"`, 'warn');
        await speak("I didn't understand that command. Please try again.");
    }

    // Always return to wake word listening mode after processing a command.
    // A small delay ensures any spoken response can finish.
    appendMessage("Returning to wake word listening mode.", 'info');
    setTimeout(() => {
        startVoiceControl('WAKE_WORD_MODE');
    }, 1500);
}

// --- Event Listeners and Initialization ---

/**
 * Sets up all event listeners for manual control buttons and voice control.
 */
function setupEventListeners() {
    // Manual control buttons
    startCookingBtn.addEventListener('click', () => sendCommand('START_COOKING'));
    stopCookingBtn.addEventListener('click', () => sendCommand('STOP_COOKING'));
    boilWaterBtn.addEventListener('click', () => sendCommand('BOIL_WATER'));
    emergencyStopBtn.addEventListener('click', () => sendCommand('EMERGENCY_STOP'));



    // Voice control button
    voiceControlBtn.addEventListener('click', () => {
        if (voiceListeningMode === 'OFF') {
            startVoiceControl('WAKE_WORD_MODE');
        } else {
            stopVoiceControl();
        }
    });
}



/**
 * Main system initialization function.
 * Sets up DOM elements, camera, models, speech recognition, and socket connection.
 */
async function initSystem() {
    appendMessage("Starting system initialization...");

    // Get DOM elements with error checking
    video = document.getElementById('video');
    overlayCanvas = document.getElementById('overlay-canvas');
    
    // Check if critical elements exist
    if (!video) {
        appendMessage("Error: Video element not found. Please ensure your HTML has a video element with id='video'", 'error');
        return;
    }
    
    if (!overlayCanvas) {
        appendMessage("Error: Overlay canvas element not found. Please ensure your HTML has a canvas element with id='overlay-canvas'", 'error');
        return;
    }
    
    ctx = overlayCanvas.getContext('2d');
    if (!ctx) {
        appendMessage("Error: Could not get 2D context from overlay canvas", 'error');
        return;
    }

    systemStatusElem = document.getElementById('system-status');
    verificationStatusElem = document.getElementById('verification-status');
    detectedAgeElem = document.getElementById('detected-age');
    gasLevelElem = document.getElementById('gas-level');
    valveStateElem = document.getElementById('valve-state');
    voiceStatusElem = document.getElementById('voice-status');
    lastCommandElem = document.getElementById('last-command');
    voiceControlBtn = document.getElementById('voice-control-btn');
    messagesDiv = document.getElementById('messages');
    foodPreparedElem = document.getElementById('food-prepared');
    cookingStatusElem = document.getElementById('cooking-status');

    // Manual control buttons
    startCookingBtn = document.getElementById('start-cooking-btn');
    const aiControlBtn = document.getElementById('ai-control-btn');
    if (aiControlBtn) {
        isAIActive = aiControlBtn.dataset.initialState === 'true';

        const updateAIButtonUI = () => {
            if (isAIActive) {
                aiControlBtn.textContent = 'Deactivate AI';
                aiControlBtn.className = aiControlBtn.className.replace(/bg-gray-600|hover:bg-gray-700/g, 'bg-teal-600 hover:bg-teal-700');
            } else {
                aiControlBtn.textContent = 'Activate AI';
                aiControlBtn.className = aiControlBtn.className.replace(/bg-teal-600|hover:bg-teal-700/g, 'bg-gray-600 hover:bg-gray-700');
            }
        };

        aiControlBtn.addEventListener('click', () => {
            if (isAIActive) {
                const password = prompt('Please enter the password to deactivate the AI:');
                if (password === '123') {
                    isAIActive = false;
                    appendMessage('AI models have been deactivated.', 'warn');
                    updateUIAfterDetection({ age: 'N/A', fireStatus: 'N/A', food: 'N/A' });
                } else if (password) {
                    appendMessage('Incorrect password. AI remains active.', 'error');
                }
            } else {
                isAIActive = true;
                appendMessage('AI models have been activated.', 'success');
            }
            updateAIButtonUI();
        });
    }
    stopCookingBtn = document.getElementById('stop-cooking-btn');
    boilWaterBtn = document.getElementById('boil-water-btn');
    emergencyStopBtn = document.getElementById('emergency-stop-btn');
    voiceCommandSelect = document.getElementById('voice-command-select');
    sendVoiceCommandBtn = document.getElementById('send-voice-command-btn');

    // Check if essential UI elements exist
    const essentialElements = [
        { elem: systemStatusElem, name: 'system-status' },
        { elem: voiceControlBtn, name: 'voice-control-btn' },
        { elem: messagesDiv, name: 'messages' }
    ];

    for (const { elem, name } of essentialElements) {
        if (!elem) {
            appendMessage(`Error: Required element '${name}' not found in HTML`, 'error');
            return;
        }
    }

    // Initialize camera
    const cameraSuccess = await initCamera();
    if (!cameraSuccess) {
        appendMessage("Camera initialization failed. System cannot proceed.", 'error');
        return;
    }

    // Load TensorFlow.js models
    appendMessage("Loading AI models...");
    const modelsLoaded = await loadModels({
        tf: tf, // Pass the global TensorFlow.js object
        AGE_MODEL_PATH,
        FIRE_COOKING_MODEL_PATH,
        FOOD_MODEL_PATH
    });

    if (!modelsLoaded.success) {
        appendMessage(`Model loading failed: ${modelsLoaded.error}`, 'error');
        return;
    }

    // Assign loaded models to global variables
    ageModel = modelsLoaded.ageModel;
    fireCookingModel = modelsLoaded.fireCookingModel;
    foodModel = modelsLoaded.foodModel;
    ageModelMetadata = modelsLoaded.ageModelMetadata;
    fireCookingModelMetadata = modelsLoaded.fireCookingModelMetadata;
    foodModelMetadata = modelsLoaded.foodModelMetadata;

    appendMessage("AI models loaded successfully.", 'success');

    // Start the prediction loop now that models and camera are ready
    appendMessage("Starting AI prediction loop...", 'info');
    startPredictionLoop();

    // Initialize speech recognition
    speechRecognition = initSpeechRecognition(processVoiceCommand);
    if (!speechRecognition) {
        appendMessage("Speech recognition initialization failed.", 'error');
        return;
    }

    // Set up speech recognition event handlers
    speechRecognition.onstart = () => {
        isVoiceRecognitionActive = true;
        appendMessage(`Speech recognition started in ${voiceListeningMode} mode.`, 'info');
        if (voiceListeningMode === 'WAKE_WORD_MODE') {
            voiceStatusElem.textContent = "Voice Active: Listening for 'Kate'...";
            voiceStatusElem.classList.remove('text-yellow-400', 'text-green-400', 'text-red-400');
            voiceStatusElem.classList.add('text-blue-400');
            voiceControlBtn.textContent = "Listening for 'Kate'...";
            voiceControlBtn.disabled = true;
        } else if (voiceListeningMode === 'COMMAND_MODE') {
            voiceStatusElem.textContent = "Voice Active: Listening for Command...";
            voiceStatusElem.classList.remove('text-yellow-400', 'text-blue-400', 'text-red-400');
            voiceStatusElem.classList.add('text-green-400');
            voiceControlBtn.textContent = "Listening for Command...";
            voiceControlBtn.disabled = true;
        }
    };

    speechRecognition.onend = () => {
        isVoiceRecognitionActive = false;
        appendMessage(`Speech recognition ended from ${voiceListeningMode} mode.`, 'info');

        if (resolveRecognitionStopPromise) {
            resolveRecognitionStopPromise();
            resolveRecognitionStopPromise = null;
            return; // Stop was intentional, so don't restart.
        }

        // If recognition ends but the mode is not 'OFF', it was unexpected.
        // Restart it to ensure continuous listening.
        if (voiceListeningMode !== 'OFF') {
            appendMessage(`Unexpected stop in ${voiceListeningMode}. Restarting...`, 'warn');
            try {
                speechRecognition.start();
            } catch (e) {
                console.error("Error restarting speech recognition onend:", e);
                // If restart fails, go to a safe OFF state.
                stopVoiceControl();
            }
        }
    };

    speechRecognition.onerror = (event) => {
        console.error("Speech recognition error:", event.error);
        appendMessage(`Speech recognition error: ${event.error}`, 'error');
        
        // Handle specific error cases
        if (event.error === 'aborted' || event.error === 'not-allowed') {
            // User denied permission or aborted - force stop
            stopVoiceControl();
        } else if (event.error === 'network') {
            appendMessage("Network error in speech recognition. Retrying...", 'warn');
            // Attempt to restart if we were expecting to be active
            if (voiceListeningMode !== 'OFF') {
                setTimeout(() => {
                    startVoiceControl(voiceListeningMode);
                }, 2000);
            }
        } else if (event.error === 'audio-capture') {
            appendMessage("No microphone found or audio capture failed. Please check your microphone.", 'error');
            stopVoiceControl(); // Cannot proceed without audio
        } else if (event.error === 'no-speech') {
            appendMessage("No speech detected. Please speak clearly.", 'warn');
            // The onend handler will now automatically restart the service, so no specific action is needed here.
            // The browser will fire 'onend' after a 'no-speech' error.
        } else if (event.error === 'bad-grammar' || event.error === 'language-not-supported') {
            appendMessage(`Recognition error: ${event.error}. Please speak clearly.`, 'warn');
            // Revert to wake word mode after such errors in command mode
            if (voiceListeningMode === 'COMMAND_MODE') {
                setTimeout(() => {
                    speak("I couldn't understand that. Returning to wake word mode.");
                    startVoiceControl('WAKE_WORD_MODE');
                }, 500);
            }
        }
    };

    // Initialize Socket.IO connection
    initSocketIO();

    // Attach listeners to all buttons
    attachButtonListeners();

    // Initialize the hardware test panel
    initHardwareTestPanel();

    // Start the prediction loop
    startPredictionLoop();

    // Final message to user
    appendMessage("Smart Gas Stove Control System is ready.", 'success');
}

/**
 * Initializes the hardware test panel.
 * Populates the voice command dropdown and sets up the send button listener.
 */
function initHardwareTestPanel() {
    const voiceCommands = {
        1: "boil water acknowledged",
        2: "burner was not ignited",
        3: "gas concentration level normal",
        4: "gas is supplied ignite gas",
        5: "gas leak detected",
        6: "greetings",
        7: "hi good evening would you like to cook",
        8: "hi good morning what would you like to cook",
        9: "hi good morning would you like to cook",
        10: "hi my name is kate",
        11: "how long is the warming",
        12: "i’m here what would you like me to do.",
        13: "i’m not allowed to comply",
        14: "is your meal on the burner now",
        15: "is your meal still on the burner",
        16: "is your water on the burner now",
        17: "is your water still on the burner",
        18: "kindly choose a time stamp",
        19: "meal will be ready in 15 minutes",
        20: "meal will be ready in 5 minutes",
        21: "okay great i will be on standby if you need me.",
        22: "open flame detected, please extinguish.",
        23: "please choose your timestamp",
        24: "remaining time is would you like me to turn your burner now?",
        25: "shutdown command initiated.",
        26: "smoke detected",
        27: "user's face not recognized.",
        28: "warn caution",
        29: "warn time adjust",
        30: "warm water is ready",
        31: "warm water will be ready in 2 minutes",
        32: "what will you like to do?",
        33: "is your water still on the burner",
        34: "your water is now boiling",
        35: "please your time stamp",
        36: "is your meal still on the burner",
        37: "do you want it warm or boiled.",
        38: "warm water is ready",
        39: "meal will be ready in 5 minutes",
        40: "user’s face not recognized",
        41: "warm water will be ready in 2 minutes",
        42: "would you like to continue with the warm?",
        43: "would you like to continue with boiling water?",
        44: "the remaining time is ... would you like me to turn off the burner now?",
        45: "is your meal on the burner now?",
        46: "burner was not ignited",
        47: "Is your water on the burner now?",
        48: "meal will be ready in two minutes",
        49: "your boiled water is ready",
        50: "what would you like to do",
        51: "your meal is ready now",
        52: "kindly choose a timestamp from 4mins to 15mins",
        53: "how long is the warming",
        54: "okay great i will be on standby",
        55: "Hi good afternoon would you like to cook?",
        56: "warm time adjust",
        57: "Hi good morning would like to cook",
        58: "burner was not ignited gas concentration level is currently high",
        59: "smoke detected",
        60: "gas leak detected",
        61: "warm caution",
        62: "am not allowed to comply to that command",
        63: "is your meal on the burner now",
        64: "your meal is ready now",
        65: "your water is now boiling",
        66: "your boiled water is ready",
        67: "your warm water is ready",
        68: "meal will be ready in two minutes",
        69: "warm water will be ready in two minutes",
        70: "okay great i will be on standby if you need me",
        71: "shutdown command initiated",
        72: "gas is supplied ignite gas",
        73: "hi good morning would you like to cook",
        74: "hi good afternoon would you like to cook",
        75: "hi good evening would you like to cook",
        76: "i am here what would you like to do",
        77: "is your water on the burner now",
        78: "is your meal on the burner now",
        79: "is your water still on the burner",
        80: "is your meal still on the burner",
        81: "do you want it warm or boiled",
        82: "kindly choose a timestamp from 4mins to 15mins",
        83: "how long is the warming",
        84: "warm time adjust",
        85: "the remaining time is ... would you like me to turn off the burner now",
        86: "would you like to continue with boiling water",
        87: "would you like to continue with the warm",
        88: "burner was not ignited",
        89: "user’s face not recognized",
        90: "open flame detected please extinguish",
        91: "gas leak detected",
        92: "smoke detected",
        93: "gas concentration level normal",
        94: "greetings",
        95: "hi my name is kate",
        96: "i’m not allowed to comply",
        97: "please choose your timestamp",
        98: "meal will be ready in 5 minutes",
        99: "meal will be ready in 15 minutes",
        100: "warm water is ready",
        101: "boil water acknowledged",
    };

    if (!voiceCommandSelect || !sendVoiceCommandBtn) return;

    // Populate the dropdown
    for (const [code, text] of Object.entries(voiceCommands)) {
        const option = document.createElement('option');
        option.value = code;
        option.textContent = `${code}: ${text}`;
        voiceCommandSelect.appendChild(option);
    }

    // Add event listener to the send button
    sendVoiceCommandBtn.addEventListener('click', () => {
        const commandCode = voiceCommandSelect.value;
        if (commandCode && socket) {
            appendMessage(`Sending test command: ${commandCode}`, 'info');
            socket.emit('trigger-voice', commandCode);
        }
    });
}

/**
 * Attaches event listeners to all interactive UI buttons.
 * This function is called from within initSystem to ensure elements are present.
 */
function attachButtonListeners() {
    if (!startCookingBtn || !stopCookingBtn || !boilWaterBtn || !emergencyStopBtn || !voiceControlBtn) {
        appendMessage("One or more control buttons not found in the DOM.", 'error');
        return;
    }

    startCookingBtn.addEventListener('click', () => sendCommand('START_COOKING'));
    stopCookingBtn.addEventListener('click', () => sendCommand('STOP_COOKING'));
    boilWaterBtn.addEventListener('click', () => sendCommand('BOIL_WATER'));
    emergencyStopBtn.addEventListener('click', () => sendCommand('EMERGENCY_STOP'));

    // Voice control button
    voiceControlBtn.addEventListener('click', () => {
        if (voiceListeningMode === 'OFF') {
            startVoiceControl('WAKE_WORD_MODE');
        } else {
            stopVoiceControl();
        }
    });
}

// --- Document Ready ---
// This is the entry point. It ensures the DOM is fully loaded before running the script.
document.addEventListener('DOMContentLoaded', initSystem);