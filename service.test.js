const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('./src/database/database.js', () => ({
  Role: {
    Diner: 'diner',
    Franchisee: 'franchisee',
    Admin: 'admin',
  },
  DB: {
    addUser: jest.fn(),
    getUser: jest.fn(),
    loginUser: jest.fn(),
    isLoggedIn: jest.fn(),
    logoutUser: jest.fn(),
    getMenu: jest.fn(),
    addMenuItem: jest.fn(),
    getOrders: jest.fn(),
    addDinerOrder: jest.fn(),
    getFranchises: jest.fn(),
    getUserFranchises: jest.fn(),
    createFranchise: jest.fn(),
    deleteFranchise: jest.fn(),
    getFranchise: jest.fn(),
    createStore: jest.fn(),
    deleteStore: jest.fn(),
    updateUser: jest.fn(),
  },
}));

jest.mock('./src/config.js', () => ({
  jwtSecret: 'test-secret',
  db: {
    connection: { host: 'test-host' },
    listPerPage: 10,
  },
  factory: {
    url: 'https://factory.test',
    apiKey: 'factory-key',
  },
}));

const { DB, Role } = require('./src/database/database.js');
const app = require('./src/service.js');

const diner = {
  id: 2,
  name: 'Pizza Diner',
  email: 'diner@example.com',
  roles: [{ role: Role.Diner }],
};

const admin = {
  id: 1,
  name: 'Pizza Admin',
  email: 'admin@example.com',
  roles: [{ role: Role.Admin }],
};

const tokenFor = (user) => jwt.sign(user, 'test-secret');

const authHeaderFor = (user) => {
  DB.isLoggedIn.mockResolvedValue(true);
  return `Bearer ${tokenFor(user)}`;
};

beforeEach(() => {
  jest.clearAllMocks();
  DB.isLoggedIn.mockResolvedValue(false);
  global.fetch = jest.fn();
});

test('get the welcome message', async () => {
  const response = await request(app).get('/');

  expect(response.status).toBe(200);
  expect(response.body.message).toBe('welcome to JWT Pizza');
});

test('get the API documentation', async () => {
  const response = await request(app).get('/api/docs');

  expect(response.status).toBe(200);
  expect(response.body.endpoints).toEqual(expect.any(Array));
  expect(response.body.endpoints).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ method: 'POST', path: '/api/auth' }),
      expect.objectContaining({ method: 'GET', path: '/api/order/menu' }),
    ])
  );
});

test('returns not found for an unknown endpoint', async () => {
  const response = await request(app).get('/does-not-exist');

  expect(response.status).toBe(404);
  expect(response.body).toEqual({ message: 'unknown endpoint' });
});

test('rejects registration without required fields', async () => {
  const response = await request(app).post('/api/auth').send({ email: 'missing@example.com' });

  expect(response.status).toBe(400);
  expect(response.body.message).toBe('name, email, and password are required');
});

test('registers a diner and returns a token', async () => {
  DB.addUser.mockResolvedValue(diner);
  DB.loginUser.mockResolvedValue(undefined);

  const response = await request(app).post('/api/auth').send({
    name: diner.name,
    email: diner.email,
    password: 'password',
  });

  expect(response.status).toBe(200);
  expect(response.body.user).toEqual(diner);
  expect(response.body.token).toEqual(expect.any(String));
  expect(DB.addUser).toHaveBeenCalledWith({
    name: diner.name,
    email: diner.email,
    password: 'password',
    roles: [{ role: Role.Diner }],
  });
  expect(DB.loginUser).toHaveBeenCalledWith(diner.id, response.body.token);
});

test('logs in an existing user', async () => {
  DB.getUser.mockResolvedValue(admin);
  DB.loginUser.mockResolvedValue(undefined);

  const response = await request(app).put('/api/auth').send({
    email: admin.email,
    password: 'password',
  });

  expect(response.status).toBe(200);
  expect(response.body.user).toEqual(admin);
  expect(response.body.token).toEqual(expect.any(String));
  expect(DB.getUser).toHaveBeenCalledWith(admin.email, 'password');
});

test('rejects logout without authentication', async () => {
  const response = await request(app).delete('/api/auth');

  expect(response.status).toBe(401);
  expect(response.body.message).toBe('unauthorized');
});

test('logs out an authenticated user', async () => {
  DB.logoutUser.mockResolvedValue(undefined);
  const authorization = authHeaderFor(admin);

  const response = await request(app).delete('/api/auth').set('Authorization', authorization);

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ message: 'logout successful' });
  expect(DB.logoutUser).toHaveBeenCalledWith(authorization.split(' ')[1]);
});

test('gets the menu', async () => {
  const menu = [{ id: 1, title: 'Veggie', price: 0.05 }];
  DB.getMenu.mockResolvedValue(menu);

  const response = await request(app).get('/api/order/menu');

  expect(response.status).toBe(200);
  expect(response.body).toEqual(menu);
});

test('rejects adding a menu item without admin authentication', async () => {
  const response = await request(app).put('/api/order/menu').send({ title: 'New pizza' });

  expect(response.status).toBe(401);
  expect(response.body.message).toBe('unauthorized');
});

test('allows an admin to add a menu item', async () => {
  const menuItem = { title: 'New pizza', description: 'A new pizza', image: 'pizza.png', price: 0.05 };
  DB.addMenuItem.mockResolvedValue({ ...menuItem, id: 2 });
  DB.getMenu.mockResolvedValue([menuItem]);
  const authorization = authHeaderFor(admin);

  const response = await request(app)
    .put('/api/order/menu')
    .set('Authorization', authorization)
    .send(menuItem);

  expect(response.status).toBe(200);
  expect(response.body).toEqual([menuItem]);
  expect(DB.addMenuItem).toHaveBeenCalledWith(menuItem);
});

test('gets authenticated user orders', async () => {
  const orders = [{ id: 1, franchiseId: 1, storeId: 1, items: [] }];
  DB.getOrders.mockResolvedValue({ dinerId: diner.id, orders, page: 1 });
  const authorization = authHeaderFor(diner);

  const response = await request(app).get('/api/order').set('Authorization', authorization);

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ dinerId: diner.id, orders, page: 1 });
});

test('creates an order and sends it to the factory', async () => {
  const order = { franchiseId: 1, storeId: 1, items: [] };
  const savedOrder = { ...order, id: 3 };
  DB.addDinerOrder.mockResolvedValue(savedOrder);
  global.fetch.mockResolvedValue({
    ok: true,
    json: jest.fn().mockResolvedValue({ reportUrl: 'https://factory.test/report', jwt: 'factory-jwt' }),
  });
  const authorization = authHeaderFor(diner);

  const response = await request(app)
    .post('/api/order')
    .set('Authorization', authorization)
    .send(order);

  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    order: savedOrder,
    followLinkToEndChaos: 'https://factory.test/report',
    jwt: 'factory-jwt',
  });
  expect(global.fetch).toHaveBeenCalledWith(
    'https://factory.test/api/order',
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ authorization: 'Bearer factory-key' }),
    })
  );
});

test('returns an error when the factory rejects an order', async () => {
  DB.addDinerOrder.mockResolvedValue({ id: 3 });
  global.fetch.mockResolvedValue({
    ok: false,
    json: jest.fn().mockResolvedValue({ reportUrl: 'https://factory.test/report' }),
  });
  const authorization = authHeaderFor(diner);

  const response = await request(app).post('/api/order').set('Authorization', authorization).send({});

  expect(response.status).toBe(500);
  expect(response.body).toEqual({
    message: 'Failed to fulfill order at factory',
    followLinkToEndChaos: 'https://factory.test/report',
  });
});

test('lists franchises', async () => {
  const franchises = [{ id: 1, name: 'Pizza Pocket' }];
  DB.getFranchises.mockResolvedValue([franchises, false]);

  const response = await request(app).get('/api/franchise');

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ franchises, more: false });
});

test('gets a user franchises for the authenticated user', async () => {
  const franchises = [{ id: 1, name: 'Pizza Pocket' }];
  DB.getUserFranchises.mockResolvedValue(franchises);
  const authorization = authHeaderFor(diner);

  const response = await request(app).get(`/api/franchise/${diner.id}`).set('Authorization', authorization);

  expect(response.status).toBe(200);
  expect(response.body).toEqual(franchises);
  expect(DB.getUserFranchises).toHaveBeenCalledWith(diner.id);
});

test('allows an admin to create a franchise', async () => {
  const franchise = { name: 'Pizza Pocket', admins: [] };
  DB.createFranchise.mockResolvedValue({ ...franchise, id: 1 });
  const authorization = authHeaderFor(admin);

  const response = await request(app)
    .post('/api/franchise')
    .set('Authorization', authorization)
    .send(franchise);

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ ...franchise, id: 1 });
});

test('rejects franchise creation by a diner', async () => {
  const authorization = authHeaderFor(diner);

  const response = await request(app).post('/api/franchise').set('Authorization', authorization).send({ name: 'Nope' });

  expect(response.status).toBe(403);
  expect(response.body.message).toBe('unable to create a franchise');
});

test('creates a store for an authorized franchise user', async () => {
  const franchise = { id: 1, admins: [{ id: diner.id }] };
  DB.getFranchise.mockResolvedValue(franchise);
  DB.createStore.mockResolvedValue({ id: 2, franchiseId: 1, name: 'Downtown' });
  const authorization = authHeaderFor(diner);

  const response = await request(app)
    .post('/api/franchise/1/store')
    .set('Authorization', authorization)
    .send({ name: 'Downtown' });

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ id: 2, franchiseId: 1, name: 'Downtown' });
});

test('deletes a store for an authorized franchise user', async () => {
  const franchise = { id: 1, admins: [{ id: diner.id }] };
  DB.getFranchise.mockResolvedValue(franchise);
  DB.deleteStore.mockResolvedValue(undefined);
  const authorization = authHeaderFor(diner);

  const response = await request(app)
    .delete('/api/franchise/1/store/2')
    .set('Authorization', authorization);

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ message: 'store deleted' });
  expect(DB.deleteStore).toHaveBeenCalledWith(1, 2);
});

test('gets the authenticated user', async () => {
  const authorization = authHeaderFor(diner);

  const response = await request(app).get('/api/user/me').set('Authorization', authorization);

  expect(response.status).toBe(200);
  expect(response.body).toMatchObject(diner);
});

test('rejects a user update by another diner', async () => {
  const authorization = authHeaderFor(diner);

  const response = await request(app)
    .put('/api/user/3')
    .set('Authorization', authorization)
    .send({ name: 'Unauthorized' });

  expect(response.status).toBe(403);
  expect(response.body.message).toBe('unauthorized');
});

test('updates the authenticated user', async () => {
  const updatedUser = { ...diner, name: 'Updated Diner' };
  DB.updateUser.mockResolvedValue(updatedUser);
  DB.loginUser.mockResolvedValue(undefined);
  const authorization = authHeaderFor(diner);

  const response = await request(app)
    .put(`/api/user/${diner.id}`)
    .set('Authorization', authorization)
    .send({ name: updatedUser.name, email: diner.email, password: 'new-password' });

  expect(response.status).toBe(200);
  expect(response.body.user).toEqual(updatedUser);
  expect(response.body.token).toEqual(expect.any(String));
});

test('returns a server error when a handler fails', async () => {
  DB.getMenu.mockRejectedValue(new Error('database unavailable'));

  const response = await request(app).get('/api/order/menu');

  expect(response.status).toBe(500);
  expect(response.body.message).toBe('database unavailable');
});
