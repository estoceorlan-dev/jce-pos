import type { InputHTMLAttributes, ReactNode } from 'react';

export function StatePanel({
  title,
  children,
  error = false,
  action,
}: {
  title: string;
  children: ReactNode;
  error?: boolean;
  action?: ReactNode;
}) {
  return (
    <section
      className={`state-panel ${error ? 'error' : ''}`}
      role={error ? 'alert' : 'status'}
    >
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </section>
  );
}
export function TextField({
  label,
  error,
  id,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        {...props}
        id={id}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      {error && (
        <p className="field-error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}
export function DataTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: string[];
  rows: ReactNode[][];
}) {
  return (
    <div className="table-scroll">
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((row, index) => (
              <tr key={index}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>{cell}</td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={columns.length}>No records to display.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
