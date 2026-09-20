import { useEffect, useRef, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  canAccess,
  navigation,
  readinessSchema,
  versionSchema,
  type Permission,
} from '@jce/shared';
import { getJson } from '../api/client';
import { DataTable, StatePanel, TextField } from '../components/ui';

// No authenticated session exists in L1. Default deny; L3 supplies server grants.
const permissions: readonly Permission[] = [];
const stationSchema = z.object({
  label: z
    .string()
    .trim()
    .min(2, 'Enter at least 2 characters.')
    .max(40, 'Use 40 characters or fewer.'),
});
type StationForm = z.infer<typeof stationSchema>;

function Overview() {
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
        <span className="phase-tag">Foundation · L1</span>
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
          <strong>Awaiting setup</strong>
          <p>A branch will be assigned when account setup is available.</p>
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
              'After account setup',
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
          {navigation
            .filter((item) => canAccess(permissions, item.permission))
            .map((item) => (
              <NavLink key={item.path} to={item.path}>
                {item.label}
              </NavLink>
            ))}
        </nav>
        <div className="sidebar-note">
          <span className="local-dot" />
          Local installation<p>Designed for your branch network.</p>
        </div>
        <div className="sidebar-footer">
          JCE STORE SYSTEM<small>Foundation release</small>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div>
            <span className="branch-icon" aria-hidden="true">
              ⌂
            </span>
            <span>Branch not configured</span>
          </div>
          <span className="station">{label}</span>
        </header>
        <main id="main" tabIndex={-1} ref={main}>
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route
              path="/workstation"
              element={<Workstation label={label} onSave={setLabel} />}
            />
            {navigation.map((item) => (
              <Route
                key={item.path}
                path={item.path}
                element={
                  <StatePanel title="Access unavailable">
                    Sign-in and permission setup are required before this area
                    is available.
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
          <footer className="page-footer">
            <span>JCE Dry Goods Trading</span>
            <span>Local foundation · Store operations coming next</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
