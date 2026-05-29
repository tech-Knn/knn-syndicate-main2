import { redirect } from 'next/navigation';

// Domains moved into the Platform hub. Keep this stub so old bookmarks/links don't 404.
export default function DomainsRedirect() {
  redirect('/dashboard/platform/domains');
}
