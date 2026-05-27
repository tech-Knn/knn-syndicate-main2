export default function HomePage() {
  return (
    <main style={{ maxWidth: 680, margin: '0 auto', padding: '4rem 1.5rem' }}>
      <h1 style={{ fontFamily: 'Georgia, serif', fontSize: '2rem', marginBottom: '1rem' }}>
        Articles
      </h1>
      <p style={{ color: '#555', lineHeight: 1.6 }}>
        Editorial content is served at <code>/a/&lt;slug&gt;</code>. Each page shows a short intro, a
        sponsored-results widget, and the full article.
      </p>
    </main>
  );
}
