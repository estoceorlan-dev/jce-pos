import { z } from 'zod';
import { requireTransaction, type Transaction } from './transaction.js';

const inputSchema = z
  .object({
    documentId: z.uuid(),
    branchId: z.uuid(),
    installationId: z.uuid(),
    series: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,31}$/),
  })
  .strict();
export async function allocateDocumentNumber(
  tx: Transaction,
  input: z.infer<typeof inputSchema>,
): Promise<string> {
  requireTransaction(tx);
  const { documentId, branchId, installationId, series } =
    inputSchema.parse(input);
  const next = await tx.query<{ last_number: string }>(
    'INSERT INTO document_sequences (branch_id, installation_id, series, last_number) VALUES ($1,$2,$3,1) ON CONFLICT (branch_id,series) DO UPDATE SET last_number=document_sequences.last_number+1 RETURNING last_number',
    [branchId, installationId, series],
  );
  const number = next.rows[0]!.last_number;
  await tx.query(
    'INSERT INTO document_numbers (document_id,branch_id,installation_id,series,number) VALUES ($1,$2,$3,$4,$5)',
    [documentId, branchId, installationId, series, number],
  );
  return number;
}
