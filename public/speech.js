// speech.js
// Handles all Web Speech API logic and voice state management

export function initSpeechRecognition(onResultCallback) {
  if (!('webkitSpeechRecognition' in window)) {
    // UI feedback for this case should be handled by the caller in main.js
    console.error("Web Speech API is not supported by this browser. Voice commands disabled.");
    return null;
  }

  const speechRecognition = new webkitSpeechRecognition();
  speechRecognition.interimResults = false; // We want final results, not intermediate ones
  speechRecognition.lang = 'en-US';

  // The 'onresult' handler processes the speech and calls the provided callback.
  speechRecognition.onresult = (event) => {
    const last = event.results.length - 1;
    const transcript = event.results[last][0].transcript.trim().toLowerCase();

    if (onResultCallback) {
      onResultCallback(transcript);
    }
  };

  // Other event handlers (onstart, onend, onerror) are attached in main.js
  // This allows them to access the main application's state and UI elements.

  return speechRecognition;
}
