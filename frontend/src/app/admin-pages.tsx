import { useState } from 'react';
import { managedPermissions } from '@jce/shared';
import {
  Editor,
  Grid,
  LoadState,
  History,
  text,
  strings,
  archivedField,
  type Field,
  type Row,
} from './forms';
import { useAllowed, useData, useSession } from './session';
export function Users() {
  const { session, write } = useSession();
  const query = useData<Row[]>('/users');
  const roles = useData<Row[]>('/roles');
  const [editing, setEditing] = useState<Row | null>(null);
  const [reset, setReset] = useState<Row | null>(null);
  const [role, setRole] = useState<Row | null>(null);
  const admin = session!.roles.includes('admin');
  const choices = (roles.data ?? [])
    .filter(
      (r) =>
        admin ||
        (text(r['code']) !== 'admin' &&
          strings(r['permissions']).every((p) =>
            session!.permissions.includes(p),
          )),
    )
    .map((r) => ({ value: text(r['code']), label: text(r['name']) }));
  const fields: Field[] = [
    { key: 'username', label: 'Username' },
    { key: 'displayName', label: 'Display name' },
    ...(!editing?.['id']
      ? [
          {
            key: 'password',
            label: 'Initial password',
            type: 'password',
            hint: 'At least 12 characters; the user must change it at first sign-in.',
          } as Field,
        ]
      : []),
    { key: 'roles', label: 'Roles', type: 'multi', options: choices },
    {
      key: 'branchIds',
      label: 'Assigned branches',
      type: 'multi',
      options: session!.branches.map((b) => ({ value: b.id, label: b.name })),
    },
    { key: 'disabled', label: 'Account disabled', type: 'checkbox' },
  ];
  return (
    <>
      <h1>Users & permissions</h1>
      <p>
        Access changes end the affected user’s sessions. An active administrator
        must remain available.
      </p>
      <button
        onClick={() =>
          setEditing({
            roles: ['cashier'],
            branchIds: session!.branchId ? [session!.branchId] : [],
            disabled: false,
          })
        }
      >
        Add user
      </button>
      <LoadState query={query} />
      {query.data && (
        <Grid
          title="Store accounts"
          rows={query.data}
          columns={[
            ['username', 'Username'],
            ['display_name', 'Name'],
            ['roles', 'Roles'],
            ['disabled', 'Disabled'],
          ]}
          actions={(row) => (
            <div className="actions">
              <button
                onClick={() =>
                  setEditing({
                    id: row['id'],
                    version: row['version'],
                    username: row['username'],
                    displayName: row['display_name'],
                    roles: row['roles'],
                    branchIds: row['branch_ids'],
                    disabled: row['disabled'],
                  })
                }
              >
                Edit {text(row['username'])}
              </button>
              {admin && (
                <button className="secondary" onClick={() => setReset(row)}>
                  Reset password
                </button>
              )}
            </div>
          )}
        />
      )}
      {editing && (
        <Editor
          key={text(editing['id']) || 'new'}
          title="Account details"
          fields={fields}
          initial={editing}
          done={() => setEditing(null)}
          save={(data) => {
            const { id, ...values } = data;
            return write(
              `/users${id ? '/' + text(id) : ''}`,
              values,
              id ? 'PUT' : 'POST',
            );
          }}
        />
      )}
      {reset && (
        <Editor
          key={text(reset['id'])}
          title={`Reset password · ${text(reset['username'])}`}
          fields={[
            { key: 'password', label: 'Temporary password', type: 'password' },
          ]}
          initial={{ version: reset['version'] }}
          done={() => setReset(null)}
          save={(data) => write(`/users/${text(reset['id'])}/reset`, data)}
        />
      )}
      <LoadState query={roles} />
      {roles.data && (
        <Grid
          title="Role permissions"
          rows={roles.data}
          columns={[
            ['name', 'Role'],
            ['permissions', 'Permissions'],
          ]}
          actions={(row) =>
            admin && row['code'] !== 'admin' ? (
              <button onClick={() => setRole(row)}>
                Edit {text(row['name'])}
              </button>
            ) : null
          }
        />
      )}
      {role && (
        <Editor
          key={text(role['code'])}
          title={`Permissions · ${text(role['name'])}`}
          fields={[
            {
              key: 'permissions',
              label: 'Allowed actions',
              type: 'multi',
              options: managedPermissions.map((p) => ({ value: p, label: p })),
            },
          ]}
          initial={{
            permissions: role['permissions'],
            version: role['version'],
          }}
          done={() => setRole(null)}
          save={(data) => write(`/roles/${text(role['code'])}`, data, 'PUT')}
        />
      )}
    </>
  );
}
export function Branches() {
  const { write } = useSession();
  const query = useData<Row[]>('/branches');
  const [editing, setEditing] = useState<Row | null>(null);
  return (
    <>
      <h1>Branches</h1>
      <p>
        Codes identify branches permanently. Archive branches to retain their
        history.
      </p>
      <button onClick={() => setEditing({ archived: false })}>
        Add branch
      </button>
      <LoadState query={query} />
      {query.data && (
        <Grid
          title="Installation branches"
          rows={query.data}
          columns={[
            ['code', 'Code'],
            ['name', 'Name'],
            ['archived', 'Archived'],
          ]}
          actions={(row) => (
            <button onClick={() => setEditing(row)}>
              Edit {text(row['code'])}
            </button>
          )}
        />
      )}
      {editing && (
        <Editor
          key={text(editing['id']) || 'new'}
          title="Branch details"
          fields={[
            {
              key: 'code',
              label: 'Code',
              hint: 'Uppercase letters, numbers, underscores or hyphens.',
            },
            { key: 'name', label: 'Branch name' },
            archivedField,
          ]}
          initial={editing}
          done={() => setEditing(null)}
          save={(data) => {
            const { id, ...values } = data;
            return write(
              `/branches${id ? '/' + text(id) : ''}`,
              values,
              id ? 'PUT' : 'POST',
            );
          }}
        />
      )}
    </>
  );
}
export function Settings() {
  const { session, write } = useSession();
  const global = useAllowed('settings.global');
  const local = useAllowed('settings.manage');
  const [mode, setMode] = useState(global ? 'business' : 'branch');
  if (!global && !session!.branchId)
    return (
      <>
        <h1>Store settings</h1>
        <p>Choose an assigned active branch to configure its settings.</p>
      </>
    );
  const base =
    mode === 'business'
      ? '/settings/business'
      : `/branches/${session!.branchId}/settings`;
  return (
    <>
      <h1>Store settings</h1>
      <div className="toolbar">
        {global && (
          <button onClick={() => setMode('business')}>Business settings</button>
        )}
        {local && session!.branchId && (
          <button onClick={() => setMode('branch')}>Branch settings</button>
        )}
      </div>
      <SettingsForm
        key={base}
        path={base}
        business={mode === 'business'}
        save={(data) => write(base, data, 'PUT')}
      />
      <History path={`${base}/history`} />
    </>
  );
}
function SettingsForm({
  path,
  business,
  save,
}: {
  path: string;
  business: boolean;
  save: (data: Row) => Promise<unknown>;
}) {
  const query = useData<{ value: Row; version: number }>(path);
  const fields: Field[] = business
    ? [
        { key: 'name', label: 'Registered business name' },
        { key: 'address', label: 'Business address', type: 'textarea' },
        {
          key: 'currency',
          label: 'Currency',
          type: 'select',
          options: [{ value: 'PHP', label: 'PHP' }],
        },
        {
          key: 'timezone',
          label: 'Timezone',
          type: 'select',
          options: [
            { value: 'Asia/Manila', label: 'Asia/Manila · midnight cutoff' },
          ],
        },
        { key: 'receiptSeries', label: 'Receipt series' },
        {
          key: 'receiptFooter',
          label: 'Receipt footer',
          type: 'textarea',
          optional: true,
        },
        {
          key: 'taxConfirmed',
          label: 'Owner has confirmed tax and receipt configuration',
          type: 'checkbox',
        },
      ]
    : [
        {
          key: 'tenders',
          label: 'Allowed payment methods',
          type: 'multi',
          options: [
            { value: 'cash', label: 'Cash' },
            { value: 'card', label: 'Manually recorded card' },
            { value: 'ewallet', label: 'Manually recorded e-wallet' },
          ],
        },
        {
          key: 'discountThreshold',
          label: 'Discount approval threshold (PHP)',
          hint: 'Configuration only. Approval enforcement arrives with checkout.',
        },
        { key: 'printerName', label: 'Receipt printer name', optional: true },
        {
          key: 'paperWidth',
          label: 'Paper width (mm)',
          type: 'select',
          options: [
            { value: '58', label: '58 mm' },
            { value: '80', label: '80 mm' },
          ],
        },
      ];
  return (
    <>
      <p>
        {business
          ? 'Enter confirmed business and receipt details. No tax rate is assumed.'
          : 'These settings belong to the selected branch. Printer qualification follows hardware setup.'}
      </p>
      <LoadState query={query} />
      {query.data && (
        <Editor
          key={query.data.version}
          title={
            business ? 'Business identity & receipts' : 'Payments & printer'
          }
          fields={fields}
          initial={{
            ...(business
              ? {
                  currency: 'PHP',
                  timezone: 'Asia/Manila',
                  receiptFooter: '',
                  taxConfirmed: false,
                }
              : { tenders: ['cash'], printerName: '' }),
            ...query.data.value,
            version: query.data.version,
          }}
          save={save}
        />
      )}
    </>
  );
}
export function Registers() {
  const { session, write } = useSession();
  const base = `/branches/${session!.branchId}`;
  const query = useData<{ terminals: Row[]; registers: Row[] }>(
    `${base}/registers`,
  );
  const [editing, setEditing] = useState<Row | null>(null);
  return (
    <>
      <h1>Terminals & registers</h1>
      <p>
        Terminal codes are permanent. Registers can be archived while their
        history remains available.
      </p>
      <Editor
        title="Register a terminal"
        fields={[{ key: 'code', label: 'Terminal code' }]}
        save={(data) => write(`${base}/terminals`, data)}
      />
      <LoadState query={query} />
      {query.data && (
        <>
          <Grid
            title="Terminals"
            rows={query.data.terminals}
            columns={[
              ['code', 'Code'],
              ['id', 'Terminal ID'],
            ]}
          />
          <button onClick={() => setEditing({ archived: false })}>
            Add register
          </button>
          <Grid
            title="Registers"
            rows={query.data.registers}
            columns={[
              ['code', 'Register'],
              ['terminal_id', 'Terminal ID'],
              ['archived', 'Archived'],
            ]}
            actions={(row) => (
              <button
                onClick={() =>
                  setEditing({
                    id: row['id'],
                    code: row['code'],
                    terminalId: row['terminal_id'],
                    archived: row['archived'],
                    version: row['version'],
                  })
                }
              >
                Edit {text(row['code'])}
              </button>
            )}
          />
          {editing && (
            <Editor
              key={text(editing['id']) || 'new'}
              title="Register details"
              initial={editing}
              fields={[
                { key: 'code', label: 'Register code' },
                {
                  key: 'terminalId',
                  label: 'Terminal',
                  type: 'select',
                  options: query.data.terminals.map((t) => ({
                    value: text(t['id']),
                    label: text(t['code']),
                  })),
                },
                archivedField,
              ]}
              done={() => setEditing(null)}
              save={(data) => {
                const { id, ...values } = data;
                return write(
                  `${base}/registers${id ? '/' + text(id) : ''}`,
                  values,
                  id ? 'PUT' : 'POST',
                );
              }}
            />
          )}
        </>
      )}
    </>
  );
}
