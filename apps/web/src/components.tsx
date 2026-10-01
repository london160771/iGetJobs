export function PageHeader({ title, description }: { title: string; description: string }) {
  return <div className="page-header"><p className="eyebrow">YOUR WORKSPACE</p><h1>{title}</h1><p>{description}</p></div>;
}
export function EmptyState({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="empty-state">
    <div className="empty-icon" aria-hidden="true">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 5h16v14H4zM4 10h16M9 10v9" /></svg>
    </div><h2>{title}</h2><div className="empty-description">{children}</div>
  </section>;
}
