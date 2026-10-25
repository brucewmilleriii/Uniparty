// Replaces fetch when the ingest script runs under test. The House Clerk has no new roll call
// (it answers 200 with an error document, as it really does), and STUB_DOWN lists hosts that answer 403.
const down = (process.env.STUB_DOWN ?? "").split(",").filter(Boolean);
globalThis.fetch = async (url) => {
  if (down.some((host) => String(url).includes(host))) return new Response("Forbidden", { status: 403 });
  return new Response('<xml>Error sanitizing file "roll.xml". Please try again.</xml>', { status: 200 });
};
