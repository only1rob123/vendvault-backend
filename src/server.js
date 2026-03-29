require('dotenv').config();
const app = require('./app');
const { getDb } = require('./db/database');
const { startPoller } = require('./services/emailPoller');

const PORT = process.env.PORT || 3001;

// Initialize DB on startup
getDb();

app.listen(PORT, () => {
  console.log(`VendVault API running on http://localhost:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);

  // Start email auto-import poller if configured
  startPoller();
});
