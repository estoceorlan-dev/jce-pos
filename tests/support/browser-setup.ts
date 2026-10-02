import { setupManagement, testPassword } from './management.js';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../../backend/src/auth/service.js';
import { withTransaction } from '../../backend/src/db/transaction.js';
import { createPool } from '../../backend/src/db/pool.js';
import { testDatabase } from './database.js';
const seeded = await setupManagement();
const pool = createPool(testDatabase().connection('migrator'));
try {
  const hash = await hashPassword(testPassword);
  for (const scenario of ['checkout', 'transfer', 'transfer-reviewer'])
    for (const project of ['chromium', 'mobile'])
      await withTransaction(pool, async (tx) => {
        const id = randomUUID();
        await tx.query(
          'INSERT INTO users(id,username,display_name,password_hash,must_change_password) VALUES($1,$2,$3,$4,false)',
          [
            id,
            `test.${scenario}.${project}`,
            `Synthetic ${scenario} ${project}`,
            hash,
          ],
        );
        await tx.query('INSERT INTO user_roles VALUES($1,$2)', [
          id,
          scenario === 'transfer-reviewer' ? 'manager' : 'admin',
        ]);
        for (const branchId of seeded.branches)
          await tx.query('INSERT INTO branch_users VALUES($1,$2)', [
            id,
            branchId,
          ]);
      });
  await pool.query('UPDATE business_settings SET value=$1,version=version+1', [
    JSON.stringify({
      name: 'Synthetic browser shop',
      address: 'Test fixtures only',
      currency: 'PHP',
      timezone: 'Asia/Manila',
      receiptFooter: 'Synthetic receipt',
      receiptSeries: 'SALE',
      taxConfirmed: true,
    }),
  ]);
  for (const branchId of seeded.branches)
    await pool.query(
      'INSERT INTO branch_settings(branch_id,value) VALUES($1,$2)',
      [
        branchId,
        JSON.stringify({
          tenders: ['cash', 'card', 'ewallet'],
          discountThreshold: '0',
          printerName: '',
          paperWidth: '80',
        }),
      ],
    );
} finally {
  await pool.end();
}
