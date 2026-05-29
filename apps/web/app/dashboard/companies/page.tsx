import { redirect } from 'next/navigation';

// Companies moved into the Platform hub. Keep this stub so old bookmarks/links don't 404.
// force-dynamic → a real HTTP 307 (works on a hard navigation, no client JS needed).
export const dynamic = 'force-dynamic';

export default function CompaniesRedirect() {
  redirect('/dashboard/platform/companies');
}
