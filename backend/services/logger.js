'use strict';

/**
 * services/logger.js
 *
 * Thin bridge so AI modules can log consistently without importing app.js
 * (which would create a circular require: app.js → routes → services/ai → app.js).
 *
 * ⚠️ FOLLOW-UP: In a later phase, extract the Winston config from app.js into
 * this file and have app.js `require('../services/logger')` so there is ONE
 * logger. For now, we instantiate a compatible one here.
 */

const winston = require('winston');

const logger = winston.createLogger({
  level: process.env.AI_LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/ai.log' }),
    new winston.transports.Console(),
  ],
});

module.exports = logger;