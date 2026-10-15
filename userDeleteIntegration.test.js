const request = require('supertest');
const { DB, Role } = require('./src/database/database.js');
const { setAuth } = require('./src/routes/authRouter.js');
const app = require('./src/service.js');

jest.setTimeout(30000);
const ids = [];
let target, adminToken;

beforeAll(async () => {
  await DB.initialized;
  target = await request(app).post('/api/auth').send({ name: 'Delete target', email: `delete-${Date.now()}@test.com`, password: 'test-password' });
  ids.push(target.body.user.id);
  const admin = await DB.addUser({ name: 'Delete admin', email: `admin-${Date.now()}@test.com`, password: 'test-password', roles: [{ role: Role.Admin }] });
  ids.push(admin.id);
  adminToken = await setAuth(admin);
});

afterAll(async () => {
  const connection = await DB.getConnection();
  try {
    for (const id of ids) {
      await DB.query(connection, 'DELETE FROM auth WHERE userId=?', [id]);
      await DB.query(connection, 'DELETE FROM userRole WHERE userId=?', [id]);
      await DB.query(connection, 'DELETE FROM user WHERE id=?', [id]);
    }
  } finally { await connection.end(); }
});

test('admin deletion removes the user and their login', async () => {
  const response = await request(app).delete(`/api/user/${target.body.user.id}`).set('Authorization', `Bearer ${adminToken}`);
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ message: 'user deleted' });
  const login = await request(app).put('/api/auth').send({ email: target.body.user.email, password: 'test-password' });
  expect(login.status).toBe(404);
});
