const winston = require('winston');

const format = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`)
);

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format,
    transports: [
        new winston.transports.Console(),
    ],
});

module.exports = logger;
