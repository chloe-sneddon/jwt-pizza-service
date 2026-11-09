const { EventEmitter } = require('events');

jest.mock('./src/config.js', () => ({
  metrics: {
    source: 'jwt-pizza-service-test',
    endpointUrl: 'https://grafana.test/otlp/v1/metrics',
    accountId: '123',
    apiKey: 'test-key',
  },
}));

const metrics = require('./src/metrics.js');

function fakeRequest(method, originalUrl, user) {
  const req = { method, originalUrl, user };
  const res = new EventEmitter();
  res.statusCode = 200;
  return { req, res };
}

function track(method, url, { user, status = 200 } = {}) {
  const { req, res } = fakeRequest(method, url, user);
  const next = jest.fn();
  metrics.requestTracker(req, res, next);
  expect(next).toHaveBeenCalled();
  res.statusCode = status;
  res.emit('finish');
}

function find(list, name, attrs = {}) {
  return list.find((m) => {
    if (m.name !== name) return false;
    const point = (m.sum ?? m.gauge).dataPoints[0];
    return Object.entries(attrs).every(([k, v]) => point.attributes.some((a) => a.key === k && a.value.stringValue === v));
  });
}

function value(metric) {
  const point = (metric.sum ?? metric.gauge).dataPoints[0];
  return point.asInt ?? point.asDouble;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('builds all required metrics from tracked activity', () => {
  track('GET', '/api/order/menu', { user: { id: 1 } });
  track('POST', '/api/auth');
  track('PUT', '/api/auth', { status: 404 });
  track('PUT', '/api/auth', { user: { id: 2 } });
  track('DELETE', '/api/auth', { user: { id: 2 } });
  track('PATCH', '/api/other');
  metrics.pizzaPurchase(true, 120, 2, 0.01);
  metrics.pizzaPurchase(false, 300, 21, 0.5);

  const list = metrics.buildMetrics();

  expect(value(find(list, 'http_requests', { method: 'GET' }))).toBe(1);
  expect(value(find(list, 'http_requests', { method: 'PUT' }))).toBe(2);
  expect(value(find(list, 'http_requests', { method: 'POST' }))).toBe(1);
  expect(value(find(list, 'http_requests', { method: 'DELETE' }))).toBe(1);
  expect(value(find(list, 'http_requests', { method: 'ALL' }))).toBe(5);
  expect(value(find(list, 'auth_attempts', { status: 'success' }))).toBe(2);
  expect(value(find(list, 'auth_attempts', { status: 'failure' }))).toBe(1);
  expect(value(find(list, 'active_users'))).toBe(1); // user 2 logged out
  expect(value(find(list, 'pizzas_sold'))).toBe(2);
  expect(value(find(list, 'pizza_failures'))).toBe(1);
  expect(value(find(list, 'pizza_revenue'))).toBeCloseTo(0.01);
  expect(value(find(list, 'latency', { type: 'pizza_creation' }))).toBe(210);
  expect(find(list, 'latency', { type: 'endpoint' })).toBeDefined();
  expect(find(list, 'cpu_usage')).toBeDefined();
  expect(find(list, 'memory_usage')).toBeDefined();
  expect(find(list, 'http_requests', { source: 'jwt-pizza-service-test' }).sum.isMonotonic).toBe(true);

  // latency averages reset after each report
  const next = metrics.buildMetrics();
  expect(find(next, 'latency')).toBeUndefined();
});

test('expires users that have not been seen recently', () => {
  const now = Date.now();
  jest.spyOn(Date, 'now').mockReturnValue(now);
  track('GET', '/api/order', { user: { id: 99 } });
  Date.now.mockReturnValue(now + 10 * 60 * 1000);
  expect(value(find(metrics.buildMetrics(), 'active_users'))).toBe(0);
});

test('sends metrics to Grafana with credentials', async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true });
  await metrics.sendMetricToGrafana([{ name: 'x' }]);
  const [url, options] = global.fetch.mock.calls[0];
  expect(url).toBe('https://grafana.test/otlp/v1/metrics');
  expect(options.headers.Authorization).toBe('Bearer 123:test-key');
  expect(JSON.parse(options.body).resourceMetrics[0].scopeMetrics[0].metrics).toEqual([{ name: 'x' }]);
});

test('logs Grafana errors without throwing', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 });
  await metrics.sendMetricToGrafana([]);
  global.fetch = jest.fn().mockRejectedValue(new Error('offline'));
  await metrics.sendMetricToGrafana([]);
  expect(log).toHaveBeenCalledTimes(2);
});
