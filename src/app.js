const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:4173',
  ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : []),
];
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/locations', require('./routes/locations'));
app.use('/api/machines', require('./routes/machines'));
app.use('/api/products', require('./routes/products'));
app.use('/api/slots', require('./routes/slots'));
app.use('/api/sales', require('./routes/sales'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/imports', require('./routes/imports'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/finance', require('./routes/finance'));
app.use('/api/purchases', require('./routes/purchases'));
app.use('/api/email-poller', require('./routes/emailPoller'));
app.use('/api/delivery-runs', require('./routes/deliveryRuns'));

app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '1.0.0' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

module.exports = app;
