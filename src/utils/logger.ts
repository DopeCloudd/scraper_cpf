import fs from 'node:fs';
import path from 'node:path';
import { createLogger, format, transports } from 'winston';

const logDirectory = path.resolve(process.cwd(), 'logs');
if (!fs.existsSync(logDirectory)) {
  fs.mkdirSync(logDirectory, { recursive: true });
}

const level = process.env.LOG_LEVEL ?? 'info';

export const logger = createLogger({
  level,
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.splat(),
    format.json()
  ),
  transports: [
    new transports.File({ filename: path.join(logDirectory, 'scraper-error.log'), level: 'error' }),
    new transports.File({ filename: path.join(logDirectory, 'scraper-combined.log') }),
  ],
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(
    new transports.Console({
      format: format.combine(format.colorize(), format.simple()),
    })
  );
}
