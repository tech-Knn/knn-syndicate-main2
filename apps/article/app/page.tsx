export default function HomePage() {
  return (
    <main style={{ maxWidth: 680, margin: '0 auto', padding: '4rem 1.5rem' }}>
      <h1 style={{ fontSize: '2rem', marginBottom: '1rem' }}>Articles</h1>
      <p style={{ color: '#555' }}>
        Monetized article pages are served at <code>/a/&lt;slug&gt;</code>. Content generation and
        the AFS widget land in the article-engine phase.
      </p>
    </main>
  );
}
