import { currentUser } from "../../lib/user";

// Placeholder until spec 06 builds the batch list. Already checks the signed-in person (viewer).
export default async function CatalogPage() {
  await currentUser();
  return (
    <main>
      <h1>Catalog images</h1>
    </main>
  );
}
