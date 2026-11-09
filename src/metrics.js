const os = require('os');
const config = require('./config');

// Metrics stored in memory
const requests = { GET: 0, PUT: 0, POST: 0, DELETE: 0 };
const activeUsers = new Map();
let authSuccess = 0;
let authFailure = 0;
let pizzasSold = 0;
let pizzaFailures = 0;
let revenue = 0;
let requestLatencyTotal = 0;
let requestCount = 0;
let pizzaLatencyTotal = 0;
let pizzaCount = 0;

// Function to track when a pizza is purchased
function pizzaPurchase(success, latency, count, price) {
  pizzaLatencyTotal += latency;
  pizzaCount++;
  if (success) {
    pizzasSold += count;
    revenue += price;
  } else {
    pizzaFailures++;
  }
}

// Middleware to track requests, latency, active users, and auth attempts
function requestTracker(req, res, next) {
  const start = Date.now();
  if (requests[req.method] !== undefined) {
    requests[req.method]++;
  }
  if (req.user) {
    activeUsers.set(req.user.id, start);
  }

  res.on('finish', () => {
    requestLatencyTotal += Date.now() - start;
    requestCount++;

    if (req.originalUrl.startsWith('/api/auth')) {
      if (req.method === 'PUT' || req.method === 'POST') {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          authSuccess++;
        } else {
          authFailure++;
        }
      } else if (req.method === 'DELETE' && req.user) {
        activeUsers.delete(req.user.id);
      }
    }
  });

  next();
}

// System metrics
function getCpuUsagePercentage() {
  const cpuUsage = os.loadavg()[0] / os.cpus().length;
  return Number((cpuUsage * 100).toFixed(2));
}

function getMemoryUsagePercentage() {
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = totalMemory - freeMemory;
  const memoryUsage = (usedMemory / totalMemory) * 100;
  return Number(memoryUsage.toFixed(2));
}

// Users seen in the last 5 minutes
function getActiveUserCount() {
  const cutoff = Date.now() - 5 * 60 * 1000;
  activeUsers.forEach((lastSeen, id) => {
    if (lastSeen < cutoff) {
      activeUsers.delete(id);
    }
  });
  return activeUsers.size;
}

// Collect all the metrics to send
function buildMetrics() {
  const metrics = [];

  let total = 0;
  Object.keys(requests).forEach((method) => {
    total += requests[method];
    metrics.push(createMetric('http_requests', requests[method], '1', 'sum', 'asInt', { method }));
  });
  metrics.push(createMetric('http_requests', total, '1', 'sum', 'asInt', { method: 'ALL' }));

  metrics.push(createMetric('active_users', getActiveUserCount(), '1', 'gauge', 'asInt', {}));

  metrics.push(createMetric('auth_attempts', authSuccess, '1', 'sum', 'asInt', { status: 'success' }));
  metrics.push(createMetric('auth_attempts', authFailure, '1', 'sum', 'asInt', { status: 'failure' }));

  metrics.push(createMetric('cpu_usage', getCpuUsagePercentage(), '%', 'gauge', 'asDouble', {}));
  metrics.push(createMetric('memory_usage', getMemoryUsagePercentage(), '%', 'gauge', 'asDouble', {}));

  metrics.push(createMetric('pizzas_sold', pizzasSold, '1', 'sum', 'asInt', {}));
  metrics.push(createMetric('pizza_failures', pizzaFailures, '1', 'sum', 'asInt', {}));
  metrics.push(createMetric('pizza_revenue', revenue, 'BTC', 'sum', 'asDouble', {}));

  // Latency is the average since the last send
  if (requestCount > 0) {
    metrics.push(createMetric('latency', requestLatencyTotal / requestCount, 'ms', 'gauge', 'asDouble', { type: 'endpoint' }));
    requestLatencyTotal = 0;
    requestCount = 0;
  }
  if (pizzaCount > 0) {
    metrics.push(createMetric('latency', pizzaLatencyTotal / pizzaCount, 'ms', 'gauge', 'asDouble', { type: 'pizza_creation' }));
    pizzaLatencyTotal = 0;
    pizzaCount = 0;
  }

  return metrics;
}

// Periodically send metrics to Grafana (not during tests)
if (process.env.NODE_ENV !== 'test') {
  setInterval(() => {
    sendMetricToGrafana(buildMetrics());
  }, 10000).unref();
}

function createMetric(metricName, metricValue, metricUnit, metricType, valueType, attributes) {
  attributes = { ...attributes, source: config.metrics.source };

  const metric = {
    name: metricName,
    unit: metricUnit,
    [metricType]: {
      dataPoints: [
        {
          [valueType]: metricValue,
          timeUnixNano: Date.now() * 1000000,
          attributes: [],
        },
      ],
    },
  };

  Object.keys(attributes).forEach((key) => {
    metric[metricType].dataPoints[0].attributes.push({
      key: key,
      value: { stringValue: attributes[key] },
    });
  });

  if (metricType === 'sum') {
    metric[metricType].aggregationTemporality = 'AGGREGATION_TEMPORALITY_CUMULATIVE';
    metric[metricType].isMonotonic = true;
  }

  return metric;
}

function sendMetricToGrafana(metrics) {
  const body = {
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics,
          },
        ],
      },
    ],
  };

  return fetch(`${config.metrics.endpointUrl}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${config.metrics.accountId}:${config.metrics.apiKey}`, 'Content-Type': 'application/json' },
  })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`HTTP status: ${response.status}`);
      }
    })
    .catch((error) => {
      console.error('Error pushing metrics:', error);
    });
}

module.exports = { requestTracker, pizzaPurchase, buildMetrics, sendMetricToGrafana };
