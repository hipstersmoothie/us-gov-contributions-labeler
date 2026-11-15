// Official portraits for the website. Run before `astro build`; photos aren't
// committed to the repo.
import { getCurrentLegislators } from "../lib/legislators.js";
import { fetchPhotos } from "../ingest/assignments.js";

await fetchPhotos(await getCurrentLegislators());
