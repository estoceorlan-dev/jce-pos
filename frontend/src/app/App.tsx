import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { navigation, readinessSchema, versionSchema } from '@jce/shared';
import { getJson } from '../api/client';
import { DataTable, StatePanel, TextField } from '../components/ui';
import { SessionProvider, useSession } from './session';
import { SignIn, Locked, PasswordChange } from './auth-pages';
import {
  Catalog,
  CatalogSetup,
  Partners,
  ImportCatalog,
} from './catalog-pages';
import { Users, Branches, Settings, Registers } from './admin-pages';
import { History } from './forms';
import { Inventory } from './inventory-pages';

const managementNavigation = [
  {
    path: '/inventory',
    label: 'Inventory',
    permission: 'inventory.read',
    branch: true,
    page: <Inventory />,
  },
  {
    path: '/catalog',
    label: 'Catalog',
    permission: 'catalog.read',
    branch: true,
    page: <Catalog />,
  },
  {
    path: '/catalog-setup',
    label: 'Catalog setup',
    permission: 'catalog.read',
    page: <CatalogSetup />,
  },
  {
    path: '/customers',
    label: 'Customers',
    permission: 'partners.read',
    branch: true,
    page: <Partners kind="customers" />,
  },
  {
    path: '/suppliers',
    label: 'Suppliers',
    permission: 'partners.read',
    branch: true,
    page: <Partners kind="suppliers" />,
  },
  {
    path: '/imports',
    label: 'Catalog import',
    permission: 'catalog.manage',
    requiredPermissions: ['prices.manage'],
    branch: true,
    page: <ImportCatalog />,
  },
  {
    path: '/users',
    label: 'Users & permissions',
    permission: 'users.manage',
    page: <Users />,
  },
  {
    path: '/branches',
    label: 'Branches',
    permission: 'branches.manage',
    page: <Branches />,
  },
  {
    path: '/settings',
    label: 'Store settings',
    permission: ['settings.manage', 'settings.global'],
    page: <Settings />,
  },
  {
    path: '/registers',
    label: 'Terminals & registers',
    permission: 'settings.manage',
    branch: true,
    page: <Registers />,
  },
  {
    path: '/login-history',
    label: 'Login history',
    permission: 'history.read',
    page: <History path="/login-history" title="Login history" />,
  },
];
function canOpen(
  grants: string[],
  permission: string | string[],
  required: string[] = [],
) {
  return (
    (typeof permission === 'string'
      ? grants.includes(permission)
      : permission.some((p) => grants.includes(p))) &&
    required.every((p) => grants.includes(p))
  );
}
function Protected({
  permission,
  requiredPermissions,
  branch,
  children,
}: {
  permission: string | string[];
  requiredPermissions?: string[] | undefined;
  branch?: boolean | undefined;
  children: ReactNode;
}) {
  const { session, loading } = useSession();
  if (loading)
    return <StatePanel title="Checking access">Please wait.</StatePanel>;
  if (!session) return <SignIn />;
  if (!canOpen(session.permissions, permission, requiredPermissions))
    return (
      <StatePanel title="Access unavailable">
        Your account is not authorized for this area.
      </StatePanel>
    );
  if (branch && !session.branchId)
    return (
      <StatePanel title="Choose a branch">
        Ask an administrator to assign an active branch.
      </StatePanel>
    );
  return <>{children}</>;
}
const stationSchema = z.object({
  label: z
    .string()
    .trim()
    .min(2, 'Enter at least 2 characters.')
    .max(40, 'Use 40 characters or fewer.'),
});
type StationForm = z.infer<typeof stationSchema>;

function Overview() {
  const { session } = useSession();
  const readiness = useQuery({
    queryKey: ['readiness'],
    queryFn: () => getJson('/health/ready', readinessSchema),
    retry: false,
    refetchInterval: 30000,
  });
  const version = useQuery({
    queryKey: ['version'],
    queryFn: () => getJson('/api/v1/version', versionSchema),
    retry: false,
  });
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">STORE WORKSPACE</p>
          <h1>Ready for the next chapter.</h1>
          <p className="lede">Your local store workspace is taking shape.</p>
        </div>
        <span className="phase-tag">Accounts & catalog · L3–L4</span>
      </div>
      <section className="welcome">
        <div>
          <p className="eyebrow">JCE DRY GOODS TRADING</p>
          <h2>
            A connected store.
            <br />A simpler working day.
          </h2>
          <p>
            One place for your products, stock and daily sales. Store operations
            will become available as setup progresses.
          </p>
          <NavLink className="button light" to="/workstation">
            Set workstation label <span aria-hidden="true">↗</span>
          </NavLink>
        </div>
        <div className="welcome-mark" aria-hidden="true">
          <span>JCE</span>
          <small>YOUR STORE, TOGETHER</small>
        </div>
      </section>
      <div className="section-heading">
        <h2>Installation overview</h2>
        <span>Local workspace</span>
      </div>
      <div className="status-grid">
        <article className="card">
          <span className="card-label">LOCAL SERVICE</span>
          <strong>
            {readiness.isPending
              ? 'Checking…'
              : readiness.isError
                ? 'Needs attention'
                : 'Connected'}
          </strong>
          <p>
            {readiness.isError
              ? 'The branch host needs a connection or setup check.'
              : 'Service and database readiness are checked here.'}
          </p>
        </article>
        <article className="card">
          <span className="card-label">ACTIVE BRANCH</span>
          <strong>
            {session?.branches.find((b) => b.id === session.branchId)?.name ??
              'Sign in to select'}
          </strong>
          <p>Your assigned branches are available after sign-in.</p>
        </article>
        <article className="card">
          <span className="card-label">WORKSPACE VERSION</span>
          <strong>{version.data?.version ?? 'Unavailable'}</strong>
          <p>PHP currency · Asia/Manila time</p>
        </article>
      </div>
      {readiness.isPending && (
        <StatePanel title="Checking the local service">
          This should only take a moment.
        </StatePanel>
      )}
      {readiness.isError && (
        <StatePanel
          title="Local service unavailable"
          error
          action={
            <button onClick={() => void readiness.refetch()}>Try again</button>
          }
        >
          Check that the branch host is running and its database setup is
          complete. Share the issue with your maintainer if it continues.
        </StatePanel>
      )}
      <section className="next-section">
        <div>
          <p className="eyebrow">WHAT COMES NEXT</p>
          <h2>Built around your store</h2>
          <p>
            These areas are planned. Transactions are not available in this
            foundation release.
          </p>
        </div>
        <DataTable
          caption="Upcoming store capabilities"
          columns={['Area', 'Availability']}
          rows={[
            [
              <span key="catalog">Catalog & inventory</span>,
              'Catalog and stock controls available after sign-in',
            ],
            ['Checkout & receipts', 'After inventory setup'],
            ['Reports & daily close', 'After checkout setup'],
          ]}
        />
      </section>
    </>
  );
}
function Workstation({
  label,
  onSave,
}: {
  label: string;
  onSave: (label: string) => void;
}) {
  const [saved, setSaved] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<StationForm>({
    resolver: zodResolver(stationSchema),
    defaultValues: { label },
  });
  return (
    <>
      <p className="eyebrow">THIS WORKSPACE</p>
      <h1>Workstation label</h1>
      <p className="lede">
        Give this window a familiar name. It lasts until the page is reloaded.
      </p>
      <form
        className="form-card"
        onSubmit={handleSubmit((data) => {
          onSave(data.label);
          setSaved(true);
        })}
      >
        <TextField
          id="station-label"
          label="Display name"
          autoComplete="off"
          {...register('label', { onChange: () => setSaved(false) })}
          {...(errors.label?.message ? { error: errors.label.message } : {})}
        />
        <button type="submit">Apply label</button>
        {saved && (
          <p role="status">Workstation label updated for this window.</p>
        )}
      </form>
    </>
  );
}
export function App() {
  return (
    <SessionProvider>
      <Workspace />
    </SessionProvider>
  );
}
function Workspace() {
  const { session, write, error: sessionError } = useSession();
  const [actionError, setActionError] = useState('');
  const act = (path: string, data?: unknown) => {
    setActionError('');
    void write(path, data).catch((e: unknown) =>
      setActionError(e instanceof Error ? e.message : 'Action failed.'),
    );
  };
  const [label, setLabel] = useState('Local workstation');
  const location = useLocation();
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    main.current?.focus({ preventScroll: true });
  }, [location.pathname]);
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar">
        <NavLink to="/" className="brand" aria-label="JCE home">
          <span className="brand-mark">J</span>
          <span>
            JCE<small>DRY GOODS TRADING</small>
          </span>
        </NavLink>
        <p className="nav-label">WORKSPACE</p>
        <nav aria-label="Main navigation">
          <NavLink to="/" end>
            <span aria-hidden="true">◫</span>Overview
          </NavLink>
          <NavLink to="/workstation">
            <span aria-hidden="true">▣</span>Workstation
          </NavLink>
          {managementNavigation
            .filter(
              (item) =>
                session &&
                canOpen(
                  session.permissions,
                  item.permission,
                  item.requiredPermissions,
                ),
            )
            .map((item) => (
              <NavLink key={item.path} to={item.path}>
                {item.label}
              </NavLink>
            ))}
          <NavLink to={session ? '/password' : '/login'}>
            {session ? 'Change password' : 'Sign in'}
          </NavLink>
        </nav>
        <div className="sidebar-note">
          <span className="local-dot" />
          Local installation<p>Designed for your branch network.</p>
        </div>
        <div className="sidebar-footer">
          JCE STORE SYSTEM<small>Store setup release</small>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div>
            <span className="branch-icon" aria-hidden="true">
              ⌂
            </span>
            {session ? (
              <label>
                Branch{' '}
                <select
                  aria-label="Active branch"
                  value={session.branchId ?? ''}
                  onChange={(e) =>
                    act('/auth/branch', { branchId: e.target.value })
                  }
                  disabled={session.locked || session.mustChangePassword}
                >
                  <option value="" disabled>
                    Select branch
                  </option>
                  {session.branches.map((b) => (
                    <option value={b.id} key={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <span>Sign in to select a branch</span>
            )}
          </div>
          <span className="station">{label}</span>
          {session && (
            <div className="actions">
              <span>{session.user.displayName}</span>
              <button className="secondary" onClick={() => act('/auth/lock')}>
                Lock
              </button>
              <button onClick={() => act('/auth/logout')}>Sign out</button>
            </div>
          )}
        </header>
        <main id="main" tabIndex={-1} ref={main}>
          {(actionError || sessionError) && (
            <p role="alert">{actionError || sessionError?.message}</p>
          )}
          {session?.locked ? (
            <Locked />
          ) : session?.mustChangePassword ? (
            <PasswordChange />
          ) : (
            <Routes key={`${session?.user.id}:${session?.branchId}`}>
              <Route path="/" element={<Overview />} />
              <Route path="/login" element={<SignIn />} />
              <Route
                path="/password"
                element={session ? <PasswordChange /> : <SignIn />}
              />
              {managementNavigation.map((item) => (
                <Route
                  key={item.path}
                  path={item.path}
                  element={
                    <Protected
                      permission={item.permission}
                      requiredPermissions={item.requiredPermissions}
                      branch={item.branch}
                    >
                      {item.page}
                    </Protected>
                  }
                />
              ))}
              <Route
                path="/workstation"
                element={<Workstation label={label} onSave={setLabel} />}
              />
              {navigation
                .filter(
                  (item) =>
                    !managementNavigation.some((m) => m.path === item.path),
                )
                .map((item) => (
                  <Route
                    key={item.path}
                    path={item.path}
                    element={
                      <StatePanel title="Access unavailable">
                        Sign-in and permission setup are required before this
                        area is available.
                      </StatePanel>
                    }
                  />
                ))}
              <Route
                path="*"
                element={
                  <StatePanel title="Page not found">
                    Return to the <NavLink to="/">workspace overview</NavLink>.
                  </StatePanel>
                }
              />
            </Routes>
          )}
          <footer className="page-footer">
            <span>JCE Dry Goods Trading</span>
            <span>Accounts, catalog & inventory</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
