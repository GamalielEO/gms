// services/blynkService.js
// Handles communication with Blynk API
const fetch = require('node-fetch');

const BLYNK_AUTH = process.env.BLYNK_AUTH;
const BLYNK_SERVER_ADDRESS = process.env.BLYNK_SERVER_ADDRESS;

exports.sendCommand = async (pin, value) => {
  const url = `${BLYNK_SERVER_ADDRESS}/external/api/update?token=${BLYNK_AUTH}&${pin}=${value}`;
  return fetch(url, { method: 'GET' });
};

exports.readStatus = async (pin) => {
  const url = `${BLYNK_SERVER_ADDRESS}/external/api/get?token=${BLYNK_AUTH}&${pin}`;
  const response = await fetch(url);
  return response.json();
};
