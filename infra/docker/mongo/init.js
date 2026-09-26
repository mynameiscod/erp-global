// One-shot setup, safe to re-run: replica set, then one user per service with
// access only to that service's database.
const services = [
  'identity',
  'tenant',
  'org',
  'access',
  'audit',
  'reference',
  'notification',
  'config',
  'records',
  'files',
  'workflow',
  'document',
  'reporting',
  'pack',
];

try {
  rs.status();
} catch (e) {
  rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'mongo:27017' }] });
}
for (let i = 0; i < 60 && !db.hello().isWritablePrimary; i++) sleep(1000);

const admin = db.getSiblingDB('admin');
for (const svc of services) {
  const user = `svc_${svc}`;
  const pwd = process.env[`MONGO_PASSWORD_${svc.toUpperCase()}`];
  if (!pwd) throw new Error(`MONGO_PASSWORD_${svc.toUpperCase()} is not set`);
  const roles = [{ role: 'readWrite', db: `erp_${svc}` }];
  if (admin.getUser(user)) {
    admin.updateUser(user, { pwd });
  } else {
    admin.createUser({ user, pwd, roles });
  }
  print(`user ${user} ready`);
}

// tenant-service grants dedicated-tenant databases to the service users.
if (!admin.getUser('svc_provisioner')) {
  admin.createUser({
    user: 'svc_provisioner',
    pwd: process.env.MONGO_PASSWORD_PROVISIONER,
    roles: [{ role: 'userAdminAnyDatabase', db: 'admin' }],
  });
} else {
  admin.updateUser('svc_provisioner', { pwd: process.env.MONGO_PASSWORD_PROVISIONER });
}
print('mongo init done');
