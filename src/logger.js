const { AsyncLocalStorage } = require('async_hooks');
const config = require('./config.js');

// Keys whose values must never reach the logs.
const SENSITIVE_KEY = /^(password|token|jwt|authorization|apikey|api_key|secret)$/i;
// Any JWT-looking string, wherever it appears.
const JWT_PATTERN = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const MASK = '*****';

class Logger {
  constructor() {
    // Remembers which request we are in, so DB and factory logs can find the user
    // without the rest of the code having to pass `req` around.
    this.requestContext = new AsyncLocalStorage();
  }

  // Express middleware: logs every HTTP request/response and sets up the request context.
  httpLogger = (req, res, next) => {
    this.requestContext.run({ req }, () => {
      const send = res.send;
      res.send = (resBody) => {
        res.send = send;
        this.log(this.statusToLogLevel(res.statusCode), 'http', {
          method: req.method,
          path: req.originalUrl,
          statusCode: res.statusCode,
          authorized: !!req.headers.authorization,
          reqBody: req.body,
          resBody: this.parseBody(resBody),
        });
        return res.send(resBody);
      };
      next();
    });
  };

  // Called from DB.query. Only the SQL text is logged; params can hold hashes and emails.
  dbLogger(sql) {
    this.log('info', 'db', { sql });
  }

  // Called after each pizza factory request.
  factoryLogger(reqBody, resBody, ok) {
    this.log(ok ? 'info' : 'error', 'factory', { reqBody, resBody });
  }

  // Express error middleware: logs the exception, then lets the existing handler respond.
  errorLogger = (err, req, res, next) => {
    this.log('error', 'exception', {
      method: req.method,
      path: req.originalUrl,
      statusCode: err.statusCode ?? 500,
      message: err.message,
      stack: err.stack,
    });
    next(err);
  };

  log(level, type, logData) {
    const entry = this.sanitize({ ...logData, userId: this.currentUserId() });
    const labels = { component: this.settings().source, level, type };
    const event = { streams: [{ stream: labels, values: [[this.nowString(), JSON.stringify(entry)]] }] };
    return this.sendLogToGrafana(event);
  }

  currentUserId() {
    return this.requestContext.getStore()?.req.user?.id;
  }

  statusToLogLevel(statusCode) {
    if (statusCode >= 500) return 'error';
    if (statusCode >= 400) return 'warn';
    return 'info';
  }

  nowString() {
    return (Date.now() * 1000000).toString();
  }

  // res.json hands res.send a JSON string; turn it back into an object so it can be sanitized.
  parseBody(body) {
    if (typeof body !== 'string') return body;
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }

  // Returns a deep copy with secrets masked.
  sanitize(value) {
    if (typeof value === 'string') return value.replace(JWT_PATTERN, MASK);
    if (Array.isArray(value)) return value.map((v) => this.sanitize(v));
    if (value && typeof value === 'object') {
      const clean = {};
      for (const [key, v] of Object.entries(value)) {
        clean[key] = SENSITIVE_KEY.test(key) ? MASK : this.sanitize(v);
      }
      return clean;
    }
    return value;
  }

  settings() {
    return config.logging ?? {};
  }

  sendLogToGrafana(event) {
    const { endpointUrl, accountId, apiKey } = this.settings();
    if (process.env.NODE_ENV === 'test' || !endpointUrl) return Promise.resolve();

    return fetch(endpointUrl, {
      method: 'POST',
      body: JSON.stringify(event),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accountId}:${apiKey}` },
    })
      .then((res) => {
        if (!res.ok) console.log(`Failed to send log to Grafana: ${res.status}`);
      })
      .catch((error) => console.log('Failed to send log to Grafana:', error.message));
  }
}

const logger = new Logger();

// Exceptions that escape Express entirely. Log them, then exit like Node would by default.
if (process.env.NODE_ENV !== 'test') {
  const logAndExit = (err) => {
    console.error(err);
    logger.log('error', 'exception', { message: err?.message ?? String(err), stack: err?.stack }).finally(() => process.exit(1));
  };
  process.on('uncaughtException', logAndExit);
  process.on('unhandledRejection', logAndExit);
}

module.exports = logger;
