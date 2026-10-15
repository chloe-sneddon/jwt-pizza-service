const request = require('supertest');
const { DB } = require('./src/database/database.js');
const app = require('./src/service.js');

jest.setTimeout(30000);
let userId;

beforeAll(async () => {
  await DB.initialized;
  const connection = await DB.getConnection();
  await connection.end();
});

afterAll(async () => {
  if (!userId) return;
  const connection = await DB.getConnection();
  try {
    await DB.query(connection, 'DELETE FROM auth WHERE userId=?', [userId]);
    await DB.query(connection, 'DELETE FROM userRole WHERE userId=?', [userId]);
    await DB.query(connection, 'DELETE FROM user WHERE id=?', [userId]);
  } finally {
    await connection.end();
  }
});

test('persists partial user updates and supports changed credentials', async () => {
  const email = `update-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
  const registration = await request(app).post('/api/auth').send({ name: 'Original Name', email, password: 'old-password' });
  expect(registration.status).toBe(200);
  userId = registration.body.user.id;

  let token = registration.body.token;
  let response = await request(app).put(`/api/user/${userId}`).set('Authorization', `Bearer ${token}`).send({ name: 'Updated Name' });
  expect(response.status).toBe(200);
  expect(response.body.user).toMatchObject({ id: userId, name: 'Updated Name', email });

  token = response.body.token;
  const updatedEmail = `updated-${email}`;
  response = await request(app).put(`/api/user/${userId}`).set('Authorization', `Bearer ${token}`).send({ email: updatedEmail });
  expect(response.body.user.email).toBe(updatedEmail);

  response = await request(app).put(`/api/user/${userId}`).set('Authorization', `Bearer ${response.body.token}`).send({ password: 'new-password' });
  expect(response.status).toBe(200);
  const oldLogin = await request(app).put('/api/auth').send({ email: updatedEmail, password: 'old-password' });
  expect(oldLogin.status).toBe(404);
  const login = await request(app).put('/api/auth').send({ email: updatedEmail, password: 'new-password' });
  expect(login.status).toBe(200);
});
