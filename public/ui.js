// ui.js
// Handles DOM updates and UI feedback

export function appendMessage(text, type = 'info') {
  const messagesDiv = document.getElementById('messages');
  if (!messagesDiv) {
    console.error("messagesDiv is not yet initialized. Message: ", text);
    return;
  }
  const p = document.createElement('p');
  p.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  p.classList.add('py-0.5');
  if (type === 'error') p.classList.add('text-red-400');
  else if (type === 'warn') p.classList.add('text-yellow-400');
  else if (type === 'success') p.classList.add('text-green-400');
  else p.classList.add('text-blue-300');
  messagesDiv.prepend(p);
  if (messagesDiv.children.length > 20) {
    messagesDiv.removeChild(messagesDiv.lastChild);
  }
}

// Add more UI update utilities as needed
