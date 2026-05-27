export default function ArticleNotFound() {
  return (
    <main style={{ maxWidth: 680, margin: '0 auto', padding: '5rem 1.5rem', color: '#1a1a1a' }}>
      <h1 style={{ fontFamily: 'Georgia, serif', fontSize: '1.8rem', marginBottom: '0.75rem' }}>
        Article not found
      </h1>
      <p style={{ color: '#666', lineHeight: 1.6 }}>This article doesn’t exist or is no longer available.</p>
    </main>
  );
}
