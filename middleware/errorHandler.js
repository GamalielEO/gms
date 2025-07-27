// middleware/errorHandler.js
// Centralized error handler for Express

module.exports = (err, req, res, next) => {
  console.error('[ERROR]', err);
  res.status(err.status || 500).json({
    status: 'error',
    message: err.message || 'Internal Server Error',
  });
};
