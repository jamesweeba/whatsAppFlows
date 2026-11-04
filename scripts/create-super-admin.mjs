// Create a SUPER_ADMIN account, or promote an existing user that has no shop.
// Super admins are never created through /auth/signup.
//
//   npm run admin:create -- --email admin@marketix.app --password 'long-secret' --first Ama --last Mensah
import 'dotenv/config';
import { parseArgs } from 'node:util';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    password: { type: 'string' },
    first: { type: 'string', default: 'Super' },
    last: { type: 'string', default: 'Admin' },
  },
});

if (!values.email || !values.password || values.password.length < 12) {
  console.error('Usage: npm run admin:create -- --email <email> --password <at least 12 chars> [--first <name>] [--last <name>]');
  process.exit(1);
}

const prisma = new PrismaClient();
try {
  const email = values.email.trim().toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email }, include: { tenant: true } });
  if (existing?.tenant) {
    console.error(`${email} owns the shop "${existing.tenant.name}"; use a separate account for the super admin.`);
    process.exit(1);
  }

  const password = await bcrypt.hash(values.password, 12);
  const user = existing
    ? await prisma.user.update({ where: { id: existing.id }, data: { role: 'SUPER_ADMIN', password } })
    : await prisma.user.create({
        data: { email, password, firstName: values.first, lastName: values.last, role: 'SUPER_ADMIN' },
      });
  console.log(`${existing ? 'Promoted' : 'Created'} super admin ${user.email}.`);
} finally {
  await prisma.$disconnect();
}
