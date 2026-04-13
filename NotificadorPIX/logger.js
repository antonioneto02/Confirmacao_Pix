const winston = require('winston');
const path = require('path');
const fs = require('fs');

const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

const format = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`)
);

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format,
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({
            filename: path.join(logsDir, 'app.log'),
            maxsize: 5 * 1024 * 1024, // 5 MB
            maxFiles: 5,
            tailable: true,
        }),
    ],
});

module.exports = logger;
