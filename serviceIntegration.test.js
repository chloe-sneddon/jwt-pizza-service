const request = require('supertest');
const { DB, Role } = require('./src/database/database.js');
const { setAuth } = require('./src/routes/authRouter.js');
const app = require('./src/service.js');
jest.setTimeout(30000);
const ids = [];
let prefix, token, expectedIds;
async function register(name) {
  const r = await request(app).post('/api/auth').send({ name, email: `${name}-${Math.random().toString(36).slice(2)}@test.com`, password: 'test-password' });
  expect(r.status).toBe(200); ids.push(r.body.user.id); return r.body;
}
beforeAll(async () => {
  await DB.initialized;
  const c = await DB.getConnection(); await c.end();
  prefix = `it-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const admin = await DB.addUser({ name: `${prefix}-admin`, email: `${prefix}-admin@test.com`, password: 'test-password', roles: [{ role: Role.Admin }] });
  ids.push(admin.id); token = await setAuth(admin);
  const a = await register(`${prefix}-match-a`);
  const b = await register(`${prefix}-match-b`);
  await register(`${prefix}-other`);
  expectedIds = [a.user.id, b.user.id];
});
afterAll(async () => {
  if (!ids.length) return;
  const c = await DB.getConnection();
  try {
    for (const id of ids) {
      await DB.query(c, 'DELETE FROM auth WHERE userId=?', [id]);
      await DB.query(c, 'DELETE FROM userRole WHERE userId=?', [id]);
      await DB.query(c, 'DELETE FROM user WHERE id=?', [id]);
    }
  } finally { await c.end(); }
});
test('requires authentication', async () => {
  expect((await request(app).get('/api/user')).status).toBe(401);
});
test('filters users by name', async () => {
  const r = await request(app).get('/api/user').query({ page: 1, limit: 10, name: `${prefix}-match-*` }).set('Authorization', `Bearer ${token}`);
  expect(r.status).toBe(200); expect(r.body.more).toBe(false);
  expect(r.body.users.map((u) => u.id)).toEqual(expectedIds);
  expect(r.body.users[0]).not.toHaveProperty('password');
});
test('paginates the filtered users', async () => {
  const getPage = (page) => request(app).get('/api/user').query({ page, limit: 1, name: `${prefix}-match-*` }).set('Authorization', `Bearer ${token}`);
  const [one, two] = await Promise.all([getPage(1), getPage(2)]);
  expect(one.body.users.map((u) => u.id)).toEqual([expectedIds[0]]); expect(one.body.more).toBe(true);
  expect(two.body.users.map((u) => u.id)).toEqual([expectedIds[1]]); expect(two.body.more).toBe(false);
});
