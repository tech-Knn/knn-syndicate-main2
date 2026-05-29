import { redirect } from 'next/navigation';

// Companies moved into the Platform hub. Keep this stub so old bookmarks/links don't 404.
export default function CompaniesRedirect() {
  redirect('/dashboard/platform/companies');
}
