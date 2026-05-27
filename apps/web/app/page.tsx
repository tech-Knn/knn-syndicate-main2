export default function HomePage() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '1rem',
        textAlign: 'center',
        padding: '2rem',
      }}
    >
      <span
        style={{
          fontFamily: 'monospace',
          letterSpacing: '0.4em',
          color: 'var(--muted)',
          fontSize: '0.8rem',
        }}
      >
        KNN SYNDICATE
      </span>
      <h1
        style={{
          fontFamily: 'Georgia, serif',
          fontStyle: 'italic',
          fontSize: 'clamp(2rem, 6vw, 4rem)',
          color: 'var(--cream)',
        }}
      >
        Search Arbitrage Platform
      </h1>
      <p style={{ color: 'var(--muted)', maxWidth: 520 }}>
        Dashboard, ad launcher, and admin console. The full experience lands in the dashboard
        phase.
      </p>
      <code style={{ color: 'var(--gold)', fontSize: '0.85rem' }}>v0.1.0 · scaffolding</code>
    </main>
  );
}
