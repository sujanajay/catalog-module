import { redirect } from "next/navigation";

// GET / (viewer): the catalog is the home page. IAP has already signed the person in.
export default function Page() {
  redirect("/catalog");
}
